import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FileBrowser,
  ChonkyActions,
  DefaultFileActions,
  FileData,
  GenericFileActionHandler,
  ChonkyActionUnion,
} from '@aperturerobotics/chonky';
import { ChonkyIconFA } from '@aperturerobotics/chonky-icon-fontawesome';
import { api } from '../api/client';
import { FileInfo } from '../types';

export function ChonkyDrive() {
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<FileData[]>([]);
  const [files, setFiles] = useState<FileData[]>([]);
  const [originalFiles, setOriginalFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Drag-and-drop state
  const dragCounter = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<
    Array<{ name: string; progress: number; status: 'uploading' | 'complete' | 'error'; error?: string }>
  >([]);

  const loadContents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [filesResponse, foldersResponse] = await Promise.all([
        api.listFiles(1, 50, currentFolderId ?? undefined),
        api.listFolders(currentFolderId),
      ]);

      const fileEntries: FileData[] = [
        ...foldersResponse.files.map((f: FileInfo): FileData => ({
          id: f.file_id,
          name: f.filename,
          isDir: true,
          parentId: f.parent_id ?? undefined,
        })),
        ...filesResponse.files.map((f: FileInfo): FileData => ({
          id: f.file_id,
          name: f.filename,
          isDir: false,
          size: f.filesize,
          modDate: new Date(f.created_at),
          thumbnailUrl: undefined,
        })),
      ];

      const allOriginal: FileInfo[] = [...foldersResponse.files, ...filesResponse.files];
      setFiles(fileEntries);
      setOriginalFiles(allOriginal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
      setFiles([]);
      setOriginalFiles([]);
    } finally {
      setLoading(false);
    }
  }, [currentFolderId]);

  useEffect(() => {
    loadContents();
  }, [loadContents]);

  const handleFileAction: GenericFileActionHandler<ChonkyActionUnion> = useCallback(
    ({ action, payload }) => {
      if (action.id === ChonkyActions.OpenFiles.id) {
        const targetFile = (payload as { targetFile?: FileData }).targetFile;
        if (targetFile?.isDir) {
          setCurrentFolderId(targetFile.id);
          setBreadcrumb((prev) => [...prev, targetFile]);
        }
      }
    },
    []
  );

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

  const handleDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    dragCounter.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    dragCounter.current = 0;

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
        await api.uploadFile(file, currentFolderId ?? undefined);
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
  };

  const allActions = [...DefaultFileActions];

  const currentFolderName =
    currentFolderId === null
      ? 'Root'
      : breadcrumb.length > 0
      ? breadcrumb[breadcrumb.length - 1].name
      : 'Folder';

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
            position: 'absolute',
            inset: 0,
            background: 'rgba(59, 130, 246, 0.15)',
            border: '3px dashed #3b82f6',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
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
        <FileBrowser
          files={files}
          folderChain={currentFolderId !== null ? [{ id: currentFolderId, name: currentFolderName, isDir: true }] : []}
          onFileAction={handleFileAction}
          fileActions={allActions}
          iconComponent={ChonkyIconFA}
          disableDragAndDrop
          defaultFileViewActionId={
            viewMode === 'grid'
              ? ChonkyActions.EnableGridView.id
              : ChonkyActions.EnableListView.id
          }
          thumbnailGenerator={(file: FileData) => {
            const original = originalFiles.find((f) => f.file_id === file.id);
            if (!original) return null;
            if (original.file_type === 'photo' || original.mime_type?.startsWith('image/')) {
              return original.direct_url || null;
            }
            return null;
          }}
        />
      )}
    </div>
  );
}
