import { useCallback, useEffect, useState } from 'react';
import { api, type StorageMigrationJob } from '../api/client.ts';
import {
  pauseMigrationJob,
  rollbackMigrationJob,
  runMigrationJob,
  type MigrationRunProgress,
} from './migrateSavedMessagesToChannel.ts';

const panel: React.CSSProperties = {
  maxWidth: 980,
  margin: '0 auto',
  padding: '28px 24px 48px',
  color: 'var(--td-text)',
};

const button: React.CSSProperties = {
  border: '1px solid var(--td-border)',
  borderRadius: 6,
  background: 'var(--td-surface)',
  color: 'var(--td-text)',
  padding: '7px 12px',
  cursor: 'pointer',
};

const visibleStates = [
  'planned', 'sending', 'recovering', 'uncertain', 'forwarded',
  'pending_quorum', 'retryable', 'verified', 'applied', 'failed', 'blocked', 'rolled_back',
];

export default function StorageMigrationPage() {
  const [jobs, setJobs] = useState<StorageMigrationJob[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, MigrationRunProgress>>({});
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setJobs(await api.listMigrationJobs());
  }, []);

  useEffect(() => {
    void reload().catch(err => setError(err?.response?.data?.detail ?? err?.message ?? String(err)));
  }, [reload]);

  const create = async (dryRun: boolean) => {
    setBusy(dryRun ? 'dry-run' : 'create');
    setError('');
    try {
      const target = await api.getStorageTarget();
      if (target.storage_mode !== 'channel' || !target.channel_id) {
        throw new Error('Shared channel storage 必須先在設定中啟用');
      }
      const job = await api.createMigrationManifest({
        expectedTargetVersion: target.version,
        expectedAccountsVersion: target.accounts_version,
        dryRun,
      });
      setJobs(current => [job, ...current.filter(row => row.migration_id !== job.migration_id)]);
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  const track = (jobId: string) => (next: MigrationRunProgress) => {
    setProgress(current => ({ ...current, [jobId]: next }));
  };

  const run = async (job: StorageMigrationJob) => {
    setBusy(job.migration_id);
    setError('');
    try {
      const updated = await runMigrationJob(job.migration_id, track(job.migration_id));
      setJobs(current => current.map(row => row.migration_id === updated.migration_id ? updated : row));
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? err?.message ?? String(err));
      await reload().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const pause = (job: StorageMigrationJob) => {
    pauseMigrationJob(job.migration_id);
    setProgress(current => ({
      ...current,
      [job.migration_id]: { ...(current[job.migration_id] ?? {}), phase: 'paused' },
    }));
  };

  const rollback = async (job: StorageMigrationJob) => {
    setBusy(`rollback:${job.migration_id}`);
    setError('');
    try {
      const updated = await rollbackMigrationJob(job.migration_id, track(job.migration_id));
      setJobs(current => current.map(row => row.migration_id === updated.migration_id ? updated : row));
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? err?.message ?? String(err));
      await reload().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main style={panel} data-testid="storage-migration-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Shared Channel Storage Migration</h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--td-text-muted)' }}>
            維護工具：分批把 Saved Messages 實體位置搬到目前凍結的共用私人頻道。Telegram bytes 永遠只留在瀏覽器。
          </p>
        </div>
        <a href="/" style={{ marginLeft: 'auto', color: 'var(--td-accent)' }}>返回檔案</a>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 22 }}>
        <button style={button} disabled={busy !== null} onClick={() => void create(true)}>建立 Dry Run</button>
        <button style={button} disabled={busy !== null} onClick={() => void create(false)}>建立 Migration</button>
        <button style={button} disabled={busy !== null} onClick={() => void reload()}>重新整理</button>
      </div>

      {error && <p role="alert" style={{ color: '#dc2626', fontSize: 13 }}>{error}</p>}

      <section style={{ marginTop: 24, display: 'grid', gap: 12 }}>
        {jobs.length === 0 && <p style={{ color: 'var(--td-text-muted)' }}>尚無 migration job。</p>}
        {jobs.map(job => {
          const applied = (job.item_counts.applied ?? 0) > 0;
          const running = busy === job.migration_id;
          const current = progress[job.migration_id];
          return (
            <article key={job.migration_id} style={{ border: '1px solid var(--td-border)', borderRadius: 8, padding: 14, background: 'var(--td-surface)' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{job.migration_id}</strong>
                <span>{job.state}</span>
                {job.dry_run && <span>dry-run</span>}
                <span style={{ color: 'var(--td-text-muted)', fontSize: 12 }}>
                  {job.total_groups} group(s) / {job.total_items} item(s)
                </span>
                {!job.dry_run && !['completed', 'rolled_back'].includes(job.state) && !running && (
                  <button style={{ ...button, marginLeft: 'auto' }} disabled={busy !== null} onClick={() => void run(job)}>
                    執行 / 繼續
                  </button>
                )}
                {running && (
                  <button style={{ ...button, marginLeft: 'auto' }} onClick={() => pause(job)}>暫停</button>
                )}
                {applied && !running && (
                  <button style={{ ...button, marginLeft: 'auto' }} disabled={busy !== null} onClick={() => void rollback(job)}>
                    回滾
                  </button>
                )}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--td-text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {visibleStates.filter(state => (job.item_counts[state] ?? 0) > 0).map(state => (
                  <span key={state}>{state}: {job.item_counts[state]}</span>
                ))}
              </div>
              {(current?.currentGroupId || current?.currentSourceAccount) && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--td-text-muted)' }}>
                  {current.currentGroupId && <>目前群組：{current.currentGroupId}</>}
                  {current.currentSourceAccount && <> · 來源帳號：{current.currentSourceAccount}</>}
                </div>
              )}
              {job.next_retry_at && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--td-text-muted)' }}>
                  下次可重試：{new Date(job.next_retry_at).toLocaleString()}
                </div>
              )}
              {current?.lastError && <div style={{ marginTop: 8, fontSize: 12 }}>{current.lastError}</div>}
            </article>
          );
        })}
      </section>
    </main>
  );
}
