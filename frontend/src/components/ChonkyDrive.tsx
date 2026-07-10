import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../api/client';
import { sha256File } from '../lib/hashFile';
import { getTelegramClient } from '../lib/gramjs';
import { captureThumb } from '../lib/thumbCapture';
import { getCachedThumbnail, setCachedThumbnail } from '../lib/thumbnailCache';
import { FileInfo, FileData } from '../types';
import { Semaphore } from '../lib/semaphore';
import { MAX_CONCURRENT_FILES } from '../config';
import { planUploads, registerDuplicateParts, hashFileBounded, PlannedFile } from '../lib/uploadPlanner';


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
  // O(1) lookup instead of `originalFiles.find(...)` inside the render loop (O(n) per card = O(n^2) per render)
  const originalFilesById = useMemo(() => new Map(originalFiles.map((f) => [f.file_id, f])), [originalFiles]);
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
  const [dragOverBreadcrumbId, setDragOverBreadcrumbId] = useState<string | null>(null);
  const [isDraggingInternal, setIsDraggingInternal] = useState(false);

  const dragCounterRef = useRef(0);
  const isDraggingRef = useRef(false); // Track external file drag for upload
  const pendingThumbsRef = useRef<Set<string>>(new Set());
  const thumbnailAbortRef = useRef<AbortController | null>(null);

  const PAGE_SIZE = 200;
  const currentPageRef = useRef(1);
  const hasMoreRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [uploadingFiles, setUploadingFiles] = useState<
    Array<{ name: string; progress: number; status: 'uploading' | 'complete' | 'error'; error?: string }>
  >([]);
  const [uploadTotals, setUploadTotals] = useState<{ total: number; done: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Box select state
  const boxSelectStartRef = useRef<{ x: number; y: number } | null>(null);
  const boxSelectActivatedRef = useRef(false);
  const [boxSelectRect, setBoxSelectRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const fileCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const loadThumbnails = useCallback(async (files: FileInfo[], signal?: AbortSignal) => {
    const thumbFiles = files.filter(
      (f) => (f.mime_type?.startsWith('image/') || f.mime_type?.startsWith('video/'))
             && f.has_thumbnail
             && f.telegram_message_id
             && !pendingThumbsRef.current.has(f.file_id)
    );
    if (thumbFiles.length === 0) return;
    thumbFiles.forEach((f) => pendingThumbsRef.current.add(f.file_id));

    // 1. Check IndexedDB cache for all files in parallel (bounded) — instant hits show immediately
    const cacheCheckSemaphore = new Semaphore(6);
    const misses: FileInfo[] = [];
    await Promise.all(thumbFiles.map((file) => cacheCheckSemaphore.withSlot(async () => {
      if (signal?.aborted) return;
      try {
        const cached = await getCachedThumbnail(file.file_id);
        if (cached) {
          setThumbnails((prev) => ({ ...prev, [file.file_id]: URL.createObjectURL(cached) }));
        } else {
          misses.push(file);
        }
      } catch {
        misses.push(file);
      }
    })));

    if (signal?.aborted || misses.length === 0) return;

    // 2. Cache misses → one getMessages round trip for the whole batch, then parallel downloadMedia
    const messageIdToFile = new Map(misses.map((f) => [f.telegram_message_id!, f]));
    try {
      const blobs = await getTelegramClient().downloadThumbnails(Array.from(messageIdToFile.keys()));
      for (const [messageId, blob] of blobs) {
        const file = messageIdToFile.get(messageId);
        if (!file || signal?.aborted) continue;
        setCachedThumbnail(file.file_id, blob).catch(() => {});
        setThumbnails((prev) => ({ ...prev, [file.file_id]: URL.createObjectURL(blob) }));
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('[Thumb] Batch download error:', err?.message);
      }
    } finally {
      misses.forEach((f) => pendingThumbsRef.current.delete(f.file_id));
    }
  }, []);

  const loadContents = useCallback(async () => {
    // Cancel any in-progress thumbnail fetches from the previous load cycle
    thumbnailAbortRef.current?.abort();
    const thumbAbort = new AbortController();
    thumbnailAbortRef.current = thumbAbort;

    currentPageRef.current = 1;
    hasMoreRef.current = false;
    setLoading(true);
    setError(null);
    try {
      const [filesResponse, foldersResponse] = await Promise.all([
        api.listFiles(1, PAGE_SIZE, currentFolderId ?? undefined),
        api.listFolders(currentFolderId),
      ]);

      hasMoreRef.current = filesResponse.total > PAGE_SIZE;
      const allOriginal: FileInfo[] = [...foldersResponse.files, ...filesResponse.files];

      const fileEntries: FileData[] = [
        ...allOriginal.filter((f) => f.isDir).map((f): FileData => ({
          id: f.file_id,
          name: f.filename,
          isDir: true,
          parentId: f.parent_id ?? undefined,
        })),
        ...allOriginal.filter((f) => !f.isDir).map((f): FileData => ({
          id: f.file_id,
          name: f.filename,
          isDir: false,
          size: f.filesize,
          modDate: new Date(f.created_at),
          thumbnailUrl: undefined,
        })),
      ];

      pendingThumbsRef.current.clear();
      setFiles(fileEntries);
      setOriginalFiles(allOriginal);
      loadThumbnails(allOriginal, thumbAbort.signal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
      setFiles([]);
      setOriginalFiles([]);
    } finally {
      setLoading(false);
    }
  }, [currentFolderId, loadThumbnails]);

  const loadMoreFiles = useCallback(async () => {
    if (isLoadingMoreRef.current || !hasMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    const nextPage = currentPageRef.current + 1;
    try {
      const filesResponse = await api.listFiles(nextPage, PAGE_SIZE, currentFolderId ?? undefined);
      currentPageRef.current = nextPage;
      hasMoreRef.current = nextPage * PAGE_SIZE < filesResponse.total;

      const newOriginals = filesResponse.files;
      setOriginalFiles((prev) => [...prev, ...newOriginals]);
      setFiles((prev) => [
        ...prev,
        ...newOriginals.map((f): FileData => ({
          id: f.file_id,
          name: f.filename,
          isDir: false,
          size: f.filesize,
          modDate: new Date(f.created_at),
          thumbnailUrl: undefined,
        })),
      ]);
      loadThumbnails(newOriginals);
    } catch (err) {
      console.error('Failed to load more files:', err);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [currentFolderId, loadThumbnails]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMoreFiles(); },
      { rootMargin: '300px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreFiles]);

  useEffect(() => {
    if (currentFolderId !== undefined) {
      loadContents();
    }
  }, [currentFolderId]);

  // Note: cards read `thumbnails[...]` directly during render (see the files.map below),
  // so no effect is needed here to propagate thumbnail arrivals — the component already
  // re-renders whenever `thumbnails` state changes. (Previously this cloned all `files`
  // objects on every single thumbnail arrival, forcing a full-grid re-render per thumbnail.)

  // Box select: track mouse during drag, update selection rect + selected files
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!boxSelectStartRef.current) return;
      const { x: startX, y: startY } = boxSelectStartRef.current;
      const width = Math.abs(e.clientX - startX);
      const height = Math.abs(e.clientY - startY);

      // 8px 拖曳閾值：低於此視為點擊，不啟動框選
      if (width < 8 && height < 8) return;

      if (!boxSelectActivatedRef.current) {
        boxSelectActivatedRef.current = true;
        // 首次超過閾值才清除選取（無修飾鍵時）
        setSelectedFiles(new Set());
        lastSelectedRef.current = null;
      }

      const left = Math.min(startX, e.clientX);
      const top = Math.min(startY, e.clientY);
      setBoxSelectRect({ left, top, width, height });

      const newSelected = new Set<string>();
      fileCardRefs.current.forEach((el, fileId) => {
        const cardRect = el.getBoundingClientRect();
        if (
          cardRect.right > left && cardRect.left < left + width &&
          cardRect.bottom > top && cardRect.top < top + height
        ) {
          newSelected.add(fileId);
        }
      });
      setSelectedFiles(newSelected);
    };

    const handleMouseUp = () => {
      // 短點擊空白處（未超過拖曳閾值）→ 取消所有選取
      if (boxSelectStartRef.current && !boxSelectActivatedRef.current) {
        setSelectedFiles(new Set());
        lastSelectedRef.current = null;
      }
      boxSelectStartRef.current = null;
      setBoxSelectRect(null);
      // boxSelectActivatedRef 留給 onClick 消費後自行清除
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle keyboard delete
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.key === 'Delete' && selectedFiles.size > 0) {
        event.preventDefault();
        const hasFolder = files.some((f) => selectedFiles.has(f.id) && f.isDir);
        const warning = hasFolder
          ? ' Folders will be deleted with ALL their contents.'
          : '';
        const confirmed = confirm(`Delete ${selectedFiles.size} selected item(s)?${warning}`);
        if (!confirmed) return;

        try {
          for (const fileId of selectedFiles) {
            const entry = files.find((f) => f.id === fileId);
            if (entry?.isDir) {
              await api.deleteFolder(fileId);
            } else {
              await api.deleteFile(fileId);
            }
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
  }, [selectedFiles, files, loadContents]);

  const handleNavigateToBreadcrumb = (index: number) => {
    if (index === 0) {
      // Navigate to root
      setCurrentFolderId(null);
      setBreadcrumb([]);
    } else {
      const targetFolder = breadcrumb[index - 1];
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

  // precomputedHash: string when planUploads() already proved the file is fresh (skip
  // internal dedup check); null when hashing failed at plan time (upload without dedup);
  // undefined when called without a pre-pass (legacy fallback: check for duplicates here).
  const uploadWithThumbnail = async (
    file: File,
    onProgress?: (pct: number) => void,
    precomputedHash?: string | null,
  ): Promise<Array<{ message_id: number; access_hash?: string; size: number; has_thumbnail: boolean }>> => {
    const telegramClient = getTelegramClient();

    // Start thumbnail capture NOW from the local file so it runs concurrently with
    // the dedup check. Capturing a frame from a local file takes < 1 second
    // regardless of file size.
    const thumbPromise: Promise<Blob | null> = captureThumb(file, 60000);

    let fileHash: string | null = precomputedHash ?? null;
    if (precomputedHash === undefined) {
      fileHash = await sha256File(file).catch(() => null);
      if (fileHash) {
        const hashCheck = await api.checkFileHash(fileHash).catch(() => ({ found: false, files: [] as FileInfo[] }));
        if (hashCheck.found && hashCheck.files.length > 0) {
          console.log('[Upload] Duplicate detected by hash, skipping Telegram upload for:', file.name);
          onProgress?.(100);
          const asExisting = hashCheck.files.map((f) => ({
            filesize: f.filesize,
            mime_type: f.mime_type,
            telegram_message_id: f.telegram_message_id!,
            access_hash: f.access_hash,
            part_index: f.part_index,
            has_thumbnail: f.has_thumbnail,
          }));
          await registerDuplicateParts(file, fileHash, asExisting, currentFolderId);
          console.log('[Upload] Dedup: registered', asExisting.length, 'parts from existing upload');
          return asExisting.map((p) => ({ message_id: p.telegram_message_id, access_hash: p.access_hash ?? undefined, size: p.filesize, has_thumbnail: p.has_thumbnail ?? false }));
        }
      }
    }

    const thumbBlob = await thumbPromise;
    console.log('[Upload] Starting split upload for:', file.name, 'size:', file.size);
    const uploadResult = await telegramClient.uploadFileSplit(file, onProgress, thumbBlob);
    console.log('[Upload] Upload completed, parts:', uploadResult.parts.length);

    const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Register all parts first so the file appears immediately in the UI
    await Promise.all(uploadResult.parts.map((part, i) =>
      api.registerFile({
        filename: file.name,
        filesize: part.size,
        mimeType: file.type || undefined,
        messageId: part.message_id,
        fileId: part.file_id,
        accessHash: part.access_hash,
        parentId: currentFolderId ?? undefined,
        hasThumbnail: i === 0 && uploadResult.hasThumbnail,
        isSplitFile: true,
        splitGroupId: splitGroupId,
        partIndex: i,
        totalParts: uploadResult.parts.length,
        originalName: file.name,
        fileHash: fileHash ?? undefined,
      })
    ));
    console.log('[Upload] All parts registered with split_group_id:', splitGroupId);

    return uploadResult.parts.map((p, i) => ({ ...p, has_thumbnail: i === 0 && uploadResult.hasThumbnail }));
  };

  const uploadAlbumBatch = async (
    batch: File[],
    hashes: Array<string | null>,
    onProgress?: (file: File, pct: number) => void,
    parentIds?: Array<string | null>,
  ): Promise<Array<{ message_id: number; access_hash?: string; size: number; has_thumbnail: boolean } | null>> => {
    const telegramClient = getTelegramClient();
    // No thumb capture here — messages.SendMultiMedia rejects the whole batch
    // with 400 MEDIA_INVALID if any item's InputMediaUploadedDocument carries
    // a thumb. See uploadAlbum()'s comment in gramjs.ts.
    const albumResults = await telegramClient.uploadAlbum(batch, (fileIdx, pct) => {
      onProgress?.(batch[fileIdx], pct);
    });

    const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    await Promise.all(
      albumResults.map((part, j) => {
        const file = batch[j];
        if (!part.message_id) return Promise.resolve();
        return api.registerFile({
          filename: file.name,
          filesize: file.size,
          mimeType: file.type || undefined,
          messageId: part.message_id,
          fileId: part.file_id || `${splitGroupId}-${j}`,
          accessHash: part.access_hash,
          parentId: (parentIds ? parentIds[j] : currentFolderId) ?? undefined,
          hasThumbnail: part.has_thumbnail,
          isSplitFile: false,
          splitGroupId: undefined,
          partIndex: undefined,
          totalParts: undefined,
          originalName: file.name,
          fileHash: hashes[j] ?? undefined,
        });
      })
    );

    return albumResults.map((part) =>
      part.message_id
        ? { message_id: part.message_id, access_hash: part.access_hash, size: part.size, has_thumbnail: part.has_thumbnail }
        : null
    );
  };

  type UploadRow = { name: string; progress: number; status: 'uploading' | 'complete' | 'error'; error?: string };

  /**
   * Shared upload entry point for drag-drop and the file picker. Runs the dedup
   * pre-pass BEFORE any file touches fileSemaphore, so duplicates (which never
   * hit Telegram) can't hold a concurrency slot that a real upload needs.
   */
  const startUploadBatch = async (selectedFiles: File[]): Promise<void> => {
    const initialFiles: UploadRow[] = selectedFiles.map((f) => ({
      name: f.name,
      progress: 0,
      status: 'uploading',
    }));
    setUploadingFiles(initialFiles);

    const results: UploadRow[] = initialFiles.map((f) => ({ ...f }));
    const indexByFile = new Map<File, number>();
    selectedFiles.forEach((f, i) => indexByFile.set(f, i));

    const setRowStatus = (file: File, patch: Partial<UploadRow>) => {
      const i = indexByFile.get(file);
      if (i === undefined) return;
      results[i] = { ...results[i], ...patch };
      setUploadingFiles([...results]);
    };

    const plan = await planUploads(selectedFiles);

    // Duplicates already in the DB: register immediately, never touch fileSemaphore.
    const registerSemaphore = new Semaphore(8);
    const duplicatePromises = plan.duplicates.map((dup) =>
      registerSemaphore.withSlot(() =>
        registerDuplicateParts(
          dup.file,
          dup.hash,
          dup.existing.map((f) => ({
            filesize: f.filesize,
            mime_type: f.mime_type,
            telegram_message_id: f.telegram_message_id!,
            access_hash: f.access_hash,
            part_index: f.part_index,
            has_thumbnail: f.has_thumbnail,
          })),
          currentFolderId,
        )
      ).then(() => {
        setRowStatus(dup.file, { progress: 100, status: 'complete' });
      }).catch((err: any) => {
        setRowStatus(dup.file, { progress: 0, status: 'error', error: err instanceof Error ? err.message : '註冊失敗' });
      })
    );

    // Files sharing a hash within this selection: only the representative
    // uploads for real; dependents register against its result once it's done.
    const registerDependents = async (
      planned: PlannedFile,
      parts: Array<{ message_id: number; access_hash?: string; size: number }> | null,
      mimeType: string,
    ) => {
      if (planned.dependents.length === 0) return;
      if (!parts || parts.length === 0) {
        planned.dependents.forEach((dep) => setRowStatus(dep, { progress: 0, status: 'error', error: '來源檔案上傳失敗' }));
        return;
      }
      const asExisting = parts.map((p, i) => ({
        filesize: p.size,
        mime_type: mimeType,
        telegram_message_id: p.message_id,
        access_hash: p.access_hash,
        part_index: i,
        has_thumbnail: i === 0 ? (p as any).has_thumbnail ?? false : false,
      }));
      await Promise.all(planned.dependents.map((dep) =>
        registerDuplicateParts(dep, planned.hash, asExisting, currentFolderId)
          .then(() => setRowStatus(dep, { progress: 100, status: 'complete' }))
          .catch((err: any) => setRowStatus(dep, { progress: 0, status: 'error', error: err instanceof Error ? err.message : '註冊失敗' }))
      ));
    };

    const ALBUM_BATCH = 10;
    const freshBatches: PlannedFile[][] = [];
    for (let i = 0; i < plan.fresh.length; i += ALBUM_BATCH) {
      freshBatches.push(plan.fresh.slice(i, i + ALBUM_BATCH));
    }

    const fileSemaphore = new Semaphore(MAX_CONCURRENT_FILES);
    // A size-1 tail batch normally rides the album path too (SendMultiMedia
    // accepts a single item), so it isn't throttled as a standalone message.
    // Exceptions that keep the classic single-file path: the user dropped just
    // one file (preserve thumbnail generation), or the file is large enough to
    // need the split/chunked upload.
    const SINGLE_PATH_SIZE_LIMIT = 10 * 1024 * 1024;
    const freshPromises = freshBatches.map((batch) => {
      if (batch.length === 1 && (selectedFiles.length === 1 || batch[0].file.size > SINGLE_PATH_SIZE_LIMIT)) {
        const planned = batch[0];
        const file = planned.file;
        return fileSemaphore.withSlot(() =>
          uploadWithThumbnail(file, (pct) => setRowStatus(file, { progress: pct }), planned.hash)
        ).then(async (parts) => {
          setRowStatus(file, { progress: 100, status: 'complete' });
          await registerDependents(planned, parts, file.type);
        }).catch(async (err: any) => {
          setRowStatus(file, { progress: 0, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' });
          await registerDependents(planned, null, file.type);
        });
      }

      return fileSemaphore.withSlot(() =>
        uploadAlbumBatch(batch.map((p) => p.file), batch.map((p) => p.hash), (file, pct) => setRowStatus(file, { progress: pct }))
      ).then(async (albumResults) => {
        await Promise.all(batch.map(async (planned, j) => {
          const res = albumResults[j];
          if (res) {
            setRowStatus(planned.file, { progress: 100, status: 'complete' });
            await registerDependents(planned, [res], planned.file.type);
          } else {
            setRowStatus(planned.file, { progress: 0, status: 'error', error: 'Upload failed' });
            await registerDependents(planned, null, planned.file.type);
          }
        }));
      }).catch(async (err: any) => {
        await Promise.all(batch.map(async (planned) => {
          setRowStatus(planned.file, { progress: 0, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' });
          await registerDependents(planned, null, planned.file.type);
        }));
      });
    });

    await Promise.allSettled([...duplicatePromises, ...freshPromises]);

    loadContents();
  };

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    dragCounterRef.current = 0;
    isDraggingRef.current = false;

    const dragData = event.dataTransfer.getData('application/x-teledrive-file-id');
    if (dragData) {
      return;
    }

    const items = event.dataTransfer.items;
    if (!items || items.length === 0) return;

    let hasFolders = false;
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        hasFolders = true;
        break;
      }
    }

    if (hasFolders) {
      await uploadFolder(items, currentFolderId);
      loadContents();
      return;
    }

    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    await startUploadBatch(droppedFiles);
  }, [currentFolderId, loadContents, isDraggingInternal]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const pickedFiles = Array.from(event.target.files || []);
    if (pickedFiles.length === 0) return;

    await startUploadBatch(pickedFiles);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleUploadFolderClick = () => {
    folderInputRef.current?.click();
  };

  const uploadFolder = async (items: DataTransferItemList, parentFolderId: string | null): Promise<void> => {
    // Lazy folder creation: each unique path is created at most once.
    // Returns the folder's file_id (or parent fallback on error).
    const folderCache = new Map<string, Promise<string | null>>();
    folderCache.set('', Promise.resolve(parentFolderId));

    const ensureFolder = (path: string): Promise<string | null> => {
      if (folderCache.has(path)) return folderCache.get(path)!;
      const p = (async () => {
        const parts = path.split('/');
        const name = parts.pop()!;
        const parentId = await ensureFolder(parts.join('/'));
        try {
          const result = await api.createFolder(name, parentId);
          return result.file_id as string | null;
        } catch {
          return parentId;
        }
      })();
      folderCache.set(path, p);
      return p;
    };

    let discovered = 0;
    let completed = 0;
    let failed = 0;

    // Rolling window: show last 100 files so the list stays bounded.
    const VISIBLE_MAX = 100;
    type FileEntry = { name: string; progress: number; status: 'uploading' | 'complete' | 'error'; error?: string };
    const visibleFiles: FileEntry[] = [];

    const addVisible = (entry: FileEntry) => {
      visibleFiles.push(entry);
      if (visibleFiles.length > VISIBLE_MAX) visibleFiles.shift();
    };
    const updateVisible = (name: string, patch: Partial<FileEntry>) => {
      for (let i = visibleFiles.length - 1; i >= 0; i--) {
        if (visibleFiles[i].name === name) { Object.assign(visibleFiles[i], patch); break; }
      }
    };

    const updateUI = () => {
      setUploadTotals({ total: discovered, done: completed + failed });
      setUploadingFiles([...visibleFiles]);
    };

    // Upload one file after its parent folder is ready. Called only for files
    // already proven fresh (not a duplicate) — hash check happens before this
    // is invoked, outside fileSemaphore.
    const uploadFileEntryFresh = async (file: File, folderPath: string, fileHash: string | null): Promise<void> => {
      const telegramClient = getTelegramClient();
      const folderId = await ensureFolder(folderPath);
      const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const thumbBlob = await captureThumb(file);
      const uploadResult = await telegramClient.uploadFileSplit(file, undefined, thumbBlob);
      await Promise.all(uploadResult.parts.map((part, j) =>
        api.registerFile({
          filename: file.name,
          filesize: part.size,
          mimeType: file.type || undefined,
          messageId: part.message_id,
          fileId: part.file_id,
          accessHash: part.access_hash,
          parentId: folderId ?? undefined,
          hasThumbnail: j === 0 && uploadResult.hasThumbnail,
          isSplitFile: true,
          splitGroupId: splitGroupId,
          partIndex: j,
          totalParts: uploadResult.parts.length,
          originalName: file.name,
          fileHash: fileHash ?? undefined,
        })
      ));
    };

    // Limit concurrent file uploads — too many simultaneous sendFile() calls
    // cause GramJS to resolve "me" to entity ID 0 and crash.
    const fileSemaphore = new Semaphore(MAX_CONCURRENT_FILES);

    // All upload promises collected so we can await them.
    const uploadPromises: Promise<void>[] = [];

    // Small-file accumulator: fresh files ≤10MB batch into one SendMultiMedia
    // (10 files = 1 message). Batches may mix files from different subfolders —
    // the album lands in Saved Messages; parent_id is per-file DB metadata.
    type PendingSmall = { file: File; folderPath: string; hash: string | null };
    const ALBUM_BATCH = 10;
    const SMALL_FILE_LIMIT = 10 * 1024 * 1024;
    let smallBuffer: PendingSmall[] = [];

    const flushSmallBuffer = (): void => {
      if (smallBuffer.length === 0) return;
      const batch = smallBuffer;
      smallBuffer = [];
      const p = fileSemaphore.withSlot(async () => {
        const folderIds = await Promise.all(batch.map((e) => ensureFolder(e.folderPath)));
        const results = await uploadAlbumBatch(
          batch.map((e) => e.file),
          batch.map((e) => e.hash),
          (file, pct) => { updateVisible(file.name, { progress: pct }); updateUI(); },
          folderIds,
        );
        results.forEach((res, j) => {
          if (res) {
            completed++;
            updateVisible(batch[j].file.name, { progress: 100, status: 'complete' });
          } else {
            failed++;
            updateVisible(batch[j].file.name, { progress: 0, status: 'error', error: '上傳失敗' });
          }
        });
        updateUI();
      }).catch(() => {
        batch.forEach((e) => {
          failed++;
          updateVisible(e.file.name, { progress: 0, status: 'error', error: '上傳失敗' });
        });
        updateUI();
      });
      uploadPromises.push(p);
    };

    // Read all entries from a DirectoryReader (may require multiple calls).
    const readAllEntries = (reader: any): Promise<any[]> =>
      new Promise<any[]>((resolve, reject) => {
        const all: any[] = [];
        const next = () =>
          reader.readEntries((batch: any[]) => {
            if (batch.length === 0) { resolve(all); return; }
            all.push(...batch);
            next();
          }, reject);
        next();
      });

    // Traverse directory tree in parallel; enqueue upload as each file is found.
    const processEntry = async (entry: any, basePath: string): Promise<void> => {
      if (entry.isFile) {
        await new Promise<void>((resolve) => {
          entry.file((file: File) => {
            discovered++;
            addVisible({ name: file.name, progress: 0, status: 'uploading' });
            updateUI();
            const folderPath = basePath.replace(/\/$/, '');
            const p = (async (): Promise<'deferred' | 'done'> => {
              const fileHash = await hashFileBounded(file);
              if (fileHash) {
                const hashCheck = await api.checkFileHash(fileHash).catch(() => ({ found: false, files: [] as FileInfo[] }));
                if (hashCheck.found && hashCheck.files.length > 0) {
                  console.log('[Upload] Duplicate detected by hash (folder upload):', file.name);
                  const folderId = await ensureFolder(folderPath);
                  const asExisting = hashCheck.files.map((f) => ({
                    filesize: f.filesize,
                    mime_type: f.mime_type,
                    telegram_message_id: f.telegram_message_id!,
                    access_hash: f.access_hash,
                    part_index: f.part_index,
                    has_thumbnail: f.has_thumbnail,
                  }));
                  await registerDuplicateParts(file, fileHash, asExisting, folderId);
                  return 'done';
                }
              }
              if (file.size <= SMALL_FILE_LIMIT) {
                smallBuffer.push({ file, folderPath, hash: fileHash });
                if (smallBuffer.length >= ALBUM_BATCH) flushSmallBuffer();
                return 'deferred';
              }
              await fileSemaphore.withSlot(() => uploadFileEntryFresh(file, folderPath, fileHash));
              return 'done';
            })().then((kind) => {
              if (kind === 'deferred') return;
              completed++;
              updateVisible(file.name, { progress: 100, status: 'complete' });
              updateUI();
            }).catch(() => {
              failed++;
              updateVisible(file.name, { progress: 0, status: 'error', error: '上傳失敗' });
              updateUI();
            });
            uploadPromises.push(p);
            resolve();
          });
        });
      } else if (entry.isDirectory) {
        const fullPath = `${basePath}${entry.name}`;
        ensureFolder(fullPath); // pre-warm cache without awaiting
        const entries = await readAllEntries(entry.createReader());
        await Promise.all(entries.map((e: any) => processEntry(e, `${fullPath}/`)));
      }
    };

    setUploadTotals({ total: 0, done: 0 });
    setUploadingFiles([{ name: '掃描資料夾中...', progress: 0, status: 'uploading' }]);

    const rootEntries = Array.from({ length: items.length }, (_, i) => items[i].webkitGetAsEntry?.()).filter(Boolean);
    await Promise.all(rootEntries.map((e) => processEntry(e, '')));

    // Traversal enqueues hash-check promises; they may still be adding files to
    // smallBuffer. Wait for them, flush the tail batch, then wait for the flush.
    await Promise.allSettled(uploadPromises);
    flushSmallBuffer();
    await Promise.allSettled(uploadPromises);

    updateUI();
    loadContents();
  };

  const handleFolderSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const items = event.target.files;
    if (!items || items.length === 0) return;
    const dataTransfer = new DataTransfer();
    for (let i = 0; i < items.length; i++) {
      dataTransfer.items.add(items[i]);
    }
    await uploadFolder(dataTransfer.items, currentFolderId);
    loadContents();
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  // Selection handlers
  const handleFileClick = useCallback((file: FileData, event: React.MouseEvent) => {
    // 若框選拖曳剛結束，此次 click 是拖曳結束而非點擊，跳過
    if (boxSelectActivatedRef.current) {
      boxSelectActivatedRef.current = false;
      return;
    }

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

  // Box select: start on mousedown on empty space (not on a file card)
  const handleGridMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // 點擊在 file card 上 → 讓 HTML5 drag / onClick 處理，不啟動框選
    if (target.closest('[data-file-card]')) return;
    e.preventDefault();
    boxSelectActivatedRef.current = false;
    boxSelectStartRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Drag handlers for file items
  const handleFileDragStart = useCallback((file: FileData, event: React.DragEvent) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.dropEffect = 'move';
    event.dataTransfer.setData('application/x-teledrive-item-id', file.id);
    setIsDraggingInternal(true);

    // 若此項目未被選取，改為只選取它
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

  const handleFolderDrop = useCallback(async (folderId: string | null, event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverFolderId(null);
    setDragOverBreadcrumbId(null);
    console.log('[Drop] handleFolderDrop called, folderId:', folderId);

    // Get selected file IDs (from selection or from drag data)
    const selectedIds = Array.from(selectedFiles);
    console.log('[Drop] selectedIds from state:', selectedIds);
    
    if (selectedIds.length === 0) {
      const dragData = event.dataTransfer.getData('application/x-teledrive-item-id');
      if (dragData) selectedIds.push(dragData);
    }

    // 防止把資料夾拖進自己裡面
    if (folderId !== null && selectedIds.includes(folderId)) return;

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
       const original = originalFilesById.get(file.id);
       if (original) {
         setPreviewFile(original);
         setPreviewUrl(null);

         const mimeType = original.mime_type || 'application/octet-stream';

         if (!mimeType.startsWith('video/')) {
           try {
             const telegramClient = getTelegramClient();
             let blob: Blob;
             if ((original as any).is_split_file && (original as any).split_group_id) {
               blob = await telegramClient.downloadFileMerge((original as any).split_group_id, mimeType);
             } else if (original.telegram_message_id) {
               blob = await telegramClient.downloadFile(original.telegram_message_id, mimeType);
             } else {
               return;
             }
             setPreviewUrl(URL.createObjectURL(blob));
           } catch (err) {
             console.error('[Preview] Failed to download file:', err);
           }
         }
       }
     }
   }, [originalFiles]);

  const closePreview = useCallback(async () => {
    if (previewFile?.mime_type?.startsWith('video/')) {
      // Signal main.tsx to stop accepting preload chunk requests immediately
      window.dispatchEvent(new CustomEvent('teledrive:stop-streaming'));
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
          registration.active?.postMessage({ type: 'CLEANUP' });
        }
      } catch (err) {
        console.log('[Preview] Could not send CLEANUP to Service Worker:', err);
      }
    }
    
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewFile(null);
    setPreviewUrl(null);
  }, [previewUrl, previewFile]);

  return (
    <div
      data-testid="drive-drop-zone"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '16px', boxSizing: 'border-box', position: 'relative' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >

      {uploadingFiles.length > 0 && (() => {
        const totalCount = uploadTotals ? uploadTotals.total : uploadingFiles.length;
        const doneCount = uploadTotals ? uploadTotals.done : uploadingFiles.filter(f => f.status !== 'uploading').length;
        return (
          <div style={{
            position: 'fixed', bottom: '16px', right: '16px',
            background: 'white', border: '1px solid #e5e7eb', borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)', minWidth: '280px', maxWidth: '360px',
            zIndex: 9999, display: 'flex', flexDirection: 'column',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #e5e7eb' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>
                上傳中 {doneCount.toLocaleString()} / {totalCount.toLocaleString()} 個檔案
              </span>
              <button
                onClick={() => { setUploadingFiles([]); setUploadTotals(null); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: '16px', lineHeight: 1, padding: '2px 4px' }}
              >✕</button>
            </div>
            {/* File list */}
            <div style={{ maxHeight: '280px', overflowY: 'auto', padding: '8px 14px' }}>
              {uploadingFiles.map((f, i) => (
                <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: i < uploadingFiles.length - 1 ? '5px' : 0 }}>
                  {f.status === 'complete' && <span style={{ color: '#16a34a', fontSize: '13px', flexShrink: 0 }}>✓</span>}
                  {f.status === 'error'    && <span style={{ color: '#dc2626', fontSize: '13px', flexShrink: 0 }}>✗</span>}
                  {f.status === 'uploading'&& <span style={{ color: '#3b82f6', fontSize: '13px', flexShrink: 0 }}>↑</span>}
                  <span style={{ fontSize: '12px', color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </span>
                  {(f.status === 'uploading' || f.status === 'complete') && (
                    <span style={{ fontSize: '11px', color: f.status === 'complete' ? '#16a34a' : '#6b7280', flexShrink: 0 }}>
                      {f.status === 'complete' ? '100%' : `${f.progress}%`}
                    </span>
                  )}
                  {f.status === 'error' && <span style={{ fontSize: '11px', color: '#dc2626', flexShrink: 0 }}>{f.error}</span>}
                </div>
              ))}
            </div>
          </div>
        );
      })()}
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
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverBreadcrumbId('__root__'); }}
            onDragLeave={() => setDragOverBreadcrumbId(null)}
            onDrop={(e) => handleFolderDrop(null, e)}
            style={{
              background: dragOverBreadcrumbId === '__root__' ? '#dbeafe' : 'none',
              border: dragOverBreadcrumbId === '__root__' ? '2px dashed #3b82f6' : '2px solid transparent',
              cursor: 'pointer',
              color: '#3b82f6',
              fontSize: '16px',
              padding: '2px 6px',
              borderRadius: '4px',
              fontWeight: 600,
              transition: 'background 0.1s',
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
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverBreadcrumbId(folder.id); }}
                onDragLeave={() => setDragOverBreadcrumbId(null)}
                onDrop={(e) => handleFolderDrop(folder.id, e)}
                style={{
                  background: dragOverBreadcrumbId === folder.id ? '#dbeafe' : 'none',
                  border: dragOverBreadcrumbId === folder.id ? '2px dashed #3b82f6' : '2px solid transparent',
                  cursor: 'pointer',
                  color: index === breadcrumb.length - 1 ? '#374151' : '#3b82f6',
                  fontSize: '16px',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontWeight: index === breadcrumb.length - 1 ? 600 : 400,
                  transition: 'background 0.1s',
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

        <button
          onClick={handleUploadFolderClick}
          style={{
            background: '#8b5cf6',
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
          ↑ Upload Folder
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

        <input
          ref={folderInputRef}
          type="file"
          // @ts-ignore - webkitdirectory is not in React types but works in browsers
          webkitdirectory=""
          multiple
          onChange={handleFolderSelect}
          style={{ display: 'none' }}
        />
      </div>

      <div
        ref={scrollContainerRef}
        onMouseDown={viewMode === 'grid' ? handleGridMouseDown : undefined}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
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
        <div
          style={{
            display: viewMode === 'grid' ? 'grid' : 'flex',
            gridTemplateColumns: viewMode === 'grid' ? 'repeat(auto-fill, minmax(225px, 1fr))' : undefined,
            flexDirection: viewMode === 'grid' ? undefined : 'column',
            gap: '12px',
            userSelect: 'none',
          }}
        >
          {files.map((file) => {
            const original = originalFilesById.get(file.id);
            const isImage = original?.mime_type?.startsWith('image/');
            const isVideo = original?.mime_type?.startsWith('video/');
            const thumbnailUrl = original ? thumbnails[original.file_id] : null;
            const isSelected = selectedFiles.has(file.id);
            const isDragOver = dragOverFolderId === file.id;
            
            return (
              <div
                key={file.id}
                data-file-card="true"
                ref={(el) => {
                  if (el) fileCardRefs.current.set(file.id, el);
                  else fileCardRefs.current.delete(file.id);
                }}
                draggable={true}
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
                      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
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
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            fontSize: viewMode === 'grid' ? '32px' : '16px',
                            textShadow: '0 0 4px rgba(0,0,0,0.5)',
                            pointerEvents: 'none',
                          }}>
                            ▶️
                          </span>
                        )}
                      </div>
                    ) : (isImage || isVideo) ? (
                      <span style={{ fontSize: viewMode === 'grid' ? '60px' : '20px' }}>
                        {isVideo ? '🎬' : '🖼️'}
                      </span>
                    ) : (
                      <span style={{ fontSize: viewMode === 'grid' ? '60px' : '20px' }}>📄</span>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, width: viewMode === 'grid' ? '100%' : undefined }}>
                    <div
                      title={file.name}
                      style={{
                        fontSize: '14px',
                        color: '#374151',
                        ...(viewMode === 'grid'
                          ? isSelected
                            ? { wordBreak: 'break-word', overflowWrap: 'break-word' }
                            : {
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical' as const,
                                overflow: 'hidden',
                                wordBreak: 'break-word',
                                overflowWrap: 'break-word',
                              }
                          : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
                      }}
                    >
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

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} style={{ height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: '13px' }}>
        {isLoadingMore && 'Loading more...'}
      </div>

      </div>

      {/* Box Select Overlay */}
      {boxSelectRect && boxSelectRect.width > 4 && boxSelectRect.height > 4 && (
        <div
          style={{
            position: 'fixed',
            left: boxSelectRect.left,
            top: boxSelectRect.top,
            width: boxSelectRect.width,
            height: boxSelectRect.height,
            background: 'rgba(59, 130, 246, 0.1)',
            border: '1.5px solid #3b82f6',
            borderRadius: '2px',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        />
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
                  src={
                    (previewFile as any).is_split_file && (previewFile as any).split_group_id
                      ? `/preview-video/split/${(previewFile as any).split_group_id}`
                      : `/preview-video/${previewFile.file_id}/${previewFile.telegram_message_id}`
                  }
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