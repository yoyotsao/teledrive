import { useEffect, useRef, useState } from 'react';

// Shared modal for rename and new-folder. On open, focuses the input and (for
// rename) pre-selects the name body, leaving the extension unselected.
export function RenameDialog({
  title, initialValue, selectBaseName = false, confirmLabel = '確定', onSubmit, onCancel,
}: {
  title: string;
  initialValue: string;
  selectBaseName?: boolean;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = initialValue.lastIndexOf('.');
    if (selectBaseName && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initialValue, selectBaseName]);

  const submit = () => {
    const v = value.trim();
    if (!v) { setError('名稱不可為空'); return; }
    if (v.includes('/') || v.includes('\\')) { setError('名稱不可包含 / 或 \\'); return; }
    onSubmit(v);
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--td-surface)', borderRadius: 8, padding: 24, minWidth: 340, boxShadow: '0 10px 40px var(--td-shadow)' }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--td-text-strong)', marginBottom: 14 }}>{title}</div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 14,
            border: `1px solid ${error ? '#dc2626' : 'var(--td-border)'}`, borderRadius: 6,
            background: 'var(--td-surface)', color: 'var(--td-text-strong)',
          }}
        />
        {error && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button
            onClick={onCancel}
            style={{ padding: '8px 16px', border: '1px solid var(--td-border)', borderRadius: 6, background: 'var(--td-surface)', color: 'var(--td-text)', cursor: 'pointer', fontSize: 14 }}
          >取消</button>
          <button
            onClick={submit}
            style={{ padding: '8px 16px', border: 'none', borderRadius: 6, background: 'var(--td-accent)', color: 'white', cursor: 'pointer', fontSize: 14 }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
