from pathlib import Path

path = Path('frontend/src/maintenance/migrateSavedMessagesToChannel.ts')
text = path.read_text()

text = text.replace(
"""type MigrationTelegramHook = {
  forward(params: {
    accountId: number;
    sourceMessageId: number;
    targetChannelId: string;
    randomId: string;
  }): Promise<MigrationMediaResult>;
""",
"""type MigrationForwardBatchEntry = { sourceMessageId: number; randomId: string };

type MigrationTelegramHook = {
  forward(params: {
    accountId: number;
    sourceMessageId: number;
    targetChannelId: string;
    randomId: string;
  }): Promise<MigrationMediaResult>;
  forwardBatch?(params: {
    accountId: number;
    targetChannelId: string;
    entries: MigrationForwardBatchEntry[];
  }): Promise<MigrationMediaResult[]>;
""",
1,
)

text = text.replace(
"""const LEASE_SECONDS = 60;
const GROUP_PAGE_SIZE = 25;
""",
"""const LEASE_SECONDS = 300;
const GROUP_PAGE_SIZE = 25;
const FORWARD_BATCH_SIZE = 100;
""",
1,
)

start = text.index('async function productionForward(\n')
end = text.index('async function productionReadDestination(\n', start)
text = text[:start] + """async function productionForwardBatch(
  accountId: number,
  targetChannelId: string,
  entries: MigrationForwardBatchEntry[],
): Promise<MigrationMediaResult[]> {
  const manager = getClientFor(accountId);
  if (manager.offline) throw new Error(`Source account ${accountId} is offline`);
  const peer = await resolveChannelPeerForAccount(manager as any, targetChannelId);
  if (!peer) throw new Error(`Channel ${targetChannelId} is unavailable to source account ${accountId}`);
  const results = await manager.forwardBatchToTarget(
    'me',
    entries.map((entry) => ({ messageId: entry.sourceMessageId, randomId: entry.randomId })),
    peer,
  );
  return results.map((result) => ({
    messageId: result.messageId,
    mediaKind: result.mediaKind,
    mediaId: result.mediaId,
    size: result.size,
    photoVariant: result.photoVariant ?? null,
  }));
}

async function productionForward(
  accountId: number,
  sourceMessageId: number,
  targetChannelId: string,
  randomId: string,
): Promise<MigrationMediaResult> {
  return (await productionForwardBatch(accountId, targetChannelId, [{ sourceMessageId, randomId }]))[0];
}

""" + text[end:]

adapter_start = text.index('function telegramAdapter(): MigrationTelegramHook {\n')
adapter_end = text.index('\nfunction resultMapping(', adapter_start)
text = text[:adapter_start] + """type MigrationTelegramAdapter = MigrationTelegramHook & {
  forwardBatch(params: {
    accountId: number;
    targetChannelId: string;
    entries: MigrationForwardBatchEntry[];
  }): Promise<MigrationMediaResult[]>;
};

function telegramAdapter(): MigrationTelegramAdapter {
  const hook = testHook();
  if (hook) {
    return {
      ...hook,
      forwardBatch: hook.forwardBatch ?? (({ accountId, targetChannelId, entries }) =>
        Promise.all(entries.map((entry) => hook.forward({
          accountId,
          targetChannelId,
          sourceMessageId: entry.sourceMessageId,
          randomId: entry.randomId,
        })))),
    };
  }
  return {
    forward: ({ accountId, sourceMessageId, targetChannelId, randomId }) =>
      productionForward(accountId, sourceMessageId, targetChannelId, randomId),
    forwardBatch: ({ accountId, targetChannelId, entries }) =>
      productionForwardBatch(accountId, targetChannelId, entries),
    readDestination: ({ accountId, targetChannelId, messageId }) =>
      productionReadDestination(accountId, targetChannelId, messageId),
    readSource: ({ accountId, sourceMessageId }) => productionReadSource(accountId, sourceMessageId),
    verifyReader: ({ accountId, targetChannelId, messageId }) =>
      productionVerifyReader(accountId, targetChannelId, messageId),
  };
}
""" + text[adapter_end:]

