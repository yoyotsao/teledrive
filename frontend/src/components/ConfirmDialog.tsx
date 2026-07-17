// Modal confirm replacing window.confirm() (native dialogs block Playwright).
export function ConfirmDialog({
  message, confirmLabel = '確定', danger = false, onConfirm, onCancel,
}: {
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--td-surface)', borderRadius: 8, padding: 24,
          maxWidth: 380, boxShadow: '0 10px 40px var(--td-shadow)',
        }}
      >
        <div style={{ fontSize: 15, color: 'var(--td-text-strong)', marginBottom: 20 }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 16px', border: '1px solid var(--td-border)', borderRadius: 6,
              background: 'var(--td-surface)', color: 'var(--td-text)', cursor: 'pointer', fontSize: 14,
            }}
          >取消</button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 16px', border: 'none', borderRadius: 6,
              background: danger ? '#dc2626' : 'var(--td-accent)', color: 'white', cursor: 'pointer', fontSize: 14,
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
