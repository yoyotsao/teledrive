from pathlib import Path

path = Path('frontend/tests/isolated/storage-migration.spec.ts')
text = path.read_text()

old_type = '''type MigrationJob = {
  migration_id: string;
  state: string;
  version: number;
  dry_run: boolean;
  target_channel_id: string;
  target_version: number;
  accounts_version: number;
  target_snapshot: Record<string, any>;
  items: MigrationItem[];
};
'''
new_type = '''type MigrationJob = {
  migration_id: string;
  state: string;
  version: number;
  dry_run: boolean;
  target_channel_id: string;
  target_version: number;
  accounts_version: number;
  target_snapshot: Record<string, any>;
  total_items: number;
  total_groups: number;
  item_counts: Record<string, number>;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  items: MigrationItem[];
};
'''
if old_type not in text:
    raise SystemExit('MigrationJob type marker not found')
text = text.replace(old_type, new_type, 1)

start = text.index('function makeJob(')
end = text.index('\nasync function installMigrationTelegramHook', start)
new_make_job = '''function itemCounts(items: MigrationItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  return counts;
}

function refreshJobSummary(job: MigrationJob): MigrationJob {
  job.total_items = job.items.length;
  job.total_groups = new Set(job.items.map(item => item.group_id)).size;
  job.item_counts = itemCounts(job.items);
  job.updated_at = new Date().toISOString();
  return job;
}

function makeJob(overrides: Partial<MigrationJob> = {}): MigrationJob {
  const migrationId = overrides.migration_id ?? 'migration-1';
  const items = overrides.items ?? [{
    migration_id: migrationId,
    item_id: 'item-1',
    file_id: 'saved-file',
    group_id: 'saved-file',
    part_index: null,
    state: 'planned',
    version: 1,
    source_location: sourceLocation(),
    expected_location_version: 0,
    operation_id: null,
    operation_result_version: null,
    applied_location_version: null,
    evidence: [],
  }];
  const now = new Date().toISOString();
  const job: MigrationJob = {
    migration_id: migrationId,
    state: 'running',
    version: 1,
    dry_run: false,
    target_channel_id: '123456789',
    target_version: 3,
    accounts_version: 2,
    target_snapshot: { storage_mode: 'channel', channel_id: '123456789', version: 3, accounts_version: 2 },
    total_items: items.length,
    total_groups: new Set(items.map(item => item.group_id)).size,
    item_counts: itemCounts(items),
    next_retry_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
    items,
  };
  return refreshJobSummary(job);
}
'''
text = text[:start] + new_make_job + text[end:]

old_get = '''      const getJob = path.match(/^\\/storage-migrations\\/([^/]+)$/);
      if (getJob && method === 'GET') {
        const job = jobs.get(getJob[1]);
        return job ? json(job) : json({ detail: 'not found' }, 404);
      }

      const patchItem = path.match(/^\\/storage-migrations\\/([^/]+)\\/items\\/([^/]+)$/);
'''
new_get = '''      const getJob = path.match(/^\\/storage-migrations\\/([^/]+)$/);
      if (getJob && method === 'GET') {
        const job = jobs.get(getJob[1]);
        return job ? json(refreshJobSummary(job)) : json({ detail: 'not found' }, 404);
      }

      const listGroups = path.match(/^\\/storage-migrations\\/([^/]+)\\/groups$/);
      if (listGroups && method === 'GET') {
        const job = jobs.get(listGroups[1])!;
        const scope = url.searchParams.get('scope') ?? 'runnable';
        const eligible = job.items.filter(item => scope === 'applied'
          ? item.state === 'applied'
          : !['applied', 'rolled_back', 'blocked', 'failed'].includes(item.state));
        const groupIds = [...new Set(eligible.map(item => item.group_id))];
        return json({
          groups: groupIds.map(groupId => ({
            group_id: groupId,
            items: eligible.filter(item => item.group_id === groupId),
          })),
          next_after: null,
        });
      }

      const claimGroup = path.match(/^\\/storage-migrations\\/([^/]+)\\/groups\\/([^/]+)\\/claim$/);
      if (claimGroup && method === 'POST') {
        const job = jobs.get(claimGroup[1])!;
        const items = job.items.filter(item => item.group_id === claimGroup[2]);
        return json({ group: { group_id: claimGroup[2], items }, job: refreshJobSummary(job) });
      }

      const patchItem = path.match(/^\\/storage-migrations\\/([^/]+)\\/items\\/([^/]+)$/);
'''
if old_get not in text:
    raise SystemExit('getJob handler marker not found')
text = text.replace(old_get, new_get, 1)

old_commit = '''      const commit = path.match(/^\\/storage-migrations\\/([^/]+)\\/groups\\/([^/]+)\\/commit$/);
      if (commit && method === 'POST') {
        const job = jobs.get(commit[1])!;
        job.version += 1;
        for (const item of job.items.filter(row => row.group_id === commit[2])) {
          item.state = 'applied';
          item.version += 1;
          item.applied_location_version = item.expected_location_version + 1;
        }
        job.state = job.items.every(item => item.state === 'applied') ? 'completed' : 'running';
        return json(job);
      }

      const rollback = path.match(/^\\/storage-migrations\\/([^/]+)\\/groups\\/([^/]+)\\/rollback$/);
      if (rollback && method === 'POST') {
        const job = jobs.get(rollback[1])!;
        job.version += 1;
        for (const item of job.items.filter(row => row.group_id === rollback[2])) {
          item.state = 'rolled_back';
          item.version += 1;
        }
        return json(job);
      }
'''
new_commit = '''      const commit = path.match(/^\\/storage-migrations\\/([^/]+)\\/groups\\/([^/]+)\\/commit$/);
      if (commit && method === 'POST') {
        const job = jobs.get(commit[1])!;
        job.version += 1;
        const items = job.items.filter(row => row.group_id === commit[2]);
        for (const item of items) {
          item.state = 'applied';
          item.version += 1;
          item.applied_location_version = item.expected_location_version + 1;
        }
        job.state = job.items.every(item => item.state === 'applied') ? 'completed' : 'running';
        refreshJobSummary(job);
        return json({ group: { group_id: commit[2], items }, job });
      }

      const rollback = path.match(/^\\/storage-migrations\\/([^/]+)\\/groups\\/([^/]+)\\/rollback$/);
      if (rollback && method === 'POST') {
        const job = jobs.get(rollback[1])!;
        job.version += 1;
        const items = job.items.filter(row => row.group_id === rollback[2]);
        for (const item of items) {
          item.state = 'rolled_back';
          item.version += 1;
        }
        job.state = job.items.every(item => item.state === 'rolled_back') ? 'rolled_back' : job.state;
        refreshJobSummary(job);
        return json({ group: { group_id: rollback[2], items }, job });
      }
'''
if old_commit not in text:
    raise SystemExit('commit/rollback handler marker not found')
text = text.replace(old_commit, new_commit, 1)

path.write_text(text)
