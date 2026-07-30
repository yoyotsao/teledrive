import { useState } from 'react';

export function Sidebar({
  active, onSelectDrive, onSelectTrash,
}: {
  active: 'drive' | 'trash';
  onSelectDrive: () => void;
  onSelectTrash: () => void;
}) {
  // ponytail: default to collapsed on phone-width screens; no resize listener — the toggle covers rotation.
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem('td-sidebar-collapsed');
    return stored ? stored === '1' : window.innerWidth < 768;
  });

  const toggle = () => setCollapsed((c) => {
    localStorage.setItem('td-sidebar-collapsed', c ? '0' : '1');
    return !c;
  });

  const item = (label: string, icon: string, isActive: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-label={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        padding: '10px 14px', border: 'none', borderRadius: 8, cursor: 'pointer',
        fontSize: 14, textAlign: 'left', marginBottom: 4,
        justifyContent: collapsed ? 'center' : 'flex-start',
        background: isActive ? 'var(--td-accent-soft)' : 'none',
        color: isActive ? 'var(--td-accent)' : 'var(--td-text)',
        fontWeight: isActive ? 600 : 400,
      }}
    >
      <span style={{ fontSize: 18 }}>{icon}</span>{!collapsed && label}
    </button>
  );

  return (
    <nav style={{
      width: collapsed ? 60 : 220, flexShrink: 0, borderRight: '1px solid var(--td-border)',
      background: 'var(--td-surface)', padding: 12, boxSizing: 'border-box',
      transition: 'width 0.15s ease',
    }}>
      <button
        onClick={toggle}
        title={collapsed ? '展開側邊欄' : '收起側邊欄'}
        aria-label={collapsed ? '展開側邊欄' : '收起側邊欄'}
        aria-expanded={!collapsed}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: collapsed ? '100%' : 34, height: 34, marginBottom: 8,
          border: 'none', borderRadius: 8, background: 'none', cursor: 'pointer',
          fontSize: 18, color: 'var(--td-text)',
        }}
      >
        ☰
      </button>
      {item('我的雲端硬碟', '☁️', active === 'drive', onSelectDrive)}
      {item('垃圾桶', '🗑️', active === 'trash', onSelectTrash)}
    </nav>
  );
}