persist_end = text.index('\nasync function recoverWithoutBlindSend(', text.index('async function persistResult('))
helpers = """
type PreparedForward = {
  item: StorageMigrationItem;
  leased: StorageMigrationItem;
  operation: TelegramOperation;
  sourceAccountId: number;
  sourceMessageId: number;
};

async function prepareFreshForward(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
  leaseOwner: string,
): Promise<PreparedForward> {
  let operation = await ensureOperation(job, item);
  const leased = await attachAndLease(item, operation, leaseOwner);
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
  return { item, leased, operation, sourceAccountId, sourceMessageId };
}

async function sendPreparedBatch(
  job: StorageMigrationJob,
  prepared: PreparedForward[],
): Promise<StorageMigrationItem[]> {
  if (prepared.length < 1 || prepared.length > FORWARD_BATCH_SIZE) {
    throw new Error(`Migration forward batch must contain 1-${FORWARD_BATCH_SIZE} items`);
  }
  const sourceAccountId = prepared[0].sourceAccountId;
  if (prepared.some((entry) => entry.sourceAccountId !== sourceAccountId)) {
    throw new Error('Migration forward batch may not mix source accounts');
  }
  const results = await telegramAdapter().forwardBatch({
    accountId: sourceAccountId,
    targetChannelId: job.target_channel_id,
    entries: prepared.map((entry) => ({
      sourceMessageId: entry.sourceMessageId,
      randomId: entry.operation.random_id,
    })),
  });
  if (results.length !== prepared.length) {
    throw new Error(`Migration forward result count mismatch: expected ${prepared.length}, got ${results.length}`);
  }

  const reconciled: StorageMigrationItem[] = [];
  for (let index = 0; index < prepared.length; index++) {
    const entry = prepared[index];
    const persisted = await persistResult(entry.operation, results[index]);
    if (persisted.result_version == null) throw new Error('Migration result is not durable');
    reconciled.push(await api.reconcileMigrationItem({
      migrationId: entry.item.migration_id,
      itemId: entry.item.item_id,
      expectedItemVersion: entry.leased.version,
      operationResultVersion: persisted.result_version,
    }));
  }
  return reconciled;
}
"""
text = text[:persist_end] + helpers + text[persist_end:]

