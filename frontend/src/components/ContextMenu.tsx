import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  danger?: boolean;
}

// Positioned popup menu, clamped to the viewport. Closes on outside click,
// scroll, or Escape.
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - width - 8),
      top: Math.min(y, window.innerHeight - height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('scroll', close, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', left: pos.left, top: pos.top, zIndex: 3000,
        background: 'var(--td-surface)', border: '1px solid var(--td-border)',
        borderRadius: 8, boxShadow: '0 6px 20px var(--td-shadow)', padding: '4px',
        minWidth: 180,
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => { onClose(); item.onClick(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
            padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 13, textAlign: 'left', borderRadius: 6,
            color: item.danger ? '#dc2626' : 'var(--td-text)',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--td-surface-alt)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
        >
          {item.icon && <span style={{ fontSize: 14, width: 16, textAlign: 'center' }}>{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  );
}
