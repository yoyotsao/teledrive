import { useState, useEffect, useCallback } from 'react';
import { api, LinkedAccount } from '../api/client';
import { SessionTabs } from './LoginScreen';
import { adoptClient, getClientFor, saveAccount, removeAccount, TelegramClientManager } from '../lib/gramjs';

type Props = { onClose: () => void };

/** Backend row + whatever this browser knows about the account's live client. */
type Row = LinkedAccount & { online: boolean; rate: number | null };

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
      await api.unlinkAccount(row.telegram_user_id);
      await removeAccount(row.telegram_user_id);
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
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--td-surface)', color: 'var(--td-text)', borderRadius: 12,
          padding: '24px 28px', minWidth: 420, maxWidth: 520, maxHeight: '80vh', overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Telegram 帳號</h2>
          <button onClick={onClose} style={{
            marginLeft: 'auto', border: 'none', background: 'none',
            fontSize: 20, cursor: 'pointer', color: 'var(--td-text-muted)',
          }}>×</button>
        </div>

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
  );
}
