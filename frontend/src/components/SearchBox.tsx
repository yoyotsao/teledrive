import { useEffect, useRef, useState } from 'react';

// Debounced (300ms) search input. `value` is the committed URL query; local
// state tracks keystrokes so typing stays responsive.
export function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [local, setLocal] = useState(value);
  const timer = useRef<number | null>(null);

  // Keep local in sync when the query changes from outside (e.g. Back button).
  useEffect(() => { setLocal(value); }, [value]);

  const push = (v: string) => {
    setLocal(v);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onChange(v), 300);
  };

  return (
    <div style={{ position: 'relative', flex: 1, maxWidth: 420 }}>
      <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--td-text-muted)', fontSize: 14 }}>🔍</span>
      <input
        value={local}
        onChange={(e) => push(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { push(''); onChange(''); } }}
        placeholder="搜尋雲端硬碟"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '8px 32px', fontSize: 14,
          border: '1px solid var(--td-border)', borderRadius: 20,
          background: 'var(--td-surface-alt)', color: 'var(--td-text-strong)',
        }}
      />
      {local && (
        <button
          onClick={() => { push(''); onChange(''); }}
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)', fontSize: 14 }}
        >✕</button>
      )}
    </div>
  );
}
