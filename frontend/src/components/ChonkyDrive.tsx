import { useState, useEffect, useCallback, useRef } from 'react';
import { FileData } from '@aperturerobotics/chonky';
import { api, generateThumbnail } from '../api/client';
import { FileInfo } from '../types';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function ChonkyDrive() {
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<FileData[]>([]);
  const [files, setFiles] = useState<FileData[]>([]);
  const [originalFiles, setOriginalFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  const dragCounterRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<
    Array<{ name: string; progress: number; status: 'uploading' | 'complete' | 'error'; error?: string }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadThumbnails = useCallback(async (files: FileInfo[]) => {
    const imageOrVideoFiles = files.filter(
      (f) => f.mime_type?.startsWith('image/') || f.mime_type?.startsWith('video/')
    );
    
    for (const file of imageOrVideoFiles) {
      if (!thumbnails[file.file_id]) {
        if (file.thumbnail_data) {
          const thumbUrl = `data:image/jpeg;base64,${file.thumbnail_data}`;
          console.log(`[Thumb] Using stored thumbnail_data for ${file.filename}`);
          setThumbnails((prev) => ({ ...prev, [file.file_id]: thumbUrl }));
        } else {
          try {
            console.log(`[Thumb] Loading thumbnail for ${file.filename} (file_id=${file.file_id})...`);
            const thumb = await api.getThumbnail(file.file_id);
            console.log(`[Thumb] Result for ${file.filename}:`, thumb ? `success` : 'null');
            if (thumb) {
              setThumbnails((prev) => ({ ...prev, [file.file_id]: thumb }));
            }
          } catch (err: any) {
            console.log(`[Thumb] Error for ${file.filename}:`, err?.response?.data || err.message);
          }
        }
      }
    }
  }, [thumbnails]);

  const loadContents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [filesResponse, foldersResponse] = await Promise.all([
        api.listFiles(1, 50, currentFolderId ?? undefined),
        api.listFolders(currentFolderId),
      ]);

      const allOriginal: FileInfo[] = [...foldersResponse.files, ...filesResponse.files];
      
      // 去重：根據檔名去重，保留最新上傳的
      const seenNames = new Set<string>();
      const uniqueFiles = allOriginal.reverse().filter((f) => {
        if (seenNames.has(f.filename)) return false;
        seenNames.add(f.filename);
        return true;
      }).reverse();

      const fileEntries: FileData[] = [
        ...uniqueFiles.filter((f) => f.isDir).map((f): FileData => ({
          id: f.file_id,
          name: f.filename,
          isDir: true,
          parentId: f.parent_id ?? undefined,
        })),
        ...uniqueFiles.filter((f) => !f.isDir).map((f): FileData => ({
          id: f.file_id,
          name: f.filename,
          isDir: false,
          size: f.filesize,
          modDate: new Date(f.created_at),
          thumbnailUrl: undefined,
        })),
      ];

      setFiles(fileEntries);
      setOriginalFiles(uniqueFiles);
      
      // Load thumbnails for images/videos
      loadThumbnails(uniqueFiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
      setFiles([]);
      setOriginalFiles([]);
    } finally {
      setLoading(false);
    }
  }, [currentFolderId, loadThumbnails]);

  useEffect(() => {
    loadContents();
  }, [loadContents]);

  const handleNavigateToBreadcrumb = (index: number) => {
    if (index === 0) {
      // Navigate to root
      setCurrentFolderId(null);
      setBreadcrumb([]);
    } else {
      // Navigate to the folder at this index
      const targetFolder = breadcrumb[index];
      setCurrentFolderId(targetFolder.id);
      setBreadcrumb((prev) => prev.slice(0, index));
    }
  };

  const handleBack = () => {
    if (breadcrumb.length > 0) {
      const newBreadcrumb = breadcrumb.slice(0, -1);
      setBreadcrumb(newBreadcrumb);
      setCurrentFolderId(newBreadcrumb[newBreadcrumb.length - 1]?.id ?? null);
    }
  };

  const handleCreateFolder = async () => {
    const name = prompt('Enter folder name:');
    if (name && name.trim()) {
      try {
        await api.createFolder(name.trim(), currentFolderId);
        loadContents();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create folder');
      }
    }
  };

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    
    if (event.relatedTarget) {
      const currentTarget = event.currentTarget as HTMLElement;
      const relatedTarget = event.relatedTarget as HTMLElement;
      if (currentTarget.contains(relatedTarget)) {
        return;
      }
    }
    
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  const uploadWithThumbnail = async (file: File): Promise<void> => {
    const isImageOrVideo = file.type.startsWith('image/') || file.type.startsWith('video/');
    
    const result = await api.uploadFile(file, currentFolderId ?? undefined);
    console.log('[Upload] File uploaded:', result.file_id, result.filename);
    
    if (isImageOrVideo) {
      const thumbBlob = await generateThumbnail(file, 200);
      if (thumbBlob) {
        console.log('[Thumb] Generated thumbnail, size:', thumbBlob.size);
        try {
          const thumbResult = await api.uploadThumbnail(thumbBlob);
          console.log('[Thumb] Uploaded to Telegram, message_id:', thumbResult.message_id, 'data_len:', thumbResult.thumbnail_data?.length);
          await api.updateFile(result.file_id, thumbResult.message_id, thumbResult.thumbnail_data);
          console.log('[Thumb] Updated file with thumbnail_message_id and thumbnail_data');
        } catch (err: any) {
          console.error('[Thumb] Upload failed:', err?.response?.data || err.message);
        }
      } else {
        console.log('[Thumb] generateThumbnail returned null for:', file.name);
      }
    }
  };

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);

    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    const initialFiles = droppedFiles.map((f) => ({
      name: f.name,
      progress: 0,
      status: 'uploading' as const,
    }));
    setUploadingFiles(initialFiles);

    const results: Array<{ name: string; progress: number; status: 'uploading' | 'complete' | 'error'; error?: string }> = initialFiles.map((f) => ({
      ...f,
      status: 'uploading' as const,
    }));

    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i];
      try {
        await uploadWithThumbnail(file);
        results[i] = { name: file.name, progress: 100, status: 'complete' };
      } catch (err: any) {
        results[i] = {
          name: file.name,
          progress: 0,
          status: 'error',
          error: err instanceof Error ? err.message : 'Upload failed',
        };
      }
      setUploadingFiles([...results]);
    }

    loadContents();
  }, [currentFolderId, loadContents, uploadWithThumbnail]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length === 0) return;

    const initialFiles = selectedFiles.map((f) => ({
      name: f.name,
      progress: 0,
      status: 'uploading' as const,
    }));
    setUploadingFiles(initialFiles);

    const results: Array<{ name: string; progress: number; status: 'uploading' | 'complete' | 'error'; error?: string }> = [...initialFiles];

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      try {
        await uploadWithThumbnail(file);
        results[i] = { name: file.name, progress: 100, status: 'complete' };
      } catch (err: any) {
        results[i] = {
          name: file.name,
          progress: 0,
          status: 'error',
          error: err instanceof Error ? err.message : 'Upload failed',
        };
      }
      setUploadingFiles([...results]);
    }

    loadContents();
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div
      style={{ height: '100%', overflow: 'auto', padding: '16px', position: 'relative' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(59, 130, 246, 0.15)',
            border: '3px dashed #3b82f6',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            pointerEvents: 'none', // Overlay doesn't capture drag events - parent handles them
          }}
        >
          <span style={{ fontSize: '20px', fontWeight: 600, color: '#3b82f6' }}>
            Drop files to upload
          </span>
        </div>
      )}

      {uploadingFiles.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: '16px',
            right: '16px',
            background: 'white',
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            padding: '12px 16px',
            minWidth: '240px',
            maxWidth: '320px',
            zIndex: 50,
          }}
        >
          {uploadingFiles.map((f, i) => (
            <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: i < uploadingFiles.length - 1 ? '6px' : 0 }}>
              {f.status === 'complete' && <span style={{ color: '#16a34a', fontSize: '14px' }}>✓</span>}
              {f.status === 'error' && <span style={{ color: '#dc2626', fontSize: '14px' }}>✗</span>}
              {f.status === 'uploading' && <span style={{ color: '#3b82f6', fontSize: '14px' }}>↑</span>}
              <span style={{ fontSize: '13px', color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.name}
              </span>
              {f.status === 'uploading' && <span style={{ fontSize: '11px', color: '#6b7280' }}>Uploading...</span>}
              {f.status === 'complete' && <span style={{ fontSize: '11px', color: '#16a34a' }}>Uploaded</span>}
              {f.status === 'error' && <span style={{ fontSize: '11px', color: '#dc2626' }}>{f.error}</span>}
            </div>
          ))}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: '12px',
          fontSize: '16px',
          fontWeight: 600,
          color: '#374151',
        }}
      >
        {breadcrumb.length > 0 && (
          <button
            onClick={handleBack}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#6b7280',
              fontSize: '14px',
              padding: '4px 8px',
              marginRight: '8px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
            }}
            title="Go back"
          >
            ← Back
          </button>
        )}
        
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
          }}
        >
          {/* Root segment - always visible */}
          <button
            onClick={() => handleNavigateToBreadcrumb(0)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#3b82f6',
              fontSize: '16px',
              padding: '0',
              fontWeight: 600,
            }}
          >
            Root
          </button>
          
          {/* Breadcrumb segments */}
          {breadcrumb.map((folder, index) => (
            <span key={folder.id} style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ color: '#9ca3af', margin: '0 8px' }}>/</span>
              <button
                onClick={() => handleNavigateToBreadcrumb(index + 1)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: index === breadcrumb.length - 1 ? '#374151' : '#3b82f6',
                  fontSize: '16px',
                  padding: '0',
                  fontWeight: index === breadcrumb.length - 1 ? 600 : 400,
                }}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </span>

        <button
          onClick={() => setViewMode((v) => (v === 'grid' ? 'list' : 'grid'))}
          style={{
            background: '#3b82f6',
            border: 'none',
            cursor: 'pointer',
            color: 'white',
            fontSize: '14px',
            padding: '8px 16px',
            borderRadius: '6px',
            marginLeft: '16px',
            fontWeight: 500,
          }}
        >
          {viewMode === 'grid' ? '☰ List' : '⊞ Grid'}
        </button>

        <button
          onClick={handleCreateFolder}
          style={{
            background: '#3b82f6',
            border: 'none',
            cursor: 'pointer',
            color: 'white',
            fontSize: '14px',
            padding: '8px 16px',
            borderRadius: '6px',
            marginLeft: '8px',
            fontWeight: 500,
          }}
        >
          + New Folder
        </button>

        <button
          onClick={handleUploadClick}
          style={{
            background: '#16a34a',
            border: 'none',
            cursor: 'pointer',
            color: 'white',
            fontSize: '14px',
            padding: '8px 16px',
            borderRadius: '6px',
            marginLeft: '8px',
            fontWeight: 500,
          }}
        >
          ↑ Upload Files
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      {error && (
        <div
          style={{
            padding: '12px 16px',
            background: '#fee2e2',
            borderRadius: '6px',
            color: '#dc2626',
            marginBottom: '12px',
            fontSize: '13px',
          }}
        >
          {error}
        </div>
      )}

      {loading && files.length === 0 && (
        <div style={{ padding: '20px', textAlign: 'center', color: '#6b7280', fontSize: '14px' }}>
          Loading...
        </div>
      )}

      {files.length === 0 && !loading && !error && (
        <div
          style={{
            padding: '40px',
            textAlign: 'center',
            color: '#6b7280',
            border: '2px dashed #e5e7eb',
            borderRadius: '8px',
          }}
        >
          <p style={{ fontSize: '16px', margin: '0 0 8px 0' }}>This folder is empty</p>
          <p style={{ fontSize: '13px', margin: 0 }}>Upload files or create folders to get started</p>
        </div>
      )}

      {files.length > 0 && (
        <div style={{
          display: viewMode === 'grid' ? 'grid' : 'flex',
          gridTemplateColumns: viewMode === 'grid' ? 'repeat(auto-fill, minmax(150px, 1fr))' : undefined,
          flexDirection: viewMode === 'grid' ? undefined : 'column',
          gap: '8px',
        }}>
          {files.map((file) => {
            const original = originalFiles.find((f) => f.file_id === file.id);
            const isImage = original?.mime_type?.startsWith('image/');
            const isVideo = original?.mime_type?.startsWith('video/');
            const thumbnailUrl = original ? thumbnails[original.file_id] : null;
            
            return (
              <div
                key={file.id}
                style={{
                  display: 'flex',
                  alignItems: viewMode === 'grid' ? 'center' : 'center',
                  flexDirection: viewMode === 'grid' ? 'column' : 'row',
                  padding: viewMode === 'grid' ? '12px' : '12px',
                  background: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                  cursor: file.isDir ? 'pointer' : 'default',
                  textAlign: viewMode === 'grid' ? 'center' : 'left',
                }}
                onClick={() => {
                  if (file.isDir) {
                    setCurrentFolderId(file.id);
                    setBreadcrumb((prev) => [...prev, file]);
                  }
                }}
              >
                <div style={{
                  width: viewMode === 'grid' ? '80px' : '40px',
                  height: viewMode === 'grid' ? '80px' : '40px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: (isImage || isVideo) ? '#f3f4f6' : 'transparent',
                  borderRadius: '4px',
                  marginRight: viewMode === 'grid' ? 0 : '12px',
                  marginBottom: viewMode === 'grid' ? '8px' : 0,
                  overflow: 'hidden',
                  position: 'relative',
                }}>
                  {file.isDir ? (
                    <span style={{ fontSize: viewMode === 'grid' ? '40px' : '20px' }}>📁</span>
                  ) : (isImage || isVideo) && thumbnailUrl ? (
                    <>
                      <img 
                        src={thumbnailUrl} 
                        alt={file.name}
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }}
                      />
                      {isVideo && (
                        <span style={{
                          position: 'absolute',
                          fontSize: '16px',
                        }}>▶️</span>
                      )}
                    </>
                  ) : (isImage || isVideo) ? (
                    <span style={{ fontSize: viewMode === 'grid' ? '40px' : '20px' }}>
                      {isVideo ? '🎬' : '🖼️'}
                    </span>
                  ) : (
                    <span style={{ fontSize: viewMode === 'grid' ? '40px' : '20px' }}>📄</span>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ 
                    fontSize: '14px', 
                    color: '#374151',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: viewMode === 'grid' ? 'nowrap' : 'normal',
                  }}>
                    {file.name}
                  </div>
                  {!file.isDir && file.size && (
                    <div style={{ fontSize: '12px', color: '#6b7280' }}>
                      {formatFileSize(file.size)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