run_start = text.index('export async function runMigrationJob(\n')
run_end = text.index('\nexport function resumeMigrationJob(', run_start)
new_run = """export async function runMigrationJob(
  jobId: string,
  onProgress?: (progress: MigrationRunProgress) => void,
): Promise<StorageMigrationJob> {
  let job = await api.getMigrationJob(jobId);
  if (job.dry_run || ['completed', 'rolled_back'].includes(job.state)) return job;

  const control: RunControl = { runId: `browser:${crypto.randomUUID()}`, pauseRequested: false };
  activeRuns.set(jobId, control);
  onProgress?.({ phase: 'running' });

  const claimWindow = async (): Promise<StorageMigrationGroup[]> => {
    const claimed: StorageMigrationGroup[] = [];
    let itemCount = 0;
    while (!control.pauseRequested && itemCount < FORWARD_BATCH_SIZE) {
      const page = await api.listMigrationGroups({
        migrationId: jobId,
        scope: 'runnable',
        limit: GROUP_PAGE_SIZE,
      });
      if (page.groups.length === 0) break;

      let claimedAny = false;
      for (const candidate of page.groups) {
        if (control.pauseRequested) break;
        if (claimed.length > 0 && itemCount + candidate.items.length > FORWARD_BATCH_SIZE) break;
        try {
          const result = await api.claimMigrationGroup({
            migrationId: jobId,
            groupId: candidate.group_id,
            expectedItemVersions: expectedVersions(candidate),
            leaseOwner: control.runId,
            leaseSeconds: LEASE_SECONDS,
          });
          claimed.push(result.group);
          itemCount += result.group.items.length;
          job = result.job;
          claimedAny = true;
          if (itemCount >= FORWARD_BATCH_SIZE) break;
        } catch (error) {
          if (!isConflict(error)) throw error;
          job = await api.getMigrationJob(jobId);
        }
      }
      if (!claimedAny) break;
    }
    return claimed;
  };

  try {
    while (!control.pauseRequested) {
      const claimedGroups = await claimWindow();
      if (claimedGroups.length === 0) break;

      const currentByItem = new Map<string, StorageMigrationItem>();
      const prepared: PreparedForward[] = [];

      for (const group of claimedGroups) {
        for (const item of group.items) {
          if (control.pauseRequested) break;
          onProgress?.({
            phase: 'running',
            currentGroupId: group.group_id,
            currentSourceAccount: sourceNumber(item, 'telegram_user_id'),
          });
          if (['planned', 'retryable'].includes(item.state)) {
            const entry = await prepareFreshForward(job, item, control.runId);
            prepared.push(entry);
            currentByItem.set(item.item_id, entry.leased);
          } else {
            currentByItem.set(item.item_id, await processItem(job, item, control.runId));
          }
        }
        if (control.pauseRequested) break;
      }
      if (control.pauseRequested) break;

      const bySource = new Map<number, PreparedForward[]>();
      for (const entry of prepared) {
        const bucket = bySource.get(entry.sourceAccountId) ?? [];
        bucket.push(entry);
        bySource.set(entry.sourceAccountId, bucket);
      }

      for (const entries of bySource.values()) {
        for (let offset = 0; offset < entries.length; offset += FORWARD_BATCH_SIZE) {
          if (control.pauseRequested) break;
          const chunk = entries.slice(offset, offset + FORWARD_BATCH_SIZE);
          const reconciled = await sendPreparedBatch(job, chunk);
          reconciled.forEach((item) => currentByItem.set(item.item_id, item));
        }
        if (control.pauseRequested) break;
      }
      if (control.pauseRequested) break;

      for (const group of claimedGroups) {
        for (const original of group.items) {
          let current = currentByItem.get(original.item_id) ?? original;
          if (['forwarded', 'pending_quorum', 'verified'].includes(current.state)) {
            current = await collectEvidence(job, current);
            currentByItem.set(current.item_id, current);
          }
        }
      }

      for (const group of claimedGroups) {
        const processed = group.items.map((item) => currentByItem.get(item.item_id) ?? item);
        if (processed.length > 0 && processed.every((item) => item.state === 'verified')) {
          job = await api.getMigrationJob(jobId);
          try {
            const result = await api.commitMigrationGroup({
              migrationId: jobId,
              groupId: group.group_id,
              expectedJobVersion: job.version,
              expectedItemVersions: Object.fromEntries(processed.map((item) => [item.item_id, item.version])),
            });
            job = result.job;
            result.group.items.forEach((item) => currentByItem.set(item.item_id, item));
          } catch (error) {
            if (!isConflict(error)) throw error;
            job = await api.getMigrationJob(jobId);
          }
        } else {
          // Re-lease incomplete groups after reconcile clears item leases. This
          // parks quorum/recovery work so the next bounded page can advance to
          // later groups instead of spinning on the same first 25 groups.
          try {
            const result = await api.claimMigrationGroup({
              migrationId: jobId,
              groupId: group.group_id,
              expectedItemVersions: Object.fromEntries(processed.map((item) => [item.item_id, item.version])),
              leaseOwner: control.runId,
              leaseSeconds: LEASE_SECONDS,
            });
            job = result.job;
            result.group.items.forEach((item) => currentByItem.set(item.item_id, item));
          } catch (error) {
            if (!isConflict(error)) throw error;
            job = await api.getMigrationJob(jobId);
          }
        }
      }
      if (job.state === 'completed') break;
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
"""
text = text[:run_start] + new_run + text[run_end:]

path.write_text(text)
