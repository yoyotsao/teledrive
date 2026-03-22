import { useState, useCallback, useEffect } from 'react';
import { api } from '../api/client';
import { FileInfo } from '../types';

const FILE_TYPE_ICONS: Record<string, string> = {
  video: '🎬',
  audio: '🎵',
  photo: '🖼️',
  document: '📄',
  archive: '📦',
  other: '📎',
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function FileBrowser() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 50;

  const loadFiles = useCallback(async (pageNum: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listFiles(pageNum, pageSize);
      setFiles(response.files);
      setTotal(response.total);
      setPage(pageNum);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles(1);
  }, []);

  const handleDelete = async (fileId: string, filename: string) => {
    if (!confirm(`Delete "${filename}"? This will remove it from Telegram Saved Messages.`)) return;
    
    try {
      await api.deleteFile(fileId);
      setFiles(prev => prev.filter(f => f.file_id !== fileId));
      setTotal(prev => prev - 1);
    } catch (err) {
      alert('Failed to delete: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '16px' }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: '16px'
      }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
          My Files ({total})
        </h2>
        <button
          onClick={() => loadFiles(page)}
          disabled={loading}
          style={{
            padding: '6px 12px',
            background: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
          }}
        >
          {loading ? 'Loading...' : '↻ Refresh'}
        </button>
      </div>

      {loading && files.length === 0 && (
        <div style={{ padding: '20px', textAlign: 'center', color: '#6b7280' }}>
          Loading files...
        </div>
      )}

      {error && (
        <div style={{ 
          padding: '12px 16px', 
          background: '#fee2e2', 
          borderRadius: '6px', 
          color: '#dc2626',
          marginBottom: '16px'
        }}>
          {error}
        </div>
      )}

      {files.length === 0 && !loading && !error && (
        <div style={{ 
          padding: '40px', 
          textAlign: 'center', 
          color: '#6b7280',
          border: '2px dashed #e5e7eb',
          borderRadius: '8px'
        }}>
          <p style={{ fontSize: '16px', margin: '0 0 8px 0' }}>No files yet</p>
          <p style={{ fontSize: '13px', margin: 0 }}>Upload files using the uploader above</p>
        </div>
      )}

      {files.length > 0 && (
        <div style={{ overflow: 'auto' }}>
          <table style={{ 
            width: '100%', 
            borderCollapse: 'collapse',
            fontSize: '13px'
          }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6b7280' }}>Name</th>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6b7280' }}>Size</th>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6b7280' }}>Type</th>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6b7280' }}>Uploaded</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', color: '#6b7280' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.file_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {FILE_TYPE_ICONS[file.file_type] || FILE_TYPE_ICONS.other} {file.filename}
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>
                    {formatSize(file.filesize)}
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', textTransform: 'capitalize' }}>
                    {file.file_type}
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: '12px' }}>
                    {formatDate(file.created_at)}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                    <button
                      onClick={() => handleDelete(file.file_id, file.filename)}
                      style={{
                        padding: '4px 10px',
                        background: '#ef4444',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ 
          display: 'flex', 
          justifyContent: 'center', 
          gap: '8px',
          marginTop: '16px',
          paddingTop: '16px',
          borderTop: '1px solid #e5e7eb'
        }}>
          <button
            onClick={() => loadFiles(page - 1)}
            disabled={page <= 1 || loading}
            style={{
              padding: '6px 12px',
              background: page <= 1 ? '#e5e7eb' : '#3b82f6',
              color: page <= 1 ? '#9ca3af' : 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: page <= 1 ? 'not-allowed' : 'pointer',
              fontSize: '13px',
            }}
          >
            ← Prev
          </button>
          <span style={{ padding: '6px 12px', color: '#6b7280', fontSize: '13px' }}>
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => loadFiles(page + 1)}
            disabled={page >= totalPages || loading}
            style={{
              padding: '6px 12px',
              background: page >= totalPages ? '#e5e7eb' : '#3b82f6',
              color: page >= totalPages ? '#9ca3af' : 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: page >= totalPages ? 'not-allowed' : 'pointer',
              fontSize: '13px',
            }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
