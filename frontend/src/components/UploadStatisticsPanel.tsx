import { useEffect, useState } from 'react';
import { api, type UploadStatisticsResponse } from '../api/client';
import { flushUploadStatistics } from '../lib/uploadStatisticsSync';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 GB';
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export default function UploadStatisticsPanel() {
  const [data, setData] = useState<UploadStatisticsResponse | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const reload = async () => {
      if (loading) return;
      loading = true;
      let warning = '';
      try {
        try { await flushUploadStatistics(); }
        catch { warning = '部分統計尚未同步或未能保存，數字可能不完整；請確認連線與瀏覽器儲存空間。'; }
        const next = await api.getUploadStatistics();
        if (!cancelled) { setData(next); setError(warning); }
      } catch {
        if (!cancelled) setError('無法更新上傳統計，請稍後重試。');
      } finally { loading = false; }
    };
    void reload();
    const timer = window.setInterval(() => void reload(), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [refresh]);

  const total = data?.days.reduce((sum, day) => sum + day.bytes, 0) ?? 0;
  const peak = Math.max(1, ...(data?.days.map(day => day.bytes) ?? []));
  return <div>
    <p style={{ fontSize: 12, color: 'var(--td-text-muted)', marginTop: 0 }}>
      以台北時間每日 00:00 分日，每 10 秒更新。統計成功上傳的資料量（含縮圖），不含秒傳與轉存。
    </p>
    {error && <div role="alert" style={{ fontSize: 12, color: 'var(--td-text)', marginBottom: 12 }}>
      {error} <button onClick={() => setRefresh(value => value + 1)}>重試</button>
    </div>}
    {!data && !error && <p role="status">載入統計中…</p>}
    {data && <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        {[['今日已上傳', data.days[0]?.bytes ?? 0], ['最近 30 天', total]].map(([label, bytes]) =>
          <div key={label} style={{ flex: 1, border: '1px solid var(--td-border)', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--td-text-muted)' }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 600, marginTop: 6 }}>{formatBytes(Number(bytes))}</div>
          </div>,
        )}
      </div>
      <h3 style={{ fontSize: 14 }}>各帳號今日上傳量</h3>
      {data.accounts.length === 0 && <p style={{ fontSize: 13 }}>尚無帳號統計</p>}
      {data.accounts.map(account => <div key={account.telegram_user_id} style={{
        display: 'flex', justifyContent: 'space-between', gap: 16, padding: '8px 0',
        borderBottom: '1px solid var(--td-border)', fontSize: 13,
      }}>
        <span style={{ overflowWrap: 'anywhere' }}>{account.label || account.telegram_user_id}</span>
        <strong style={{ whiteSpace: 'nowrap' }}>{formatBytes(account.bytes)}</strong>
      </div>)}
      <h3 style={{ fontSize: 14, marginTop: 24 }}>每日紀錄</h3>
      <p style={{ fontSize: 12, color: 'var(--td-text-muted)' }}>
        {data.first_day ? `首筆紀錄：${data.first_day}。啟用前的上傳不會回填。` : '尚無上傳紀錄；從啟用此功能後開始累積。'}
        上傳量不代表 Telegram 每日配額。
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr><th style={{ textAlign: 'left', padding: '8px 0' }}>日期</th><th style={{ textAlign: 'right' }}>上傳量</th></tr></thead>
        <tbody>{data.days.map(day => <tr key={day.day}>
          <td style={{ padding: '7px 0', whiteSpace: 'nowrap' }}>{day.day}{day.day === data.today ? '（今日）' : ''}</td>
          <td style={{ padding: '7px 0', textAlign: 'right', width: '50%' }}>
            <div style={{ position: 'relative', padding: '3px 6px' }}>
              <div aria-hidden="true" style={{ position: 'absolute', inset: 0, left: 'auto', width: `${day.bytes / peak * 100}%`, background: 'rgba(37,99,235,0.15)', borderRadius: 3 }} />
              <span style={{ position: 'relative' }}>{data.first_day && day.day >= data.first_day ? formatBytes(day.bytes) : '—'}</span>
            </div>
          </td>
        </tr>)}</tbody>
      </table>
      <p style={{ fontSize: 11, color: 'var(--td-text-muted)' }}>GB 採十進位。失敗重試不重複計入同一分塊；單獨小檔完成後計入。</p>
    </>}
  </div>;
}
