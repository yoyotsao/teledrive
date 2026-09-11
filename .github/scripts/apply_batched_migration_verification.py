from pathlib import Path

path = Path('frontend/src/maintenance/migrateSavedMessagesToChannel.ts')
text = path.read_text()

text = text.replace(
"""  readSource(params: {
    accountId: number;
    sourceMessageId: number;
  }): Promise<{ ok: boolean }>;
  verifyReader(params: {
    accountId: number;
    targetChannelId: string;
    messageId: number;
  }): Promise<MigrationMediaResult | null>;
""",
"""  readSource(params: {
    accountId: number;
    sourceMessageId: number;
  }): Promise<{ ok: boolean }>;
  readSourceBatch?(params: {
    accountId: number;
    sourceMessageIds: number[];
  }): Promise<Array<{ ok: boolean }>>;
  verifyReader(params: {
    accountId: number;
    targetChannelId: string;
    messageId: number;
  }): Promise<MigrationMediaResult | null>;
  verifyReaderBatch?(params: {
    accountId: number;
    targetChannelId: string;
    messageIds: number[];
  }): Promise<Array<MigrationMediaResult | null>>;
""",
1,
)

read_start = text.index('async function productionReadDestination(\n')
read_end = text.index('\ntype MigrationTelegramAdapter =', read_start)
new_reads = """function migrationMediaResult(message: any): MigrationMediaResult | null {
  const media = message?.media ? readMedia(message.media) : null;
  if (!message?.id || !media) return null;
  return {
    messageId: message.id,
    mediaKind: media.kind,
    mediaId: media.id,
    size: media.size,
    photoVariant: media.kind === 'photo' ? media.fullThumbSize : null,
  };
}

async function productionReadDestinationBatch(
  accountId: number,
  targetChannelId: string,
  messageIds: number[],
): Promise<Array<MigrationMediaResult | null>> {
  if (messageIds.length === 0) return [];
  const manager = getClientFor(accountId);
  if (manager.offline) return messageIds.map(() => null);
  const peer = await resolveChannelPeerForAccount(manager as any, targetChannelId);
  const raw = (manager as any).client;
  if (!peer || !raw) return messageIds.map(() => null);
  const messages = await raw.getMessages(peer, { ids: messageIds });
  const byId = new Map<number, any>();
  for (const message of messages ?? []) {
    if (message?.id != null) byId.set(Number(message.id), message);
  }
  return messageIds.map((messageId) => migrationMediaResult(byId.get(messageId)));
}

async function productionReadDestination(
  accountId: number,
  targetChannelId: string,
  messageId?: number | null,
): Promise<MigrationMediaResult | null> {
  if (!messageId) return null;
  return (await productionReadDestinationBatch(accountId, targetChannelId, [messageId]))[0];
}

async function productionReadSourceBatch(
  accountId: number,
  sourceMessageIds: number[],
): Promise<Array<{ ok: boolean }>> {
  if (sourceMessageIds.length === 0) return [];
  const manager = getClientFor(accountId);
  if (manager.offline) return sourceMessageIds.map(() => ({ ok: false }));
  const raw = (manager as any).client;
  if (!raw) return sourceMessageIds.map(() => ({ ok: false }));
  const messages = await raw.getMessages('me', { ids: sourceMessageIds });
  const byId = new Map<number, any>();
  for (const message of messages ?? []) {
    if (message?.id != null) byId.set(Number(message.id), message);
  }
  return sourceMessageIds.map((messageId) => {
    const message = byId.get(messageId);
    return { ok: Boolean(message?.media && readMedia(message.media)) };
  });
}

async function productionReadSource(accountId: number, sourceMessageId: number): Promise<{ ok: boolean }> {
  return (await productionReadSourceBatch(accountId, [sourceMessageId]))[0];
}

async function productionVerifyReaderBatch(
  accountId: number,
  targetChannelId: string,
  messageIds: number[],
): Promise<Array<MigrationMediaResult | null>> {
  if (messageIds.length === 0) return [];
  const manager = getClientFor(accountId);
  if (manager.offline) return messageIds.map(() => null);
  const verification = await validateChannelForAccount(manager as any, targetChannelId);
  if (!verification.can_read) return messageIds.map(() => null);
  return productionReadDestinationBatch(accountId, targetChannelId, messageIds);
}

async function productionVerifyReader(
  accountId: number,
  targetChannelId: string,
  messageId: number,
): Promise<MigrationMediaResult | null> {
  return (await productionVerifyReaderBatch(accountId, targetChannelId, [messageId]))[0];
}
"""
text = text[:read_start] + new_reads + text[read_end:]

adapter_start = text.index('type MigrationTelegramAdapter =')
adapter_end = text.index('\nfunction resultMapping(', adapter_start)
new_adapter = """type MigrationTelegramAdapter = MigrationTelegramHook & {
  forwardBatch(params: {
    accountId: number;
    targetChannelId: string;
    entries: MigrationForwardBatchEntry[];
  }): Promise<MigrationMediaResult[]>;
  readSourceBatch(params: {
    accountId: number;
    sourceMessageIds: number[];
  }): Promise<Array<{ ok: boolean }>>;
  verifyReaderBatch(params: {
    accountId: number;
    targetChannelId: string;
    messageIds: number[];
  }): Promise<Array<MigrationMediaResult | null>>;
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
      readSourceBatch: hook.readSourceBatch ?? (({ accountId, sourceMessageIds }) =>
        Promise.all(sourceMessageIds.map((sourceMessageId) => hook.readSource({
          accountId,
          sourceMessageId,
        })))),
      verifyReaderBatch: hook.verifyReaderBatch ?? (({ accountId, targetChannelId, messageIds }) =>
        Promise.all(messageIds.map((messageId) => hook.verifyReader({
          accountId,
          targetChannelId,
          messageId,
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
    readSourceBatch: ({ accountId, sourceMessageIds }) =>
      productionReadSourceBatch(accountId, sourceMessageIds),
    verifyReader: ({ accountId, targetChannelId, messageId }) =>
      productionVerifyReader(accountId, targetChannelId, messageId),
    verifyReaderBatch: ({ accountId, targetChannelId, messageIds }) =>
      productionVerifyReaderBatch(accountId, targetChannelId, messageIds),
  };
}
"""
text = text[:adapter_start] + new_adapter + text[adapter_end:]

