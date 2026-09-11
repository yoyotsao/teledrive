import {
  api,
  type StorageMigrationGroup,
  type StorageMigrationItem,
  type StorageMigrationJob,
  type TelegramOperation,
} from '../api/client.ts';
import { getClientFor } from '../lib/gramjs.ts';
import { readMedia } from '../lib/telegramMedia.ts';
import { resolveChannelPeerForAccount, validateChannelForAccount } from '../lib/channelStorage.ts';
import { RecoveryCursorStore } from '../lib/telegramOperationRecovery.ts';

type MigrationMediaResult = {
  messageId: number;
  mediaKind: 'document' | 'photo';
  mediaId: string;
  size: number;
  photoVariant?: string | null;
};

type MigrationTelegramHook = {
  forward(params: {
    accountId: number;
    sourceMessageId: number;
    targetChannelId: string;
    randomId: string;
  }): Promise<MigrationMediaResult>;
  readDestination(params: {
    accountId: number;
    targetChannelId: string;
    randomId: string;
    messageId?: number | null;
  }): Promise<MigrationMediaResult | null>;
  readSource(params: {
    accountId: number;
    sourceMessageId: number;
  }): Promise<{ ok: boolean }>;
  verifyReader(params: {
    accountId: number;
    targetChannelId: string;
    messageId: number;
  }): Promise<MigrationMediaResult | null>;
};

export type MigrationRunProgress = {
  phase: 'running' | 'paused' | 'idle';
  currentGroupId?: string;
  currentSourceAccount?: number;
  lastError?: string;
};

type RunControl = {
  runId: string;
  pauseRequested: boolean;
};

declare global {
  interface Window {
    __TELEDRIVE_MIGRATION_TELEGRAM__?: MigrationTelegramHook;
  }
}

const LEASE_SECONDS = 60;
const GROUP_PAGE_SIZE = 25;
const activeRuns = new Map<string, RunControl>();

function isConflict(error: unknown): boolean {
  return Number((error as any)?.response?.status) === 409;
}

