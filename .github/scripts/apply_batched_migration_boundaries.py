from pathlib import Path

path = Path('frontend/src/maintenance/migrateSavedMessagesToChannel.ts')
text = path.read_text()

old_results = """    const results = await adapter.verifyReaderBatch({
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
"""
new_results = """    const results: Array<MigrationMediaResult | null> = [];
    for (let offset = 0; offset < candidates.length; offset += FORWARD_BATCH_SIZE) {
      const chunk = candidates.slice(offset, offset + FORWARD_BATCH_SIZE);
      const chunkResults = await adapter.verifyReaderBatch({
        accountId: account.telegram_user_id,
        targetChannelId: job.target_channel_id,
        messageIds: chunk.map(({ operation }) => operation.destination_message_id!),
      });
      if (chunkResults.length !== chunk.length) {
        throw new Error(`Migration verification result count mismatch: expected ${chunk.length}, got ${chunkResults.length}`);
      }
      results.push(...chunkResults);
    }

    const sourceCandidates = candidates.filter(({ item }) =>
      sourceNumber(item, 'telegram_user_id') === account.telegram_user_id);
    const sourceResults: Array<{ ok: boolean }> = [];
    for (let offset = 0; offset < sourceCandidates.length; offset += FORWARD_BATCH_SIZE) {
      const chunk = sourceCandidates.slice(offset, offset + FORWARD_BATCH_SIZE);
      const chunkResults = await adapter.readSourceBatch({
        accountId: account.telegram_user_id,
        sourceMessageIds: chunk.map(({ item }) => sourceNumber(item, 'telegram_message_id')),
      });
      if (chunkResults.length !== chunk.length) {
        throw new Error(`Migration source verification result count mismatch: expected ${chunk.length}, got ${chunkResults.length}`);
      }
      sourceResults.push(...chunkResults);
    }
"""
if old_results not in text:
    raise SystemExit('verification batch marker not found')
text = text.replace(old_results, new_results, 1)

old_finalization = """      const evidenced = await collectEvidenceBatch(job, evidenceCandidates);
      evidenced.forEach((item) => currentByItem.set(item.item_id, item));

      for (const group of claimedGroups) {
        const processed = group.items.map((item) => currentByItem.get(item.item_id) ?? item);
        if (processed.length > 0 && processed.every((item) => item.state === 'verified')) {
          job = await api.getMigrationJob(jobId);
          try {
"""
new_finalization = """      const evidenced = await collectEvidenceBatch(job, evidenceCandidates);
      evidenced.forEach((item) => currentByItem.set(item.item_id, item));

      // Evidence writes bump the job version. Refresh the bounded summary once
      // for this whole window, then carry forward the job returned by each
      // commit/claim instead of issuing one GET per group.
      job = await api.getMigrationJob(jobId);
      for (const group of claimedGroups) {
        const processed = group.items.map((item) => currentByItem.get(item.item_id) ?? item);
        if (processed.length > 0 && processed.every((item) => item.state === 'verified')) {
          try {
"""
if old_finalization not in text:
    raise SystemExit('group finalization marker not found')
text = text.replace(old_finalization, new_finalization, 1)

path.write_text(text)