collect_start = text.index('async function collectEvidence(')
collect_end = text.index('\nasync function processItem(', collect_start)
new_collect = """async function collectEvidenceBatch(
  job: StorageMigrationJob,
  items: StorageMigrationItem[],
): Promise<StorageMigrationItem[]> {
  if (items.length === 0) return [];
  const currentByItem = new Map(items.map((item) => [item.item_id, item]));
  const operations = new Map<string, TelegramOperation>();
  await Promise.all(items.map(async (item) => {
    if (!item.operation_id) return;
    const operation = await api.getTelegramOperation(item.operation_id);
    if (operation.result_version != null && operation.destination_message_id != null) {
      operations.set(item.item_id, operation);
    }
  }));

  const accounts = await api.listAccounts();
  const adapter = telegramAdapter();
  for (const account of accounts) {
    const candidates = items.flatMap((original) => {
      const current = currentByItem.get(original.item_id) ?? original;
      const operation = operations.get(original.item_id);
      if (!operation) return [];
      if (current.evidence.some((row) => row.telegram_user_id === account.telegram_user_id
        && row.result_version === operation.result_version)) return [];
      return [{ item: current, operation }];
    });
    if (candidates.length === 0) continue;

    const results = await adapter.verifyReaderBatch({
      accountId: account.telegram_user_id,
      targetChannelId: job.target_channel_id,
      messageIds: candidates.map(({ operation }) => operation.destination_message_id!),
    });
    if (results.length !== candidates.length) {
      throw new Error(`Migration verification result count mismatch: expected ${candidates.length}, got ${results.length}`);
    }

    const sourceCandidates = candidates.filter(({ item }) =>
      sourceNumber(item, 'telegram_user_id') === account.telegram_user_id);
    const sourceResults = sourceCandidates.length > 0
      ? await adapter.readSourceBatch({
        accountId: account.telegram_user_id,
        sourceMessageIds: sourceCandidates.map(({ item }) => sourceNumber(item, 'telegram_message_id')),
      })
      : [];
    if (sourceResults.length !== sourceCandidates.length) {
      throw new Error(`Migration source verification result count mismatch: expected ${sourceCandidates.length}, got ${sourceResults.length}`);
    }
    const sourceOk = new Map(sourceCandidates.map(({ item }, index) => [
      item.item_id,
      sourceResults[index]?.ok === true,
    ]));

    for (let index = 0; index < candidates.length; index++) {
      const { item: original, operation } = candidates[index];
      const result = results[index];
      if (!result || !sameMedia(result, operation)) continue;
      const current = currentByItem.get(original.item_id) ?? original;
      const updated = await api.putMigrationEvidence({
        migrationId: job.migration_id,
        itemId: current.item_id,
        telegramUserId: account.telegram_user_id,
        evidence: {
          expected_item_version: current.version,
          result_version: operation.result_version!,
          target_channel_id: job.target_channel_id,
          destination_message_id: operation.destination_message_id!,
          media_kind: operation.destination_media_kind as 'document' | 'photo',
          media_id: operation.destination_media_id!,
          size_bytes: operation.destination_size!,
          photo_variant: result.photoVariant ?? null,
          read_probe_ok: true,
          checked_at: new Date().toISOString(),
          source_read_probe_ok: sourceOk.get(current.item_id) ?? false,
        },
      });
      currentByItem.set(updated.item_id, updated);
    }
  }

  return items.map((item) => currentByItem.get(item.item_id) ?? item);
}

async function collectEvidence(job: StorageMigrationJob, item: StorageMigrationItem): Promise<StorageMigrationItem> {
  return (await collectEvidenceBatch(job, [item]))[0];
}
"""
text = text[:collect_start] + new_collect + text[collect_end:]

old_process_tail = """  if (['forwarded', 'pending_quorum', 'verified'].includes(current.state)) {
    current = await collectEvidence(job, current);
  }
  return current;
}
"""
new_process_tail = """  return current;
}
"""
if old_process_tail not in text:
    raise SystemExit('processItem evidence tail marker not found')
text = text.replace(old_process_tail, new_process_tail, 1)

old_run_evidence = """      for (const group of claimedGroups) {
        for (const original of group.items) {
          let current = currentByItem.get(original.item_id) ?? original;
          if (['forwarded', 'pending_quorum', 'verified'].includes(current.state)) {
            current = await collectEvidence(job, current);
            currentByItem.set(current.item_id, current);
          }
        }
      }
"""
new_run_evidence = """      const evidenceCandidates = claimedGroups
        .flatMap((group) => group.items.map((item) => currentByItem.get(item.item_id) ?? item))
        .filter((item) => ['forwarded', 'pending_quorum', 'verified'].includes(item.state));
      const evidenced = await collectEvidenceBatch(job, evidenceCandidates);
      evidenced.forEach((item) => currentByItem.set(item.item_id, item));
"""
if old_run_evidence not in text:
    raise SystemExit('run evidence loop marker not found')
text = text.replace(old_run_evidence, new_run_evidence, 1)

path.write_text(text)
