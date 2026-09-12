from pathlib import Path

path = Path('frontend/src/maintenance/migrateSavedMessagesToChannel.ts')
text = path.read_text()

helper = '''async function releasePreparedLeasesForUploadYield(
  prepared: PreparedForward[],
  leaseOwner: string,
): Promise<void> {
  for (const entry of prepared) {
    try {
      entry.leased = await api.claimMigrationItem({
        migrationId: entry.item.migration_id,
        itemId: entry.item.item_id,
        expectedVersion: entry.leased.version,
        leaseOwner,
        leaseSeconds: 1,
        operationId: entry.operation.operation_id,
        state: 'sending',
      });
    } catch (error) {
      if (!isConflict(error)) {
        console.warn(
          `[Migration] Failed to shorten yielded item lease item=${entry.item.item_id}`
            + ` detail=${errorDetailText(error)}`,
        );
      }
    }
  }
}

'''

marker = 'async function sendPreparedBatch(\n'
if 'async function releasePreparedLeasesForUploadYield(' not in text:
    if marker not in text:
        raise SystemExit('sendPreparedBatch marker not found')
    text = text.replace(marker, helper + marker, 1)

old = '          const isolated = await sendPreparedBatchIsolated(job, chunk);\n'
new = '''          let isolated: IsolatedForwardResult;
          try {
            isolated = await sendPreparedBatchIsolated(job, chunk);
          } catch (error) {
            if (error instanceof MigrationUploadActiveError) {
              await releasePreparedLeasesForUploadYield(chunk, control.runId);
            }
            throw error;
          }
'''
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit('sendPreparedBatchIsolated call marker not found')

path.write_text(text)
