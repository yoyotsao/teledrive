import { useCallback, useEffect, useState } from 'react';
import { api, type LinkedAccount, type StorageTargetResponse, type StorageTargetVerificationRequest } from '../api/client';
import { validateChannelForAccount } from '../lib/channelStorage';
import { getClientFor } from '../lib/gramjs';
import { parseCanonicalChannelId } from '../lib/storageLocation';

type Props = { onSaved?: (target: StorageTargetResponse) => void };

type LiveStatus = {
  telegramUserId: number;
  label: string;
  canRead: boolean;
  canWrite: boolean;
  checkedAt: string | null;
  detail: string;
};

type E2EVerifier = (telegramUserId: number, channelId: string) => Promise<{
  channel_title?: string | null;
  can_read: boolean;
  can_write: boolean;
  checked_at?: string;
}>;

declare global {
  interface Window {
    __TELEDRIVE_STORAGE_TARGET_VERIFY__?: E2EVerifier;
  }
}

const FRESH_MS = 5 * 60_000;

function fresh(checkedAt: string): boolean {
  const time = Date.parse(checkedAt);
  return Number.isFinite(time) && Date.now() - time >= 0 && Date.now() - time <= FRESH_MS;
}

function statusText(statuses: LiveStatus[], total: number): string {
  if (total === 0) return '尚未連結 Telegram 帳號';
  const readers = statuses.filter((item) => item.canRead).length;
  const writers = statuses.filter((item) => item.canWrite).length;
  if (readers === 0 || writers === 0) return `目前不可用：${readers}/${total} readers、${writers}/${total} writers；不會 fallback 到 Saved Messages`;
  if (readers < total || writers < total) return `目前降級：${readers}/${total} readers、${writers}/${total} writers；缺少權限的帳號不會 fallback 到 Saved Messages`;
  return `目前正常：${readers}/${total} readers、${writers}/${total} writers`;
}

async function verifyOne(account: LinkedAccount, channelId: string): Promise<{ evidence: StorageTargetVerificationRequest; title: string | null; status: LiveStatus }> {
  if (import.meta.env.VITE_E2E_TEST_HOOKS === '1' && typeof window !== 'undefined' && window.__TELEDRIVE_STORAGE_TARGET_VERIFY__) {
    const result = await window.__TELEDRIVE_STORAGE_TARGET_VERIFY__(account.telegram_user_id, channelId);
    const checkedAt = result.checked_at ?? new Date().toISOString();
    return {
      title: result.channel_title ?? null,
      evidence: {
        telegram_user_id: account.telegram_user_id,
        channel_title: result.channel_title ?? null,
        can_read: result.can_read,
        can_write: result.can_write,
        status: 'verified',
        checked_at: checkedAt,
      },
      status: {
        telegramUserId: account.telegram_user_id,
        label: account.label ?? String(account.telegram_user_id),
        canRead: result.can_read,
        canWrite: result.can_write,
        checkedAt,
        detail: result.can_read && result.can_write ? 'read/write OK' : `read=${result.can_read} write=${result.can_write}`,
      },
    };
  }

  const manager = getClientFor(account.telegram_user_id);
  const result = await validateChannelForAccount(manager as any, channelId);
  return {
    title: result.channel_title,
    evidence: {
      telegram_user_id: account.telegram_user_id,
      channel_title: result.channel_title,
      can_read: result.can_read,
      can_write: result.can_write,
      status: 'verified',
      checked_at: result.checked_at,
    },
    status: {
      telegramUserId: account.telegram_user_id,
      label: account.label ?? String(account.telegram_user_id),
      canRead: result.can_read,
      canWrite: result.can_write,
      checkedAt: result.checked_at,
      detail: result.can_read && result.can_write ? 'read/write OK' : `read=${result.can_read} write=${result.can_write}`,
    },
  };
}

