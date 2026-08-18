import { useEffect, useRef, useState } from 'react';
import { runImport, type ImportProgress } from '../lib/chatImport';
import { liveDeps } from '../lib/chatImportDeps';

// Import every media message of a chat into root/{chat name}. The whole thing
// runs in this tab — closing it stops the import; re-running resumes, because
// runImport skips media already filed under the folder.
export function ImportChatDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const stopRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const start = async () => {
    const value = input.trim();
    if (!value) { setError('請輸入 chat id、username 或 t.me 連結'); return; }
    setError(null);
    setRunning(true);
    setFinished(false);
    setProgress(null);
    stopRef.current = false;
    try {
      const result = await runImport(value, liveDeps(), setProgress, () => stopRef.current);
      setProgress(result);
      setFinished(true);
      onDone();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}
      onClick={running ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--td-surface)', borderRadius: 8, padding: 24, minWidth: 420, boxShadow: '0 10px 40px var(--td-shadow)' }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--td-text-strong)', marginBottom: 14 }}>
          匯入 chat 媒體
        </div>

        <input
          ref={inputRef}
          value={input}
          disabled={running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !running) start();
            if (e.key === 'Escape' && !running) onClose();
          }}
          placeholder="@channelname、t.me/xxx 或 -1001234567890"
          style={{ width: '100%', padding: '8px 10px', fontSize: 14, borderRadius: 6, border: '1px solid var(--td-border)', background: 'var(--td-bg)', color: 'var(--td-text)', boxSizing: 'border-box' }}
        />

        <div style={{ fontSize: 12, color: 'var(--td-text-muted)', marginTop: 8, lineHeight: 1.6 }}>
          會在根目錄建立以 chat 名稱命名的資料夾，由最舊的訊息開始逐則轉發。
          過程中請保持此頁面開啟；中斷後重跑會自動接續。
        </div>

        {progress && (
          <div style={{ fontSize: 13, color: 'var(--td-text)', marginTop: 14, fontVariantNumeric: 'tabular-nums' }}>
            已匯入 {progress.imported}　跳過 {progress.skipped}　失敗 {progress.failed}
            <div style={{ fontSize: 12, color: 'var(--td-text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {finished ? '完成' : progress.current}
            </div>
          </div>
        )}

        {error && <div style={{ fontSize: 13, color: '#dc2626', marginTop: 12 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          {running ? (
            <button onClick={() => { stopRef.current = true; }} style={btn}>停止</button>
          ) : (
            <>
              <button onClick={onClose} style={btn}>關閉</button>
              <button onClick={start} style={{ ...btn, background: 'var(--td-accent)', color: '#fff', borderColor: 'var(--td-accent)' }}>
                開始匯入
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: '7px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--td-border)', background: 'var(--td-bg)', color: 'var(--td-text)',
};
