from pathlib import Path

path = Path('frontend/tests/isolated/storage-migration.spec.ts')
text = path.read_text()

old = '''  const jobs = new Map(initialJobs.map(job => [job.migration_id, structuredClone(job)]));
  const operations = new Map<string, any>();
  const logs: RequestLog[] = [];
'''
new = '''  const jobs = new Map(initialJobs.map(job => [job.migration_id, structuredClone(job)]));
  const operations = new Map<string, any>();
  const claimedGroups = new Set<string>();
  const logs: RequestLog[] = [];
'''
if old not in text:
    raise SystemExit('installMigrationApi state marker not found')
text = text.replace(old, new, 1)

old = '''        const eligible = job.items.filter(item => scope === 'applied'
          ? item.state === 'applied'
          : !['applied', 'rolled_back', 'blocked', 'failed'].includes(item.state));
'''
new = '''        const eligible = job.items.filter(item => scope === 'applied'
          ? item.state === 'applied'
          : !claimedGroups.has(`${job.migration_id}:${item.group_id}`)
            && !['applied', 'rolled_back', 'blocked', 'failed'].includes(item.state));
'''
if old not in text:
    raise SystemExit('runnable group filter marker not found')
text = text.replace(old, new, 1)

old = '''      if (claimGroup && method === 'POST') {
        const job = jobs.get(claimGroup[1])!;
        const items = job.items.filter(item => item.group_id === claimGroup[2]);
        return json({ group: { group_id: claimGroup[2], items }, job: refreshJobSummary(job) });
      }
'''
new = '''      if (claimGroup && method === 'POST') {
        const job = jobs.get(claimGroup[1])!;
        const items = job.items.filter(item => item.group_id === claimGroup[2]);
        claimedGroups.add(`${job.migration_id}:${claimGroup[2]}`);
        return json({ group: { group_id: claimGroup[2], items }, job: refreshJobSummary(job) });
      }
'''
if old not in text:
    raise SystemExit('claim group marker not found')
text = text.replace(old, new, 1)

old = '''        job.state = job.items.every(item => item.state === 'applied') ? 'completed' : 'running';
        refreshJobSummary(job);
        return json({ group: { group_id: commit[2], items }, job });
'''
new = '''        job.state = job.items.every(item => item.state === 'applied') ? 'completed' : 'running';
        claimedGroups.delete(`${job.migration_id}:${commit[2]}`);
        refreshJobSummary(job);
        return json({ group: { group_id: commit[2], items }, job });
'''
if old not in text:
    raise SystemExit('commit release marker not found')
text = text.replace(old, new, 1)

old = '''        job.state = job.items.every(item => item.state === 'rolled_back') ? 'rolled_back' : job.state;
        refreshJobSummary(job);
        return json({ group: { group_id: rollback[2], items }, job });
'''
new = '''        job.state = job.items.every(item => item.state === 'rolled_back') ? 'rolled_back' : job.state;
        claimedGroups.delete(`${job.migration_id}:${rollback[2]}`);
        refreshJobSummary(job);
        return json({ group: { group_id: rollback[2], items }, job });
'''
if old not in text:
    raise SystemExit('rollback release marker not found')
text = text.replace(old, new, 1)

path.write_text(text)
