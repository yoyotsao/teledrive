import { useState, useRef, useCallback } from 'react';
import { api } from '../api/client';
import { UploadResult } from '../types';

interface FileUploaderProps {
  onUploadComplete?: (files: UploadResult[]) => void;
  isConfigured: boolean;
}

interface UploadFile {
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
  result?: UploadResult;
}

function FileUploader({ onUploadComplete, isConfigured }: FileUploaderProps) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length === 0) return;

    const newFiles: UploadFile[] = selectedFiles.map(file => ({
      file,
      progress: 0,
      status: 'pending' as const,
    }));

    setFiles(prev => [...prev, ...newFiles]);
    
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    const newFiles: UploadFile[] = droppedFiles.map(file => ({
      file,
      progress: 0,
      status: 'pending' as const,
    }));

    setFiles(prev => [...prev, ...newFiles]);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  const uploadFile = async (uploadFile: UploadFile, index: number): Promise<UploadResult> => {
    setFiles(prev => prev.map((f, i) => 
      i === index ? { ...f, status: 'uploading' as const, progress: 0 } : f
    ));

    try {
      const result = await api.uploadFile(uploadFile.file);
      
      setFiles(prev => prev.map((f, i) => 
        i === index ? { ...f, status: 'complete' as const, progress: 100, result } : f
      ));
      
      return result;
    } catch (error: any) {
      setFiles(prev => prev.map((f, i) => 
        i === index ? { ...f, status: 'error' as const, error: error.message || 'Upload failed' } : f
      ));
      throw error;
    }
  };

  const handleUpload = async () => {
    if (!isConfigured || files.length === 0) return;

    const pendingFiles = files.filter(f => f.status === 'pending');
    if (pendingFiles.length === 0) return;

    setIsUploading(true);

    try {
      const results: UploadResult[] = [];
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.status === 'pending') {
          try {
            const result = await uploadFile(file, i);
            results.push(result);
          } catch (error) {
            console.error(`Failed to upload ${file.file.name}:`, error);
          }
        }
      }

      onUploadComplete?.(results);
    } finally {
      setIsUploading(false);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const pendingCount = files.filter(f => f.status === 'pending').length;

  return (
    <div style={{ padding: '16px', borderBottom: '1px solid #e5e7eb' }}>
      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        style={{
          border: '2px dashed #d1d5db',
          borderRadius: '8px',
          padding: '24px',
          textAlign: 'center',
          background: isConfigured ? '#f9fafb' : '#f3f4f6',
          cursor: isConfigured ? 'pointer' : 'not-allowed',
          opacity: isConfigured ? 1 : 0.6,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          disabled={!isConfigured}
          style={{ display: 'none' }}
          id="file-input"
        />
        <label 
          htmlFor="file-input"
          style={{ cursor: isConfigured ? 'pointer' : 'not-allowed' }}
        >
          {!isConfigured ? (
            <div style={{ color: '#6b7280' }}>
              <p style={{ margin: '0 0 8px 0', fontSize: '14px' }}>
                Configure Telegram connection first
              </p>
            </div>
          ) : (
            <div style={{ color: '#374151' }}>
              <p style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: 500 }}>
                Drag & drop files here or click to browse
              </p>
              <p style={{ margin: 0, fontSize: '12px', color: '#6b7280' }}>
                Files upload to your Telegram Saved Messages via backend
              </p>
            </div>
          )}
        </label>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          {files.map((uploadFile, index) => (
            <div
              key={`${uploadFile.file.name}-${index}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 12px',
                background: '#f9fafb',
                borderRadius: '4px',
                marginBottom: '4px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between',
                  marginBottom: '4px'
                }}>
                  <span style={{ 
                    fontSize: '13px', 
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}>
                    {uploadFile.file.name}
                  </span>
                  <span style={{ fontSize: '12px', color: '#6b7280', marginLeft: '8px' }}>
                    {formatSize(uploadFile.file.size)}
                  </span>
                </div>
                
                {uploadFile.status === 'uploading' && (
                  <div style={{
                    height: '4px',
                    background: '#e5e7eb',
                    borderRadius: '2px',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${uploadFile.progress}%`,
                      background: '#3b82f6',
                      transition: 'width 0.2s',
                    }} />
                  </div>
                )}
                
                {uploadFile.status === 'complete' && (
                  <span style={{ fontSize: '12px', color: '#16a34a' }}>
                    ✓ Uploaded to Telegram
                  </span>
                )}
                
                {uploadFile.status === 'error' && (
                  <span style={{ fontSize: '12px', color: '#dc2626' }}>
                    ✗ {uploadFile.error || 'Upload failed'}
                  </span>
                )}
              </div>

              {uploadFile.status === 'pending' && (
                <button
                  onClick={() => removeFile(index)}
                  style={{
                    marginLeft: '8px',
                    padding: '4px 8px',
                    background: '#ef4444',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          {/* Upload button */}
          <button
            onClick={handleUpload}
            disabled={!isConfigured || isUploading || pendingCount === 0}
            style={{
              marginTop: '12px',
              width: '100%',
              padding: '10px 16px',
              background: !isConfigured || isUploading || pendingCount === 0 ? '#9ca3af' : '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: !isConfigured || isUploading || pendingCount === 0 ? 'not-allowed' : 'pointer',
              fontWeight: 500,
              fontSize: '14px',
            }}
          >
            {isUploading 
              ? 'Uploading...' 
              : `Upload ${pendingCount} file${pendingCount > 1 ? 's' : ''}`}
          </button>
        </div>
      )}
    </div>
  );
}

export default FileUploader;
