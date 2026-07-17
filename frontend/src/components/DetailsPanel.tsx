import { FileInfo } from '../types';

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ fontSize: 11, color: 'var(--td-text-muted)', marginBottom: 2 }}>{label}</div>
    <div style={{ fontSize: 13, color: 'var(--td-text-strong)', wordBreak: 'break-word' }}>{value}</div>
  </div>
);

export function DetailsPanel({
  file, thumbnailUrl, locationName, onClose,
}: {
  file: FileInfo;
  thumbnailUrl?: string | null;
  locationName: string;
  onClose: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 300, zIndex: 1500,
      flexShrink: 0, borderLeft: '1px solid var(--td-border)', boxShadow: '-4px 0 16px var(--td-shadow)',
      background: 'var(--td-surface)', padding: 16, overflowY: 'auto', boxSizing: 'border-box',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--td-text-strong)' }}>詳細資訊</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)', fontSize: 16 }}>✕</button>
      </div>

      <div style={{
        width: '100%', height: 160, borderRadius: 8, marginBottom: 16, overflow: 'hidden',
        background: 'var(--td-surface-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {thumbnailUrl
          ? <img src={thumbnailUrl} alt={file.filename} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          : <span style={{ fontSize: 64 }}>{file.isDir ? '📁' : '📄'}</span>}
      </div>

      <Row label="名稱" value={file.filename} />
      <Row label="類型" value={file.isDir ? '資料夾' : (file.mime_type || file.file_type || '未知')} />
      {!file.isDir && <Row label="大小" value={formatSize(file.filesize)} />}
      <Row label="建立時間" value={new Date(file.created_at).toLocaleString()} />
      <Row label="位置" value={locationName} />
    </div>
  );
}
