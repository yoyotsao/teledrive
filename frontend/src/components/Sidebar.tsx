export function Sidebar({
  active, onSelectDrive, onSelectTrash,
}: {
  active: 'drive' | 'trash';
  onSelectDrive: () => void;
  onSelectTrash: () => void;
}) {
  const item = (label: string, icon: string, isActive: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        padding: '10px 14px', border: 'none', borderRadius: 8, cursor: 'pointer',
        fontSize: 14, textAlign: 'left', marginBottom: 4,
        background: isActive ? 'var(--td-accent-soft)' : 'none',
        color: isActive ? 'var(--td-accent)' : 'var(--td-text)',
        fontWeight: isActive ? 600 : 400,
      }}
    >
      <span style={{ fontSize: 18 }}>{icon}</span>{label}
    </button>
  );

  return (
    <nav style={{
      width: 220, flexShrink: 0, borderRight: '1px solid var(--td-border)',
      background: 'var(--td-surface)', padding: 12, boxSizing: 'border-box',
    }}>
      {item('我的雲端硬碟', '☁️', active === 'drive', onSelectDrive)}
      {item('垃圾桶', '🗑️', active === 'trash', onSelectTrash)}
    </nav>
  );
}
