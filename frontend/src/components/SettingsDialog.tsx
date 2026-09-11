import { useState, useEffect, useCallback } from 'react';
import { api, LinkedAccount } from '../api/client';
import { SessionTabs } from './LoginScreen';
import { adoptClient, getClientFor, saveAccount, removeAccount, TelegramClientManager } from '../lib/gramjs';
import UploadStatisticsPanel from './UploadStatisticsPanel';
import { flushUploadStatistics } from '../lib/uploadStatisticsSync';

type Props = { onClose: () => void };

/** Backend row + whatever this browser knows about the account's live client. */
type Row = LinkedAccount & { online: boolean; rate: number | null };

export async function flushThenUnlinkSecondaryAccount(
  telegramUserId: number,
  actions: {
    flush: (telegramUserId: number) => Promise<void>;
    unlink: (telegramUserId: number) => Promise<void>;
    forget: (telegramUserId: number) => Promise<void>;
  },
): Promise<void> {
  await actions.flush(telegramUserId);
  await actions.unlink(telegramUserId);
  await actions.forget(telegramUserId);
}

function decorate(accounts: LinkedAccount[]): Row[] {
  return accounts.map((a) => {
    const client = getClientFor(a.telegram_user_id);
    return {
      ...a,
      online: client.isConnected() && !client.offline,
      // Shows which account is being throttled — the whole point of per-account pacers.
      rate: client.offline ? null : client.getChunkRateStats().rate,
    };
  });
}

export default function SettingsDialog({ onClose }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState('');
  const [tab, setTab] = useState<'accounts' | 'statistics'>('accounts');

  const reload = useCallback(async () => {
    try {
      setRows(decorate(await api.listAccounts()));
    } catch (err: any) {
      setError('無法載入帳號清單：' + (err?.message ?? err));
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /**
   * The new account proves itself the same way login does: it DMs a one-time
   * nonce to our bot. Crucially the DM is sent by the NEW client, so Telegram
   * tells the backend which account it is — the session string never leaves
   * this browser.
   */
  const linkAccount = async (sessionString: string, client: TelegramClientManager) => {
    setError('');
    setLinking('等待 Telegram 驗證...');
    try {
      const { nonce, bot_username } = await api.requestAccountChallenge();
      await client.sendAuthChallenge(bot_username, nonce);

      let linked: LinkedAccount | null = null;
      for (let i = 0; i < 60 && !linked; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        linked = await api.verifyAccount(nonce);
      }
      if (!linked) throw new Error('Telegram 驗證逾時，請重試');

      const accountName = linked.label ?? String(linked.telegram_user_id);
      adoptClient(linked.telegram_user_id, client, accountName);
      await saveAccount({
        id: linked.telegram_user_id,
        label: accountName,
        session: sessionString,
      });
      setAdding(false);
      setLinking('');
      await reload();
    } catch (err: any) {
      setLinking('');
      setError(err?.response?.data?.detail ?? err?.message ?? String(err));
      throw err; // let SessionTabs show it inline too
    }
  };

  const unlink = async (row: Row) => {
    setError('');
    try {
      await flushThenUnlinkSecondaryAccount(row.telegram_user_id, {
        flush: flushUploadStatistics,
        unlink: api.unlinkAccount,
        forget: removeAccount,
      });
      await reload();
    } catch (err: any) {
      // 409 carries the reason (usually "still stores N files") — show it verbatim.
      setError(err?.response?.data?.detail ?? err?.message ?? String(err));
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--td-surface)', color: 'var(--td-text)', borderRadius: 12,
          padding: '24px 28px', width: 520, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', maxHeight: '80vh', overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h2 id="settings-title" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>設定</h2>
          <button onClick={onClose} aria-label="關閉設定" style={{
            marginLeft: 'auto', border: 'none', background: 'none',
            fontSize: 20, cursor: 'pointer', color: 'var(--td-text-muted)',
          }}>×</button>
        </div>

        <div role="tablist" aria-label="設定分頁" style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid var(--td-border)' }}>
          {(['accounts', 'statistics'] as const).map(value => <button
            key={value} id={`settings-tab-${value}`} role="tab"
            aria-selected={tab === value} aria-controls={`settings-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={event => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next = event.key === 'Home' ? 'accounts' : event.key === 'End' ? 'statistics' : tab === 'accounts' ? 'statistics' : 'accounts';
                setTab(next);
                document.getElementById(`settings-tab-${next}`)?.focus();
              }
            }}
            style={{ padding: '10px 14px', border: 'none', borderBottom: `2px solid ${tab === value ? '#2563eb' : 'transparent'}`, background: 'none', color: tab === value ? 'var(--td-text-strong)' : 'var(--td-text-muted)', fontWeight: tab === value ? 600 : 400, cursor: 'pointer' }}
          >{value === 'accounts' ? '管理帳號' : '統計'}</button>)}
        </div>

        {tab === 'statistics' && <div id="settings-panel-statistics" role="tabpanel" aria-labelledby="settings-tab-statistics"><UploadStatisticsPanel /></div>}
        <div id="settings-panel-accounts" role="tabpanel" aria-labelledby="settings-tab-accounts" hidden={tab !== 'accounts'}>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--td-text-muted)' }}>
          多綁幾個帳號，上傳會分散到各帳號並行，總吞吐大致等比放大。
        </p>

        {rows.map((row) => (
          <div key={row.telegram_user_id} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
            borderBottom: '1px solid var(--td-border)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>
                {row.label || row.telegram_user_id}
                {row.is_primary ? <span style={{ fontSize: 11, color: 'var(--td-text-muted)', marginLeft: 6 }}>主帳號</span> : null}
              </div>
              <div style={{ fontSize: 11, color: 'var(--td-text-muted)' }}>
                {row.file_count} 個檔案 · {row.online ? '已連線' : '未連線'}
                {row.rate != null && ` · ${row.rate.toFixed(1)} parts/s`}
              </div>
            </div>
            {!row.is_primary && (
              <button onClick={() => unlink(row)} style={{
                padding: '4px 10px', border: '1px solid var(--td-border)', borderRadius: 6,
                background: 'var(--td-surface)', fontSize: 12, cursor: 'pointer', color: 'var(--td-text)',
              }}>移除</button>
            )}
          </div>
        ))}

        {error && (
          <p style={{ margin: '12px 0 0', fontSize: 12, color: '#dc2626' }}>{error}</p>
        )}
        {linking && (
          <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--td-text-muted)' }}>{linking}</p>
        )}

        {adding ? (
          <div style={{ marginTop: 20 }}>
            <SessionTabs onLogin={linkAccount} />
            <button onClick={() => { setAdding(false); setLinking(''); }} style={{
              marginTop: 12, padding: '6px 14px', border: '1px solid var(--td-border)',
              borderRadius: 6, background: 'var(--td-surface)', fontSize: 13,
              cursor: 'pointer', color: 'var(--td-text)',
            }}>取消</button>
          </div>
        ) : (
          <button onClick={() => { setError(''); setAdding(true); }} style={{
            marginTop: 20, padding: '8px 16px', border: 'none', borderRadius: 6,
            background: '#2563eb', color: '#fff', fontSize: 13, cursor: 'pointer',
          }}>＋ 新增 Telegram 帳號</button>
        )}
        </div>
      </div>
    </div>
  );
}