function sourceNumber(item: StorageMigrationItem, key: string): number {
  const value = item.source_location[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Migration item ${item.item_id} is missing numeric ${key}`);
  }
  return value;
}

function generateRandomId(): string {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  const value = ((BigInt(words[0] & 0x7fffffff) << 32n) | BigInt(words[1])) || 1n;
  return value.toString();
}

function generateOperationId(item: StorageMigrationItem): string {
  return `migration:${item.migration_id}:${item.item_id}:${crypto.randomUUID()}`;
}

function testHook(): MigrationTelegramHook | null {
  if (import.meta.env.VITE_E2E_TEST_HOOKS !== '1') return null;
  return window.__TELEDRIVE_MIGRATION_TELEGRAM__ ?? null;
}

async function productionForward(
  accountId: number,
  sourceMessageId: number,
  targetChannelId: string,
  randomId: string,
): Promise<MigrationMediaResult> {
  const manager = getClientFor(accountId);
  if (manager.offline) throw new Error(`Source account ${accountId} is offline`);
  const peer = await resolveChannelPeerForAccount(manager as any, targetChannelId);
  if (!peer) throw new Error(`Channel ${targetChannelId} is unavailable to source account ${accountId}`);
  const result = await manager.forwardToTarget('me', sourceMessageId, peer, randomId);
  return {
    messageId: result.messageId,
    mediaKind: result.mediaKind,
    mediaId: result.mediaId,
    size: result.size,
    photoVariant: result.photoVariant ?? null,
  };
}

async function productionReadDestination(
  accountId: number,
  targetChannelId: string,
  messageId?: number | null,
): Promise<MigrationMediaResult | null> {
  if (!messageId) return null;
  const manager = getClientFor(accountId);
  if (manager.offline) return null;
  const peer = await resolveChannelPeerForAccount(manager as any, targetChannelId);
  const raw = (manager as any).client;
  if (!peer || !raw) return null;
  const messages = await raw.getMessages(peer, { ids: [messageId] });
  const message = messages?.[0];
  const media = message?.media ? readMedia(message.media) : null;
  if (!media) return null;
  return {
    messageId: message.id,
    mediaKind: media.kind,
    mediaId: media.id,
    size: media.size,
    photoVariant: media.kind === 'photo' ? media.fullThumbSize : null,
  };
}

async function productionReadSource(accountId: number, sourceMessageId: number): Promise<{ ok: boolean }> {
  const manager = getClientFor(accountId);
  if (manager.offline) return { ok: false };
  const raw = (manager as any).client;
  if (!raw) return { ok: false };
  const messages = await raw.getMessages('me', { ids: [sourceMessageId] });
  return { ok: Boolean(messages?.[0]?.media && readMedia(messages[0].media)) };
}

async function productionVerifyReader(
  accountId: number,
  targetChannelId: string,
  messageId: number,
): Promise<MigrationMediaResult | null> {
  const manager = getClientFor(accountId);
  if (manager.offline) return null;
  const verification = await validateChannelForAccount(manager as any, targetChannelId);
  if (!verification.can_read) return null;
  return productionReadDestination(accountId, targetChannelId, messageId);
}

function telegramAdapter(): MigrationTelegramHook {
  const hook = testHook();
  if (hook) return hook;
  return {
    forward: ({ accountId, sourceMessageId, targetChannelId, randomId }) =>
      productionForward(accountId, sourceMessageId, targetChannelId, randomId),
    readDestination: ({ accountId, targetChannelId, messageId }) =>
      productionReadDestination(accountId, targetChannelId, messageId),
    readSource: ({ accountId, sourceMessageId }) => productionReadSource(accountId, sourceMessageId),
    verifyReader: ({ accountId, targetChannelId, messageId }) =>
      productionVerifyReader(accountId, targetChannelId, messageId),
  };
}

function resultMapping(operation: TelegramOperation, result: MigrationMediaResult) {
  return {
    mapping: {
      uploader_id: operation.uploader_id,
      random_id: operation.random_id,
      target_peer_key: operation.target_peer_key,
      destination_message_id: result.messageId,
    },
    mediaIdentity: {
      destination_media_kind: result.mediaKind,
      destination_media_id: result.mediaId,
      destination_size: result.size,
      ...(result.photoVariant ? { destination_photo_variant: result.photoVariant } : {}),
    },
  };
}

async function ensureOperation(job: StorageMigrationJob, item: StorageMigrationItem): Promise<TelegramOperation> {
  if (item.operation_id) return api.getTelegramOperation(item.operation_id);
  const sourceAccountId = sourceNumber(item, 'telegram_user_id');
  return api.createTelegramOperation({
    operation_id: generateOperationId(item),
    kind: 'migration',
    logical_file_id: item.file_id,
    group_id: item.group_id,
    part_index: item.part_index ?? null,
    uploader_id: sourceAccountId,
    target_kind: 'channel',
    target_channel_id: job.target_channel_id,
    target_peer_key: job.target_channel_id,
    created_target_version: job.target_version,
    created_accounts_version: job.accounts_version,
    random_id: generateRandomId(),
    rpc_kind: 'messages.forwardMessages',
    request_metadata: { source: item.source_location },
  });
}

async function markOperationSending(operation: TelegramOperation): Promise<TelegramOperation> {
  if (operation.state === 'planned' || operation.state === 'retryable') {
    return api.patchTelegramOperation(operation.operation_id, {
      expected_operation_version: operation.version,
      state: 'sending',
    });
  }
  return operation;
}

async function attachAndLease(
  item: StorageMigrationItem,
  operation: TelegramOperation,
  leaseOwner: string,
  requestedState?: string,
): Promise<StorageMigrationItem> {
  return api.claimMigrationItem({
    migrationId: item.migration_id,
    itemId: item.item_id,
    expectedVersion: item.version,
    leaseOwner,
    leaseSeconds: LEASE_SECONDS,
    operationId: operation.operation_id,
    state: requestedState,
  });
}

async function persistResult(operation: TelegramOperation, result: MigrationMediaResult): Promise<TelegramOperation> {
  const { mapping, mediaIdentity } = resultMapping(operation, result);
  return api.persistReconciledOperationResult({
    operationId: operation.operation_id,
    expectedOperationVersion: operation.version,
    mapping,
    mediaIdentity,
  });
}

async function recoverWithoutBlindSend(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
  operation: TelegramOperation,
): Promise<StorageMigrationItem> {
  const result = await telegramAdapter().readDestination({
    accountId: operation.uploader_id,
    targetChannelId: job.target_channel_id,
    randomId: operation.random_id,
    messageId: operation.destination_message_id,
  });
  if (!result) return item;
  const persisted = await persistResult(operation, result);
  if (persisted.result_version == null) throw new Error('Recovered migration result is not durable');
  return api.reconcileMigrationItem({
    migrationId: item.migration_id,
    itemId: item.item_id,
    expectedItemVersion: item.version,
    operationResultVersion: persisted.result_version,
  });
}

async function forwardItem(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
  leaseOwner: string,
): Promise<StorageMigrationItem> {
  let operation = await ensureOperation(job, item);
  let leased = item;
  if (!item.operation_id || !['sending', 'recovering'].includes(item.state)) {
    leased = await attachAndLease(item, operation, leaseOwner);
  }
  operation = await markOperationSending(operation);

  const sourceAccountId = sourceNumber(item, 'telegram_user_id');
  const sourceMessageId = sourceNumber(item, 'telegram_message_id');
  await new RecoveryCursorStore().save({
    ownerId: sourceAccountId,
    operationId: operation.operation_id,
    randomId: operation.random_id,
    uploaderId: sourceAccountId,
    targetPeerKey: job.target_channel_id,
    phase: 'rpc_started',
  });

  const result = await telegramAdapter().forward({
    accountId: sourceAccountId,
    sourceMessageId,
    targetChannelId: job.target_channel_id,
    randomId: operation.random_id,
  });
  const persisted = await persistResult(operation, result);
  if (persisted.result_version == null) throw new Error('Migration result is not durable');
  return api.reconcileMigrationItem({
    migrationId: item.migration_id,
    itemId: item.item_id,
    expectedItemVersion: leased.version,
    operationResultVersion: persisted.result_version,
  });
}

function sameMedia(result: MigrationMediaResult, operation: TelegramOperation): boolean {
  return result.messageId === operation.destination_message_id
    && result.mediaKind === operation.destination_media_kind
    && result.mediaId === operation.destination_media_id
    && result.size === operation.destination_size
    && (result.photoVariant ?? null) === (operation.destination_photo_variant ?? null);
}

async function collectEvidence(job: StorageMigrationJob, item: StorageMigrationItem): Promise<StorageMigrationItem> {
  if (!item.operation_id) return item;
  const operation = await api.getTelegramOperation(item.operation_id);
  if (operation.result_version == null || operation.destination_message_id == null) return item;
  const accounts = await api.listAccounts();
  const adapter = telegramAdapter();
  let current = item;

  for (const account of accounts) {
    if (current.evidence.some(row => row.telegram_user_id === account.telegram_user_id
      && row.result_version === operation.result_version)) continue;
    const result = await adapter.verifyReader({
      accountId: account.telegram_user_id,
      targetChannelId: job.target_channel_id,
      messageId: operation.destination_message_id,
    });
    if (!result || !sameMedia(result, operation)) continue;
    const sourceAccount = sourceNumber(item, 'telegram_user_id');
    const sourceProbe = account.telegram_user_id === sourceAccount
      ? await adapter.readSource({ accountId: sourceAccount, sourceMessageId: sourceNumber(item, 'telegram_message_id') })
      : { ok: false };
    current = await api.putMigrationEvidence({
      migrationId: job.migration_id,
      itemId: item.item_id,
      telegramUserId: account.telegram_user_id,
      evidence: {
        expected_item_version: current.version,
        result_version: operation.result_version,
        target_channel_id: job.target_channel_id,
        destination_message_id: operation.destination_message_id,
        media_kind: operation.destination_media_kind as 'document' | 'photo',
        media_id: operation.destination_media_id!,
        size_bytes: operation.destination_size!,
        photo_variant: result.photoVariant ?? null,
        read_probe_ok: true,
        checked_at: new Date().toISOString(),
        source_read_probe_ok: sourceProbe.ok,
      },
    });
  }
  return current;
}

async function processItem(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
  leaseOwner: string,
): Promise<StorageMigrationItem> {
  if (['applied', 'rolled_back', 'blocked', 'failed'].includes(item.state)) return item;
  let current = item;
  if (item.state === 'uncertain') {
    if (!item.operation_id) return item;
    current = await recoverWithoutBlindSend(job, item, await api.getTelegramOperation(item.operation_id));
    if (current.state === 'uncertain') return current;
  } else if (['planned', 'retryable'].includes(item.state)) {
    current = await forwardItem(job, item, leaseOwner);
  } else if (['sending', 'recovering'].includes(item.state)) {
    if (!item.operation_id) return item;
    const operation = await api.getTelegramOperation(item.operation_id);
    current = await recoverWithoutBlindSend(job, item, operation);
    if (current.state === item.state) {
      // Sending/recovering may safely replay the same persisted random id only.
      current = await forwardItem(job, item, leaseOwner);
    }
  }
  if (['forwarded', 'pending_quorum', 'verified'].includes(current.state)) {
    current = await collectEvidence(job, current);
  }
  return current;
}

function expectedVersions(group: StorageMigrationGroup): Record<string, number> {
  return Object.fromEntries(group.items.map(item => [item.item_id, item.version]));
}

export function pauseMigrationJob(jobId: string): void {
  const control = activeRuns.get(jobId);
  if (control) control.pauseRequested = true;
}

export async function runMigrationJob(
  jobId: string,
  onProgress?: (progress: MigrationRunProgress) => void,
): Promise<StorageMigrationJob> {
  let job = await api.getMigrationJob(jobId);
  if (job.dry_run || ['completed', 'rolled_back'].includes(job.state)) return job;

  const control: RunControl = { runId: `browser:${crypto.randomUUID()}`, pauseRequested: false };
  activeRuns.set(jobId, control);
  onProgress?.({ phase: 'running' });

  try {
    while (!control.pauseRequested) {
      const page = await api.listMigrationGroups({
        migrationId: jobId,
        scope: 'runnable',
        limit: GROUP_PAGE_SIZE,
      });
      if (page.groups.length === 0) break;

      let claimed: StorageMigrationGroup | null = null;
      for (const candidate of page.groups) {
        if (control.pauseRequested) break;
        try {
          const result = await api.claimMigrationGroup({
            migrationId: jobId,
            groupId: candidate.group_id,
            expectedItemVersions: expectedVersions(candidate),
            leaseOwner: control.runId,
            leaseSeconds: LEASE_SECONDS,
          });
          claimed = result.group;
          job = result.job;
          break;
        } catch (error) {
          if (!isConflict(error)) throw error;
          job = await api.getMigrationJob(jobId);
        }
      }
      if (!claimed) break;

      onProgress?.({ phase: 'running', currentGroupId: claimed.group_id });
      const processed: StorageMigrationItem[] = [];
      for (const item of claimed.items) {
        if (control.pauseRequested) break;
        onProgress?.({
          phase: 'running',
          currentGroupId: claimed.group_id,
          currentSourceAccount: sourceNumber(item, 'telegram_user_id'),
        });
        processed.push(await processItem(job, item, control.runId));
      }

      if (control.pauseRequested) break;
      if (processed.length !== claimed.items.length) break;

      // Item/evidence mutations each bump the job version. Refresh only the bounded
      // summary before commit; never hydrate the entire manifest.
      job = await api.getMigrationJob(jobId);
      if (processed.length > 0 && processed.every(item => item.state === 'verified')) {
        try {
          const result = await api.commitMigrationGroup({
            migrationId: jobId,
            groupId: claimed.group_id,
            expectedJobVersion: job.version,
            expectedItemVersions: Object.fromEntries(processed.map(item => [item.item_id, item.version])),
          });
          job = result.job;
          if (job.state === 'completed') break;
        } catch (error) {
          if (!isConflict(error)) throw error;
          job = await api.getMigrationJob(jobId);
        }
      } else {
        // This group is waiting on quorum/recovery/retry. Its active lease keeps
        // it out of the next runnable page; do not spin on it in this browser run.
        break;
      }
    }
    job = await api.getMigrationJob(jobId);
    if (control.pauseRequested) onProgress?.({ phase: 'paused' });
    else onProgress?.({ phase: 'idle' });
    return job;
  } catch (error) {
    onProgress?.({
      phase: control.pauseRequested ? 'paused' : 'idle',
      lastError: (error as any)?.response?.data?.detail ?? (error as Error)?.message ?? String(error),
    });
    if (isConflict(error)) return api.getMigrationJob(jobId);
    throw error;
  } finally {
    if (activeRuns.get(jobId) === control) activeRuns.delete(jobId);
  }
}

export function resumeMigrationJob(
  jobId: string,
  onProgress?: (progress: MigrationRunProgress) => void,
): Promise<StorageMigrationJob> {
  return runMigrationJob(jobId, onProgress);
}

async function refreshRollbackEvidence(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
): Promise<StorageMigrationItem> {
  if (!item.operation_id) throw new Error(`Applied migration item ${item.item_id} has no operation`);
  const operation = await api.getTelegramOperation(item.operation_id);
  if (operation.result_version == null || operation.destination_message_id == null) {
    throw new Error(`Applied migration item ${item.item_id} has no durable result`);
  }
  const sourceAccount = sourceNumber(item, 'telegram_user_id');
  const adapter = telegramAdapter();
  const destination = await adapter.verifyReader({
    accountId: sourceAccount,
    targetChannelId: job.target_channel_id,
    messageId: operation.destination_message_id,
  });
  const source = await adapter.readSource({
    accountId: sourceAccount,
    sourceMessageId: sourceNumber(item, 'telegram_message_id'),
  });
  if (!destination || !sameMedia(destination, operation) || !source.ok) {
    throw new Error(`Rollback source verification failed for ${item.item_id}`);
  }
  return api.putMigrationEvidence({
    migrationId: job.migration_id,
    itemId: item.item_id,
    telegramUserId: sourceAccount,
    evidence: {
      expected_item_version: item.version,
      result_version: operation.result_version,
      target_channel_id: job.target_channel_id,
      destination_message_id: operation.destination_message_id,
      media_kind: operation.destination_media_kind as 'document' | 'photo',
      media_id: operation.destination_media_id!,
      size_bytes: operation.destination_size!,
      photo_variant: destination.photoVariant ?? null,
      read_probe_ok: true,
      checked_at: new Date().toISOString(),
      source_read_probe_ok: true,
    },
  });
}

export async function rollbackMigrationJob(
  jobId: string,
  onProgress?: (progress: MigrationRunProgress) => void,
): Promise<StorageMigrationJob> {
  let job = await api.getMigrationJob(jobId);
  let after: string | undefined;
  onProgress?.({ phase: 'running' });
  try {
    while (true) {
      const page = await api.listMigrationGroups({
        migrationId: jobId,
        scope: 'applied',
        limit: GROUP_PAGE_SIZE,
        after,
      });
      if (page.groups.length === 0) break;
      for (const group of page.groups) {
        onProgress?.({ phase: 'running', currentGroupId: group.group_id });
        const verified: StorageMigrationItem[] = [];
        for (const item of group.items) verified.push(await refreshRollbackEvidence(job, item));
        const result = await api.rollbackMigrationGroup({
          migrationId: jobId,
          groupId: group.group_id,
          expectedLocationVersions: Object.fromEntries(verified.map(item => [
            item.item_id,
            item.applied_location_version ?? item.expected_location_version + 1,
          ])),
        });
        job = result.job;
      }
      if (!page.next_after) break;
      after = page.next_after;
    }
    onProgress?.({ phase: 'idle' });
    return await api.getMigrationJob(jobId);
  } catch (error) {
    onProgress?.({ phase: 'idle', lastError: (error as Error)?.message ?? String(error) });
    if (isConflict(error)) return api.getMigrationJob(jobId);
    throw error;
  }
}
