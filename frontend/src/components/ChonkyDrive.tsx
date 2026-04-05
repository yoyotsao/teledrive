import { useState, useEffect, useCallback, useRef } from 'react';
import { FileData } from '@aperturerobotics/chonky';
import { api, generateThumbnail } from '../api/client';
import { getTelegramClient } from '../lib/gramjs';
import { generateVideoThumbnail } from '../lib/videoThumbnail';
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

  // Preview state
  const [previewFile, setPreviewFile] = useState<FileInfo | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Selection state
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const lastSelectedRef = useRef<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [isDraggingInternal, setIsDraggingInternal] = useState(false);

  const dragCounterRef = useRef(0);
  const isDraggingRef = useRef(false); // Track external file drag for upload
  const [uploadingFiles, setUploadingFiles] = useState<
    Array<{ name: string; progress: number; status: 'uploading' | 'complete' | 'error'; error?: string }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadThumbnails = useCallback(async (files: FileInfo[]) => {
    const imageOrVideoFiles = files.filter(
      (f) => f.mime_type?.startsWith('image/') || f.mime_type?.startsWith('video/')
    );
    
    // Get Telegram client
    let telegramClient: ReturnType<typeof getTelegramClient>;
    try {
      telegramClient = getTelegramClient();
      if (!telegramClient.isConnected()) {
        console.log('[Thumb] Telegram client not connected, skipping thumbnails');
        return;
      }
    } catch (err) {
      console.log('[Thumb] Telegram client not available:', err);
      return;
    }
    
    for (const file of imageOrVideoFiles) {
      if (!thumbnails[file.file_id]) {
        // Try to load thumbnail from Telegram
        try {
          console.log(`[Thumb] Loading thumbnail for ${file.filename} (file_id=${file.file_id}, type=${file.file_type})...`);
          
          let thumbUrl: string | null = null;
          
          // For videos: use thumbnail_message_id if available
          if (file.file_type === 'video') {
            const thumbMsgId = (file as any).thumbnail_message_id;
            if (thumbMsgId) {
              const thumbBlob = await telegramClient.downloadThumbnail(thumbMsgId);
              thumbUrl = URL.createObjectURL(thumbBlob);
              console.log(`[Thumb] Downloaded video thumbnail for ${file.filename}:`, thumbUrl);
            } else {
              console.log(`[Thumb] No thumbnail_message_id for video ${file.filename}`);
            }
          } 
          // For photos (images): use the original file as thumbnail
          else if (file.file_type === 'photo' || file.mime_type?.startsWith('image/')) {
            const msgId = (file as any).telegram_message_id;
            if (msgId) {
              const mimeType = file.mime_type || 'image/jpeg';
              const thumbBlob = await telegramClient.downloadFile(msgId, mimeType);
              thumbUrl = URL.createObjectURL(thumbBlob);
              console.log(`[Thumb] Downloaded image thumbnail for ${file.filename}:`, thumbUrl);
            }
          }
          
          if (thumbUrl) {
            setThumbnails((prev) => ({ ...prev, [file.file_id]: thumbUrl }));
          }
        } catch (err: any) {
          console.log(`[Thumb] Error for ${file.filename}:`, err?.response?.data || err.message);
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
      
      // 去重：根據檔名去重，但 split file 需要保留所有 parts
      // 使用 split_group_id + filename 來判斷是否為同一個分割檔案
      const seenKeys = new Set<string>();
      const uniqueFiles = allOriginal.reverse().filter((f) => {
        // 如果是分割檔案，使用 split_group_id 作為 key
        const isSplitFile = (f as any).is_split_file && (f as any).split_group_id;
        const key = isSplitFile ? `split:${(f as any).split_group_id}` : `normal:${f.filename}`;
        
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
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

  // Handle keyboard delete
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.key === 'Delete' && selectedFiles.size > 0) {
        event.preventDefault();
        const confirmed = confirm(`Delete ${selectedFiles.size} selected file(s)?`);
        if (!confirmed) return;

        try {
          for (const fileId of selectedFiles) {
            await api.deleteFile(fileId);
          }
          setSelectedFiles(new Set());
          loadContents();
        } catch (err) {
          console.error('Failed to delete files:', err);
          setError(err instanceof Error ? err.message : 'Failed to delete files');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedFiles, loadContents]);

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
    isDraggingRef.current = true;
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
      isDraggingRef.current = false;
    }
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  const uploadWithThumbnail = async (file: File): Promise<void> => {
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const isImageOrVideo = isImage || isVideo;
    
    // Step 1: Upload file using split upload to Telegram via GramJS
    const telegramClient = getTelegramClient();
    console.log('[Upload] Starting split upload for:', file.name);
    const uploadResult = await telegramClient.uploadFileSplit(file);
    console.log('[Upload] Split upload completed, parts:', uploadResult.parts.length);
    
    // Generate split_group_id for this file
    const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    // Step 2: Register each part with backend
    for (let i = 0; i < uploadResult.parts.length; i++) {
      const part = uploadResult.parts[i];
      
      await api.registerFile({
        filename: file.name,  // Use original filename for all parts
        filesize: part.size,
        mimeType: file.type || undefined,
        messageId: part.message_id,
        fileId: part.file_id,
        accessHash: part.access_hash,
        parentId: currentFolderId ?? undefined,
        isSplitFile: true,
        splitGroupId: splitGroupId,
        partIndex: i,
        totalParts: uploadResult.parts.length,
        originalName: file.name,  // Store original name for all parts
      });
    }
    console.log('[Upload] All parts registered with split_group_id:', splitGroupId);
    
    // Step 3: Upload thumbnail if needed
    if (isImageOrVideo) {
      if (isVideo) {
        // For videos: generate thumbnail client-side using FFmpeg WASM, then upload via GramJS
        console.log('[Thumb] Generating video thumbnail via FFmpeg WASM for:', file.name);
        try {
          const thumbBlob = await generateVideoThumbnail(file);
          console.log('[Thumb] Generated thumbnail, size:', thumbBlob.size);
          const thumbResult = await telegramClient.uploadThumbnail(thumbBlob, 'thumbnail.jpg');
          console.log('[Thumb] Uploaded to Telegram via GramJS, message_id:', thumbResult.message_id);
          // Update first part with thumbnail
          await api.updateFile(uploadResult.parts[0].file_id, thumbResult.message_id);
          console.log('[Thumb] Updated file with video thumbnail metadata');
        } catch (err: any) {
          console.error('[Thumb] Video thumbnail generation failed:', err?.response?.data || err.message);
        }
      } else {
        // For images: generate thumbnail client-side and upload via GramJS
        const thumbBlob = await generateThumbnail(file, 200);
        if (thumbBlob) {
          console.log('[Thumb] Generated thumbnail, size:', thumbBlob.size);
          try {
            const thumbResult = await telegramClient.uploadThumbnail(thumbBlob, 'thumbnail.jpg');
            console.log('[Thumb] Uploaded to Telegram via GramJS, message_id:', thumbResult.message_id);
            // Update first part with thumbnail
            await api.updateFile(uploadResult.parts[0].file_id, thumbResult.message_id);
            console.log('[Thumb] Updated file with thumbnail_message_id');
          } catch (err: any) {
            console.error('[Thumb] Upload failed:', err?.response?.data || err.message);
          }
        } else {
          console.log('[Thumb] generateThumbnail returned null for:', file.name);
        }
      }
    }
  };

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    dragCounterRef.current = 0;
    isDraggingRef.current = false;

    // Skip if this is an internal file drag (not external file drop)
    // Internal drags use custom MIME type
    const dragData = event.dataTransfer.getData('application/x-teledrive-file-id');
    if (dragData) {
      // This is an internal file drag - let the folder drop handler deal with it
      return;
    }

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
  }, [currentFolderId, loadContents, uploadWithThumbnail, isDraggingInternal]);

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

  // Selection handlers
  const handleFileClick = useCallback((file: FileData, event: React.MouseEvent) => {
    const fileId = file.id;
    
    if (event.ctrlKey || event.metaKey) {
      // Ctrl+Click: toggle multi-select
      setSelectedFiles((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(fileId)) {
          newSet.delete(fileId);
        } else {
          newSet.add(fileId);
        }
        return newSet;
      });
      lastSelectedRef.current = fileId;
    } else if (event.shiftKey && lastSelectedRef.current !== null) {
      // Shift+Click: range select from last selected to current
      const lastIndex = files.findIndex((f) => f.id === lastSelectedRef.current);
      const currentIndex = files.findIndex((f) => f.id === fileId);
      
      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        
        const rangeIds = files.slice(start, end + 1).map((f) => f.id);
        setSelectedFiles(new Set([...selectedFiles, ...rangeIds]));
      }
    } else {
      // Plain click: select single file
      if (selectedFiles.has(fileId) && selectedFiles.size === 1) {
        // If already selected and clicking same file, deselect it
        setSelectedFiles(new Set());
      } else {
        setSelectedFiles(new Set([fileId]));
      }
      lastSelectedRef.current = fileId;
    }
  }, [files, selectedFiles]);

  // Drag handlers for file items
  const handleFileDragStart = useCallback((file: FileData, event: React.DragEvent) => {
    console.log('[DragStart] Starting drag for file:', file.id, file.name, 'isDir:', file.isDir);
    
    // Only allow dragging files (not folders)
    if (file.isDir) {
      event.preventDefault();
      return;
    }
    
    // Set drag data with custom type to distinguish from external file drops
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.dropEffect = 'move';
    event.dataTransfer.setData('application/x-teledrive-file-id', file.id);
    setIsDraggingInternal(true);
    
    // If file is not selected, select just this file
    if (!selectedFiles.has(file.id)) {
      setSelectedFiles(new Set([file.id]));
    }
  }, [selectedFiles]);

  const handleFileDragEnd = useCallback(() => {
    setIsDraggingInternal(false);
  }, []);

  const handleFolderDragEnter = useCallback((folderId: string, event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverFolderId(folderId);
  }, []);

  const handleFolderDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverFolderId(null);
  }, []);

  const handleFolderDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleFolderDrop = useCallback(async (folderId: string, event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverFolderId(null);
    console.log('[Drop] handleFolderDrop called, folderId:', folderId);

    // Get selected file IDs (from selection or from drag data)
    const selectedIds = Array.from(selectedFiles);
    console.log('[Drop] selectedIds from state:', selectedIds);
    
    if (selectedIds.length === 0) {
      // Check for internal file drag
      const dragData = event.dataTransfer.getData('application/x-teledrive-file-id');
      console.log('[Drop] dragData from dataTransfer:', dragData);
      if (dragData) {
        selectedIds.push(dragData);
      }
    }

    if (selectedIds.length === 0) {
      console.log('[Drop] No files to move, returning');
      return;
    }

    // Move all selected files to the target folder
    try {
      console.log('[Drop] Moving files:', selectedIds, 'to folder:', folderId);
      for (const fileId of selectedIds) {
        await api.moveFile(fileId, folderId);
      }
      // Clear selection and reload contents
      setSelectedFiles(new Set());
      lastSelectedRef.current = null;
      loadContents();
    } catch (err) {
      console.error('Failed to move files:', err);
      setError(err instanceof Error ? err.message : 'Failed to move files');
    }
  }, [selectedFiles, loadContents]);

  // Double-click handler for folder navigation and file preview
  const handleFileDoubleClick = useCallback(async (file: FileData) => {
    if (file.isDir) {
      // Double-click folder to navigate into it
      setCurrentFolderId(file.id);
      setBreadcrumb((prev) => [...prev, file]);
    } else {
      // Double-click file to preview
      const original = originalFiles.find((f) => f.file_id === file.id);
      if (original) {
        // Show preview modal immediately without waiting for download
        setPreviewFile(original);
        
        const mimeType = original.mime_type || 'application/octet-stream';
        
        // For videos: use streaming player, don't wait for full download
        if (mimeType.startsWith('video/')) {
          console.log('[Preview] Video file - using streaming player');
          // StreamingVideoPlayer will handle the download
          // We set previewUrl to null so the StreamingVideoPlayer component renders
          setPreviewUrl(null);
        } else {
          // For non-videos: download completely first
          try {
            const telegramClient = getTelegramClient();
            if (!telegramClient.isConnected()) {
              console.error('[Preview] Telegram client not connected');
              return;
            }
            
            let blob: Blob;
            
            // Check if this is a split file
            if ((original as any).is_split_file && (original as any).split_group_id) {
              console.log('[Preview] Downloading split file, group:', (original as any).split_group_id);
              blob = await telegramClient.downloadFileMerge((original as any).split_group_id, mimeType);
              console.log('[Preview] Merged split file, size:', blob.size);
            } else {
              // Download single file
              const msgId = original.telegram_message_id;
              if (!msgId) {
                console.error('[Preview] No telegram_message_id for file');
                return;
              }
              blob = await telegramClient.downloadFile(msgId, mimeType);
            }
            
            // Store blob reference globally to prevent GC
            (window as any).__previewBlob = blob;
            const url = URL.createObjectURL(blob);
            console.log('[Preview] Created blob URL:', url, 'blob size:', blob.size, 'blob type:', blob.type);
            setPreviewUrl(url);
            console.log('[Preview] Set previewUrl for:', original.filename);
          } catch (err) {
            console.error('[Preview] Error downloading file:', err);
          }
        }
      }
    }
  }, [originalFiles]);

  // Close preview modal
  const closePreview = useCallback(() => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewFile(null);
    setPreviewUrl(null);
  }, [previewUrl]);

  return (
    <div
      style={{ height: '100%', overflow: 'auto', padding: '16px', position: 'relative' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >

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
          gridTemplateColumns: viewMode === 'grid' ? 'repeat(auto-fill, minmax(225px, 1fr))' : undefined,
          flexDirection: viewMode === 'grid' ? undefined : 'column',
          gap: '12px',
        }}>
          {files.map((file) => {
            const original = originalFiles.find((f) => f.file_id === file.id);
            const isImage = original?.mime_type?.startsWith('image/');
            const isVideo = original?.mime_type?.startsWith('video/');
            const thumbnailUrl = original ? thumbnails[original.file_id] : null;
            const isSelected = selectedFiles.has(file.id);
            const isDragOver = dragOverFolderId === file.id;
            
            return (
              <div
                key={file.id}
                draggable={!file.isDir}
                onDragStart={(e) => handleFileDragStart(file, e)}
                onDragEnd={handleFileDragEnd}
                style={{
                  display: 'flex',
                  alignItems: viewMode === 'grid' ? 'center' : 'center',
                  flexDirection: viewMode === 'grid' ? 'column' : 'row',
                  padding: viewMode === 'grid' ? '12px' : '12px',
                  background: isSelected ? '#eff6ff' : 'white',
                  border: isSelected ? '2px solid #3b82f6' : (isDragOver ? '2px dashed #3b82f6' : '1px solid #e5e7eb'),
                  borderRadius: '8px',
                  cursor: file.isDir ? 'pointer' : (isSelected ? 'grab' : 'default'),
                  textAlign: viewMode === 'grid' ? 'center' : 'left',
                  opacity: !file.isDir && isSelected ? 0.8 : 1,
                  transition: 'all 0.15s ease',
                  transform: isDragOver ? 'scale(1.02)' : undefined,
                  boxShadow: isSelected ? '0 2px 8px rgba(59, 130, 246, 0.15)' : (isDragOver ? '0 4px 12px rgba(59, 130, 246, 0.2)' : undefined),
                }}
                onClick={(e) => {
                  // Single click: select file/folder (no navigation for folders)
                  handleFileClick(file, e);
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleFileDoubleClick(file);
                }}
                {...(file.isDir ? {
                  onDragEnter: (e: React.DragEvent) => handleFolderDragEnter(file.id, e),
                  onDragLeave: handleFolderDragLeave,
                  onDragOver: handleFolderDragOver,
                  onDrop: (e: React.DragEvent) => handleFolderDrop(file.id, e),
                } : {})}
              >
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  flex: viewMode === 'grid' ? undefined : 1,
                  flexDirection: viewMode === 'grid' ? 'column' : 'row',
                  width: viewMode === 'grid' ? '100%' : undefined,
                }}>
                  <div style={{
                    width: viewMode === 'grid' ? '120px' : '40px',
                    height: viewMode === 'grid' ? '120px' : '40px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: (isImage || isVideo) ? '#f3f4f6' : 'transparent',
                    borderRadius: '4px',
                    marginRight: viewMode === 'grid' ? 0 : '12px',
                    marginBottom: viewMode === 'grid' ? '12px' : 0,
                    overflow: 'hidden',
                    position: 'relative',
                  }}>
                    {file.isDir ? (
                      <span style={{ fontSize: viewMode === 'grid' ? '60px' : '20px' }}>📁</span>
                    ) : (isImage || isVideo) && thumbnailUrl ? (
                      <>
                        <img 
                          src={thumbnailUrl} 
                          alt={file.name}
                          loading="lazy"
                          decoding="async"
                          width={viewMode === 'grid' ? 120 : 40}
                          height={viewMode === 'grid' ? 120 : 40}
                          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }}
                        />
                        {isVideo && (
                          <span style={{
                            position: 'absolute',
                            fontSize: '24px',
                          }}>▶️</span>
                        )}
                      </>
                    ) : (isImage || isVideo) ? (
                      <span style={{ fontSize: viewMode === 'grid' ? '60px' : '20px' }}>
                        {isVideo ? '🎬' : '🖼️'}
                      </span>
                    ) : (
                      <span style={{ fontSize: viewMode === 'grid' ? '60px' : '20px' }}>📄</span>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ 
                      fontSize: '14px', 
                      color: '#374151',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {file.name}
                    </div>
                    {!file.isDir && file.size && viewMode !== 'grid' && (
                      <div style={{ fontSize: '12px', color: '#6b7280' }}>
                        {formatFileSize(file.size)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Preview Modal */}
      {previewFile && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={closePreview}
        >
          <div
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              background: 'white',
              borderRadius: '8px',
              overflow: 'hidden',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={closePreview}
              style={{
                position: 'absolute',
                top: '8px',
                right: '8px',
                background: 'rgba(0, 0, 0, 0.5)',
                color: 'white',
                border: 'none',
                borderRadius: '50%',
                width: '32px',
                height: '32px',
                cursor: 'pointer',
                fontSize: '18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1001,
              }}
            >
              ✕
            </button>
            
            {/* Download button */}
            <button
              onClick={async () => {
                // Trigger download with correct filename
                try {
                  const telegramClient = getTelegramClient();
                  const mimeType = previewFile.mime_type || 'application/octet-stream';
                  let blob: Blob;
                  
                  // Check if this is a split file
                  if ((previewFile as any).is_split_file && (previewFile as any).split_group_id) {
                    blob = await telegramClient.downloadFileMerge((previewFile as any).split_group_id, mimeType);
                  } else {
                    const msgId = previewFile.telegram_message_id;
                    if (!msgId) {
                      console.error('[Download] No telegram_message_id for file');
                      return;
                    }
                    blob = await telegramClient.downloadFile(msgId, mimeType);
                  }
                  
                  // Use original_name for split files, otherwise filename
                  const downloadFilename = (previewFile as any).original_name || previewFile.filename;
                  
                  // Create download link and trigger
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = downloadFilename;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  console.log('[Download] Downloaded file:', downloadFilename);
                } catch (err) {
                  console.error('[Download] Error downloading file:', err);
                }
              }}
              style={{
                position: 'absolute',
                top: '8px',
                right: '48px',
                background: 'rgba(0, 0, 0, 0.5)',
                color: 'white',
                border: 'none',
                borderRadius: '50%',
                width: '32px',
                height: '32px',
                cursor: 'pointer',
                fontSize: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1001,
              }}
              title="Download"
            >
              ↓
            </button>
            
            {/* File name */}
            <div style={{ 
              padding: '12px 16px', 
              borderBottom: '1px solid #e5e7eb',
              fontSize: '14px',
              fontWeight: 500,
              color: '#374151',
            }}>
              {previewFile.filename}
            </div>
            
            {/* Content: Image or Video */}
            <div style={{ padding: '8px' }}>
              {previewFile.mime_type?.startsWith('image/') ? (
                <img
                  src={previewUrl ?? undefined}
                  alt={previewFile.filename}
                  loading="lazy"
                  decoding="async"
                  style={{
                    minWidth: '200px',
                    minHeight: '200px',
                    maxWidth: '100%',
                    maxHeight: 'calc(90vh - 100px)',
                    objectFit: 'contain',
                  }}
                />
              ) : previewFile.mime_type?.startsWith('video/') ? (
                <video
                  src={`/preview-video/${previewFile.file_id}/${previewFile.telegram_message_id}`}
                  controls
                  autoPlay
                  style={{ maxWidth: '100%', maxHeight: 'calc(90vh - 100px)' }}
                />
              ) : (
                <div style={{ padding: '40px', textAlign: 'center', color: '#6b7280' }}>
                  Preview not available for this file type
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Simple loading indicator for video preview via Service Worker streaming
function VideoPreviewLoader({ fileId, messageId }: { fileId: string; messageId: number; mimeType?: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = document.createElement('video');
    video.src = `/preview-video/${fileId}/${messageId}`;
    
    const onCanPlay = () => {
      setLoading(false);
    };
    
    const onError = () => {
      setLoading(false);
      setError('Failed to load video');
    };
    
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('error', onError);
    
    // Timeout - assume it works if no error after 3s
    const timeout = setTimeout(() => setLoading(false), 3000);
    
    return () => {
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('error', onError);
      clearTimeout(timeout);
    };
  }, [fileId, messageId]);

  return (
    <div style={{ padding: '8px', minHeight: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {loading && (
        <div style={{ textAlign: 'center', color: '#6b7280' }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>⏳</div>
          <div>Loading video...</div>
        </div>
      )}
      {error && (
        <div style={{ color: '#dc2626', textAlign: 'center' }}>{error}</div>
      )}
      <video
        src={`/preview-video/${fileId}/${messageId}`}
        controls
        autoPlay
        style={{ maxWidth: '100%', maxHeight: 'calc(90vh - 100px)', display: loading ? 'none' : 'block' }}
      />
    </div>
  );
}

export { VideoPreviewLoader };