export function StorageTargetDialog({ onSaved }: Props) {
  const [target, setTarget] = useState<StorageTargetResponse | null>(null);
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [mode, setMode] = useState<'saved_messages' | 'channel'>('saved_messages');
  const [channelId, setChannelId] = useState('');
  const [statuses, setStatuses] = useState<LiveStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [nextTarget, nextAccounts] = await Promise.all([api.getStorageTarget(), api.listAccounts()]);
    setTarget(nextTarget);
    setAccounts(nextAccounts);
    setMode(nextTarget.storage_mode);
    setChannelId(nextTarget.channel_id ?? '');
    setStatuses([]);
    return { nextTarget, nextAccounts };
  }, []);

  useEffect(() => {
    load().catch((reason) => setError(`無法載入儲存設定：${reason?.message ?? reason}`));
  }, [load]);

  const verify = useCallback(async (id: string, linked = accounts) => {
    const canonical = parseCanonicalChannelId(id.trim());
    const settled = await Promise.all(linked.map(async (account) => {
      try {
        return await verifyOne(account, canonical);
      } catch (reason: any) {
        return {
          title: null,
          evidence: null,
          status: {
            telegramUserId: account.telegram_user_id,
            label: account.label ?? String(account.telegram_user_id),
            canRead: false,
            canWrite: false,
            checkedAt: null,
            detail: reason?.message ?? String(reason),
          } satisfies LiveStatus,
        };
      }
    }));
    const nextStatuses = settled.map((item) => item.status);
    setStatuses(nextStatuses);
    const evidence = settled.map((item) => item.evidence).filter((item): item is StorageTargetVerificationRequest => item !== null);
    const title = settled.find((item) => item.title)?.title ?? null;
    return { canonical, evidence, title, statuses: nextStatuses };
  }, [accounts]);

  const runLiveCheck = async () => {
    setError(''); setNotice(''); setBusy(true);
    try {
      if (mode !== 'channel') { setStatuses([]); return; }
      await verify(channelId);
    } catch (reason: any) {
      setStatuses([]);
      setError(reason?.message ?? String(reason));
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!target) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (mode === 'saved_messages') {
        const saved = await api.putStorageTarget({
          storage_mode: 'saved_messages',
          expected_version: target.version,
          expected_accounts_version: target.accounts_version,
          verifications: [],
        });
        setTarget(saved); setStatuses([]); setNotice('已切換為 Saved Messages'); onSaved?.(saved); return;
      }

      const checked = await verify(channelId);
      if (accounts.length === 0 || checked.evidence.length !== accounts.length) throw new Error('所有目前連結的帳號都必須完成驗證');
      if (checked.statuses.some((item) => !item.canRead || !item.canWrite)) throw new Error('所有目前連結的帳號都必須同時具有 read/write 權限');
      if (checked.evidence.some((item) => !fresh(item.checked_at))) throw new Error('驗證已超過 5 分鐘，請重新驗證');

      const saved = await api.putStorageTarget({
        storage_mode: 'channel',
        channel_id: checked.canonical,
        channel_title: checked.title ?? undefined,
        expected_version: target.version,
        expected_accounts_version: target.accounts_version,
        verifications: checked.evidence,
      });
      setTarget(saved); setChannelId(saved.channel_id ?? checked.canonical); setNotice('共用儲存頻道已啟用'); onSaved?.(saved);
    } catch (reason: any) {
      if (reason?.response?.status === 409) {
        await load().catch(() => undefined);
        setError('設定或帳號版本已變更，已重新整理；請再次驗證後重試');
      } else {
        setError(reason?.message ?? String(reason));
      }
    } finally { setBusy(false); }
  };

  return <section aria-labelledby="storage-target-title" data-testid="storage-target-settings">
    <h3 id="storage-target-title" style={{ margin: '0 0 8px', fontSize: 15 }}>儲存位置</h3>
    <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--td-text-muted)', lineHeight: 1.6 }}>
      共用頻道模式只使用已驗證的 private broadcast channel；runtime 沒有可用 reader/writer 時會顯示暫時不可用，絕不 fallback 到 @me。
    </p>

    <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
      <input type="radio" name="storage-mode" checked={mode === 'saved_messages'} disabled={busy} onChange={() => setMode('saved_messages')} />
      Saved Messages
    </label>
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
      <input type="radio" name="storage-mode" checked={mode === 'channel'} disabled={busy} onChange={() => setMode('channel')} />
      共用私人 broadcast channel
    </label>

    {mode === 'channel' && <>
      <label htmlFor="storage-channel-id" style={{ display: 'block', fontSize: 12, marginBottom: 5 }}>Canonical raw channel ID</label>
      <input id="storage-channel-id" aria-label="Canonical raw channel ID" value={channelId} disabled={busy}
        onChange={(event) => setChannelId(event.target.value)} placeholder="123456789"
        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--td-border)', background: 'var(--td-bg)', color: 'var(--td-text)', boxSizing: 'border-box' }} />
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button disabled={busy} onClick={runLiveCheck}>驗證所有帳號</button>
      </div>
      <p data-testid="storage-live-status" style={{ fontSize: 12, color: 'var(--td-text-muted)' }}>{statusText(statuses, accounts.length)}</p>
      {statuses.map((item) => <div key={item.telegramUserId} data-testid={`storage-account-${item.telegramUserId}`} style={{ fontSize: 12, margin: '4px 0' }}>
        {item.label}: {item.detail}
      </div>)}
    </>}

    {error && <p role="alert" style={{ color: '#dc2626', fontSize: 12 }}>{error}</p>}
    {notice && <p role="status" style={{ color: '#15803d', fontSize: 12 }}>{notice}</p>}
    <button data-testid="save-storage-target" disabled={busy || !target} onClick={save}
      style={{ marginTop: 12, padding: '8px 14px', border: 'none', borderRadius: 6, background: '#2563eb', color: '#fff', cursor: 'pointer' }}>
      儲存儲存位置
    </button>
  </section>;
}
