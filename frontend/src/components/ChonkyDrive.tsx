import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../api/client';
import { sha256File } from '../lib/hashFile';
import { getTelegramClient, getChunkRateStats, PreparedAlbumFile, AlbumFileResult } from '../lib/gramjs';
import { captureThumb, isMediaFile } from '../lib/thumbCapture';
import { getCachedThumbnail, setCachedThumbnail } from '../lib/thumbnailCache';
import { FileInfo, FileData } from '../types';
import { Semaphore } from '../lib/semaphore';
import { MAX_CONCURRENT_FILES, ALBUM_BATCH } from '../config';
import { planUploads, registerDuplicateParts, registerFileBounded, hashFileBounded, checkFileHashBounded, canonicalExistingParts, PlannedFile, RegisterableExistingPart } from '../lib/uploadPlanner';
import { DriveView, SortKey, SortOrder } from '../hooks/useUrlState';
import { ContextMenu, MenuItem } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { RenameDialog } from './RenameDialog';
import { DetailsPanel } from './DetailsPanel';
import { fileKind } from '../lib/fileKind';
import { downloadFileToDisk, fetchFileBlob } from '../lib/download';
import { useLongPress } from '../hooks/useLongPress';

const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

const previewLoadingStyle: React.CSSProperties = { padding: 40, textAlign: 'center', color: 'var(--td-text-muted)', minWidth: 200 };

function navArrowStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'fixed', [side]: 16, top: '50%', transform: 'translateY(-50%)',
    background: 'rgba(0,0,0,0.5)', color: 'white', border: 'none', borderRadius: '50%',
    width: 44, height: 44, cursor: 'pointer', fontSize: 28, zIndex: 1001, lineHeight: 1,
  };
}

function previewIconBtn(right: string): React.CSSProperties {
  return {
    position: 'absolute', top: 8, right, background: 'rgba(0,0,0,0.5)', color: 'white',
    border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', fontSize: 16,
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001,
  };
}

// Small contextual-toolbar button.
function TbBtn({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'var(--td-surface-alt)', border: '1px solid var(--td-border)', cursor: 'pointer',
        color: danger ? '#dc2626' : 'var(--td-text)', fontSize: 13, padding: '6px 12px', borderRadius: 6, fontWeight: 500,
      }}
    >{children}</button>
  );
}

function toFileData(f: FileInfo): FileData {
  return f.isDir
    ? { id: f.file_id, name: f.filename, isDir: true, parentId: f.parent_id ?? undefined }
    : { id: f.file_id, name: f.filename, isDir: false, size: f.filesize, modDate: new Date(f.created_at) };
}

export interface ChonkyDriveProps {
  view: DriveView;
  sortBy: SortKey;
  sortOrder: SortOrder;
  onNavigateFolder: (folderId: string | null) => void;
  onSortChange: (by: SortKey, order: SortOrder) => void;
}


function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * Media eligible for Telegram album grouping (messages.SendMultiMedia).
 * webp is EXCLUDED: Telegram rejects webp documents in albums with
 * MEDIA_EMPTY, and the album fallback drops the thumbnail — so every webp sent
 * this way landed with has_thumbnail=0 (DB-confirmed: 0/84). webp instead takes
 * the single-file sendFile path, which embeds the thumb reliably.
 */
function isAlbumEligibleMedia(file: File): boolean {
  return isMediaFile(file) && file.type !== 'image/webp';
}

/**
 * Producer/consumer pipeline for album uploads. Each file's byte upload
 * ("prepare": captureThumb + upload bytes + messages.UploadMedia) runs under
 * `fileSemaphore` and releases the slot the instant it completes. Grouping
 * prepared files into a Telegram album (messages.SendMultiMedia) and
 * registering their metadata happen OUTSIDE the semaphore entirely, once
 * ALBUM_BATCH files have accumulated (or via flush() for the tail batch).
 * This keeps the concurrency slots permanently busy with byte uploads
 * instead of idling on message sends or backend registration round trips.
 */
function createAlbumPipeline(fileSemaphore: Semaphore) {
  const telegramClient = getTelegramClient();

  type PendingEntry = {
    prepared: PreparedAlbumFile;
    hash: string | null;
    parentId: string | null;
    onProgress?: (pct: number) => void;
    resolve: (result: AlbumFileResult | null) => void;
  };

  const pending: PendingEntry[] = [];
  const preparePromises: Promise<void>[] = [];
  const sendPromises: Promise<void>[] = [];

  const dispatchBatch = () => {
    const batch = pending.splice(0, ALBUM_BATCH);
    if (batch.length === 0) return;
    sendPromises.push((async () => {
      const t0 = performance.now();
      let results: AlbumFileResult[];
      try {
        results = await telegramClient.sendAlbum(batch.map((e) => e.prepared));
      } catch (err) {
        console.error('[AlbumPipeline] sendAlbum failed:', err);
        batch.forEach((e) => { e.onProgress?.(100); e.resolve(null); });
        return;
      }
      const tSend = performance.now();
      const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      await Promise.all(batch.map((entry, j) => {
        const res = results[j];
        const file = entry.prepared.file;
        if (!res.message_id) {
          entry.onProgress?.(100);
          entry.resolve(null);
          return Promise.resolve();
        }
        return api.registerFile({
          filename: file.name,
          filesize: file.size,
          mimeType: file.type || undefined,
          messageId: res.message_id,
          fileId: res.file_id || `${splitGroupId}-${j}`,
          accessHash: res.access_hash,
          parentId: entry.parentId ?? undefined,
          hasThumbnail: res.has_thumbnail,
          isSplitFile: false,
          splitGroupId: undefined,
          partIndex: undefined,
          totalParts: undefined,
          originalName: file.name,
          fileHash: entry.hash ?? undefined,
        }).then(
          () => { entry.onProgress?.(100); entry.resolve({ message_id: res.message_id, file_id: res.file_id, access_hash: res.access_hash, size: res.size, has_thumbnail: res.has_thumbnail }); },
          (err) => { console.error('[AlbumPipeline] registerFile failed:', err); entry.onProgress?.(100); entry.resolve(null); },
        );
      }));
      console.log(`[Perf] dispatchBatch x${batch.length}: sendAlbum=${Math.round(tSend - t0)}ms register=${Math.round(performance.now() - tSend)}ms`);
    })());
  };

  return {
    /** Prepare one file under fileSemaphore, releasing the slot the instant
     * bytes are on Telegram's servers. Resolves once the file's batch has
     * been sent and registered (which may happen well after this call returns
     * — the caller awaits the returned promise to know the final outcome). */
    enqueue(file: File, hash: string | null, parentId: string | null, onProgress?: (pct: number) => void): Promise<AlbumFileResult | null> {
      return new Promise((resolve) => {
        const tQueued = performance.now();
        const p = fileSemaphore.withSlot(async () => {
          const tSlot = performance.now();
          const thumb = await captureThumb(file);
          // The album path only ever handles media files, which MUST carry a
          // thumbnail — a null capture (even after retries) fails the upload
          // rather than silently landing a thumbless file in the drive.
          if (!thumb) throw new Error(`Thumbnail capture failed for ${file.name}`);
          const tThumb = performance.now();
          const prepared = await telegramClient.prepareAlbumFile(file, thumb);
          console.log(`[Perf] enqueue ${file.name}: slotWait=${Math.round(tSlot - tQueued)}ms captureThumb=${Math.round(tThumb - tSlot)}ms prepare=${Math.round(performance.now() - tThumb)}ms`);
          return prepared;
        }).then((prepared) => {
          onProgress?.(50);
          if (!prepared) { resolve(null); return; }
          pending.push({ prepared, hash, parentId, onProgress, resolve });
          if (pending.length >= ALBUM_BATCH) dispatchBatch();
        }).catch((err) => {
          console.error('[AlbumPipeline] Prepare failed:', err);
          onProgress?.(50);
          resolve(null);
        });
        preparePromises.push(p);
      });
    },
    /** Call once all enqueue() calls have been made: waits for every prepare
     * to finish, sends the leftover partial batch, then waits for every
     * send+register to complete. */
    async flush(): Promise<void> {
      await Promise.allSettled(preparePromises);
      while (pending.length > 0) dispatchBatch();
      await Promise.allSettled(sendPromises);
    },
  };
}

export function ChonkyDrive({ view, sortBy, sortOrder, onNavigateFolder, onSortChange }: ChonkyDriveProps) {
  const currentFolderId = view.mode === 'folder' ? view.folderId : null;
  const isTrash = view.mode === 'trash';
  const isSearch = view.mode === 'search';
  const canModify = view.mode === 'folder'; // uploads/dnd/box-select only in a real folder
  const [breadcrumb, setBreadcrumb] = useState<FileData[]>([]);
  const folderCacheRef = useRef<Map<string, FileInfo>>(new Map());
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

  // Custom confirm modal for deletion — replaces window.confirm() so automated
  // browser tools (e.g. Playwright) don't get stuck on a native dialog.
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: Set<string>; hasFolder: boolean } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string | null } | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileInfo | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [detailsFile, setDetailsFile] = useState<FileInfo | null>(null);
  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  // Recent image blob URLs for the gallery — revoked on close to avoid leaks.
  const galleryUrlsRef = useRef<Map<string, string>>(new Map());

  const dragCounterRef = useRef(0);
  const canModifyRef = useRef(canModify);
  canModifyRef.current = canModify; // uploads/dnd only meaningful in folder view
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

  // One page of results for the current view. Folder mode also pulls the (un-paginated)
  // folder list so subfolders always show; search/trash return files+folders in one list.
  const fetchPage = useCallback(async (page: number): Promise<{ items: FileInfo[]; total: number }> => {
    if (view.mode === 'search') {
      const resp = await api.listFiles(page, PAGE_SIZE, undefined, { search: view.query, sortBy, sortOrder });
      return { items: resp.files, total: resp.total };
    }
    if (view.mode === 'trash') {
      const resp = await api.listFiles(page, PAGE_SIZE, undefined, { trashed: true, sortBy, sortOrder });
      return { items: resp.files, total: resp.total };
    }
    if (page === 1) {
      const [filesResponse, foldersResponse] = await Promise.all([
        api.listFiles(1, PAGE_SIZE, currentFolderId ?? undefined, { sortBy, sortOrder }),
        api.listFolders(currentFolderId, { sortBy, sortOrder }),
      ]);
      return { items: [...foldersResponse.files, ...filesResponse.files], total: filesResponse.total };
    }
    const resp = await api.listFiles(page, PAGE_SIZE, currentFolderId ?? undefined, { sortBy, sortOrder });
    return { items: resp.files, total: resp.total };
  }, [view, sortBy, sortOrder, currentFolderId]);

  const loadContents = useCallback(async () => {
    thumbnailAbortRef.current?.abort();
    const thumbAbort = new AbortController();
    thumbnailAbortRef.current = thumbAbort;

    currentPageRef.current = 1;
    hasMoreRef.current = false;
    setSelectedFiles(new Set()); // view changed — drop selection of now-absent ids
    setLoading(true);
    setError(null);
    try {
      const { items, total } = await fetchPage(1);
      hasMoreRef.current = total > PAGE_SIZE;

      const fileEntries: FileData[] = [
        ...items.filter((f) => f.isDir).map(toFileData),
        ...items.filter((f) => !f.isDir).map(toFileData),
      ];

      pendingThumbsRef.current.clear();
      setFiles(fileEntries);
      setOriginalFiles(items);
      loadThumbnails(items, thumbAbort.signal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
      setFiles([]);
      setOriginalFiles([]);
    } finally {
      setLoading(false);
    }
  }, [fetchPage, loadThumbnails]);

  const loadMoreFiles = useCallback(async () => {
    if (isLoadingMoreRef.current || !hasMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    const nextPage = currentPageRef.current + 1;
    try {
      const { items, total } = await fetchPage(nextPage);
      currentPageRef.current = nextPage;
      hasMoreRef.current = nextPage * PAGE_SIZE < total;
      setOriginalFiles((prev) => [...prev, ...items]);
      setFiles((prev) => [...prev, ...items.map(toFileData)]);
      loadThumbnails(items);
    } catch (err) {
      console.error('Failed to load more files:', err);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [fetchPage, loadThumbnails]);

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
    loadContents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadContents]);

  // Rebuild the breadcrumb from the parent_id chain so deep-links / reloads work.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (view.mode !== 'folder' || !view.folderId) { setBreadcrumb([]); return; }
      const chain: FileData[] = [];
      const cache = folderCacheRef.current;
      let id: string | null = view.folderId;
      let guard = 0;
      while (id && guard++ < 100) {
        let f: FileInfo | undefined = cache.get(id);
        if (!f) {
          try { f = await api.getFile(id); cache.set(id, f); } catch { break; }
        }
        chain.unshift({ id: f.file_id, name: f.filename, isDir: true, parentId: f.parent_id ?? undefined });
        id = f.parent_id ?? null;
      }
      if (!cancelled) setBreadcrumb(chain);
    })();
    return () => { cancelled = true; };
  }, [view]);

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

  // Move to trash (soft delete). deleteFile/deleteFolder both soft-delete server-side.
  const performDelete = async (ids: Set<string>) => {
    try {
      for (const fileId of ids) {
        const entry = files.find((f) => f.id === fileId);
        if (entry?.isDir) await api.deleteFolder(fileId);
        else await api.deleteFile(fileId);
      }
      setSelectedFiles(new Set());
      loadContents();
    } catch (err) {
      console.error('Failed to delete files:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete files');
    }
  };

  const performRestore = async (ids: Set<string>) => {
    try {
      for (const fileId of ids) await api.restoreFile(fileId);
      setSelectedFiles(new Set());
      loadContents();
    } catch (err) {
      setError(err instanceof Error ? err.message : '還原失敗');
    }
  };

  const performPurge = async (ids: Set<string>) => {
    try {
      for (const fileId of ids) await api.purgeFile(fileId);
      setSelectedFiles(new Set());
      loadContents();
    } catch (err) {
      setError(err instanceof Error ? err.message : '永久刪除失敗');
    }
  };

  const performRename = async (file: FileInfo, newName: string) => {
    setRenameTarget(null);
    try {
      await api.renameFile(file.file_id, newName);
      loadContents();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新命名失敗');
    }
  };

  // Empty trash: purge every trashed root, paging until the trash is empty.
  const emptyTrash = async () => {
    setEmptyTrashConfirm(false);
    try {
      let resp = await api.listFiles(1, 200, undefined, { trashed: true });
      while (resp.files.length > 0) {
        for (const f of resp.files) await api.purgeFile(f.file_id);
        resp = await api.listFiles(1, 200, undefined, { trashed: true });
      }
      loadContents();
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空垃圾桶失敗');
    }
  };

  // Handle keyboard delete + F2 rename
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Delete' && selectedFiles.size > 0) {
        event.preventDefault();
        if (isTrash) { performPurge(new Set(selectedFiles)); return; }
        const hasFolder = files.some((f) => selectedFiles.has(f.id) && f.isDir);
        setDeleteConfirm({ ids: new Set(selectedFiles), hasFolder });
      } else if (event.key === 'F2' && selectedFiles.size === 1 && !isTrash) {
        event.preventDefault();
        const id = Array.from(selectedFiles)[0];
        const original = originalFilesById.get(id);
        if (original) setRenameTarget(original);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFiles, files, isTrash, originalFilesById]);

  const handleNavigateToBreadcrumb = (index: number) => {
    if (index === 0) onNavigateFolder(null);
    else onNavigateFolder(breadcrumb[index - 1].id);
  };

  const handleBack = () => {
    if (breadcrumb.length > 0) onNavigateFolder(breadcrumb[breadcrumb.length - 2]?.id ?? null);
  };

  const handleCreateFolder = async (name: string) => {
    setNewFolderOpen(false);
    try {
      await api.createFolder(name, currentFolderId);
      loadContents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    }
  };

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    if (!canModifyRef.current) return;
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
  //
  // Only does the Telegram upload — metadata registration is the caller's job, done
  // AFTER releasing whatever concurrency slot wraps this call, so a slow backend
  // register never holds up the next file's bytes from starting.
  const uploadFileToTelegram = async (
    file: File,
    onProgress?: (pct: number) => void,
    precomputedHash?: string | null,
  ): Promise<{
    parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean }>;
    fileHash: string | null;
    alreadyRegistered: boolean;
  }> => {
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
          // Collapse to the canonical part set — /check-hash returns every row
          // sharing the hash (including prior dedup rows), and registering one
          // new row per returned row doubles the count on each re-upload.
          const asExisting = canonicalExistingParts(hashCheck.files);
          await registerDuplicateParts(file, fileHash, asExisting, currentFolderId);
          console.log('[Upload] Dedup: registered', asExisting.length, 'parts from existing upload');
          return {
            // file_id is unused here — alreadyRegistered=true tells the caller to
            // skip registerUploadedParts, which is the only consumer that needs it.
            parts: asExisting.map((p) => ({ message_id: p.telegram_message_id, file_id: '', access_hash: p.access_hash ?? undefined, size: p.filesize, has_thumbnail: p.has_thumbnail ?? false })),
            fileHash,
            alreadyRegistered: true,
          };
        }
      }
    }

    const thumbBlob = await thumbPromise;
    // Media files must carry a thumbnail — if capture failed (even after retries)
    // the upload fails instead of registering a thumbless media file. Non-media
    // files legitimately have no thumbnail.
    if (isMediaFile(file) && !thumbBlob) {
      throw new Error(`Thumbnail capture failed for ${file.name}`);
    }
    console.log('[Upload] Starting split upload for:', file.name, 'size:', file.size);
    const uploadResult = await telegramClient.uploadFileSplit(file, onProgress, thumbBlob);
    console.log('[Upload] Upload completed, parts:', uploadResult.parts.length);

    return {
      parts: uploadResult.parts.map((p, i) => ({ ...p, has_thumbnail: i === 0 && uploadResult.hasThumbnail })),
      fileHash,
      alreadyRegistered: false,
    };
  };

  // Registers Telegram-uploaded parts as file metadata. Called OUTSIDE any
  // upload concurrency slot so a slow backend never blocks the next upload.
  const registerUploadedParts = async (
    file: File,
    fileHash: string | null,
    parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean }>,
    parentId: string | null,
  ): Promise<void> => {
    const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    await Promise.all(parts.map((part, i) =>
      api.registerFile({
        filename: file.name,
        filesize: part.size,
        mimeType: file.type || undefined,
        messageId: part.message_id,
        fileId: part.file_id,
        accessHash: part.access_hash,
        parentId: parentId ?? undefined,
        hasThumbnail: part.has_thumbnail,
        // Only genuinely multi-part uploads are "split files" — a single-part
        // result must report false so the backend's same-name+parent replace
        // logic (file_service.py's register_uploaded_file) can fire on re-upload.
        isSplitFile: parts.length > 1,
        splitGroupId: splitGroupId,
        partIndex: i,
        totalParts: parts.length,
        originalName: file.name,
        fileHash: fileHash ?? undefined,
      })
    ));
    console.log('[Upload] All parts registered with split_group_id:', splitGroupId);
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

    // Only images/videos are eligible for Telegram album grouping. Large media
    // (needs the split/chunked upload path) and every other file type always
    // go through the classic single-file path.
    const SINGLE_PATH_SIZE_LIMIT = 10 * 1024 * 1024;
    const albumEligible: PlannedFile[] = [];
    const singleFileOnly: PlannedFile[] = [];
    plan.fresh.forEach((p) => {
      if (isAlbumEligibleMedia(p.file) && p.file.size <= SINGLE_PATH_SIZE_LIMIT) {
        albumEligible.push(p);
      } else {
        singleFileOnly.push(p);
      }
    });

    const fileSemaphore = new Semaphore(MAX_CONCURRENT_FILES);
    const albumPipeline = createAlbumPipeline(fileSemaphore);

    const singlePromises = singleFileOnly.map((planned) => {
      const file = planned.file;
      return fileSemaphore.withSlot(() =>
        uploadFileToTelegram(file, (pct) => setRowStatus(file, { progress: pct }), planned.hash)
      ).then(async (result) => {
        if (!result.alreadyRegistered) {
          await registerUploadedParts(file, result.fileHash, result.parts, currentFolderId);
        }
        setRowStatus(file, { progress: 100, status: 'complete' });
        await registerDependents(planned, result.parts, file.type);
      }).catch(async (err: any) => {
        setRowStatus(file, { progress: 0, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' });
        await registerDependents(planned, null, file.type);
      });
    });

    // Each album-eligible file is enqueued individually — the pipeline groups
    // them into ALBUM_BATCH-sized albums itself once enough have prepared, so
    // fileSemaphore only ever gates the byte-upload step (see createAlbumPipeline).
    const albumFilePromises = albumEligible.map((planned) =>
      albumPipeline.enqueue(planned.file, planned.hash, currentFolderId, (pct) => setRowStatus(planned.file, { progress: pct }))
        .then(async (res) => {
          if (res) {
            setRowStatus(planned.file, { progress: 100, status: 'complete' });
            await registerDependents(planned, [res], planned.file.type);
          } else {
            setRowStatus(planned.file, { progress: 0, status: 'error', error: 'Upload failed' });
            await registerDependents(planned, null, planned.file.type);
          }
        })
    );

    await Promise.allSettled([...duplicatePromises, ...singlePromises, ...albumFilePromises, albumPipeline.flush()]);

    const { rate, floods, ceiling } = getChunkRateStats();
    console.log(`[Perf] batch done: floods=${floods} finalRate=${rate.toFixed(1)} ceiling=${ceiling?.toFixed(1) ?? 'none'} parts/s`);

    loadContents();
  };

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    if (!canModifyRef.current) return;
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

    // Files already present in a destination folder (keyed by filename → filesize),
    // fetched at most once per folder path. Lets us skip re-uploading a folder that
    // already exists without hashing/checking/registering each file — a same
    // name+size file in the target folder is treated as already uploaded.
    const folderFilesCache = new Map<string, Promise<Map<string, number>>>();
    const existingFolderFiles = (path: string): Promise<Map<string, number>> => {
      if (folderFilesCache.has(path)) return folderFilesCache.get(path)!;
      const p = (async () => {
        const map = new Map<string, number>();
        const folderId = await ensureFolder(path);
        if (!folderId) return map;
        const PAGE_SIZE = 1000;
        for (let page = 1; ; page++) {
          const res = await api.listFiles(page, PAGE_SIZE, folderId).catch(() => null);
          if (!res || res.files.length === 0) break;
          for (const f of res.files) {
            if (!f.isDir) map.set(f.filename, f.filesize);
          }
          if (res.files.length < PAGE_SIZE || page * PAGE_SIZE >= res.total) break;
        }
        return map;
      })();
      folderFilesCache.set(path, p);
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

    // Upload one file's bytes to Telegram. Called only for files already proven
    // fresh (not a duplicate) — hash check happens before this is invoked.
    // Does NOT register metadata — that happens after the caller releases
    // fileSemaphore, so a slow backend never blocks the next file's bytes.
    const uploadFileEntryFresh = async (file: File): Promise<{
      parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number }>;
      hasThumbnail: boolean;
    }> => {
      const telegramClient = getTelegramClient();
      const thumbBlob = await captureThumb(file);
      // Media files must carry a thumbnail — fail rather than register a
      // thumbless media file. Non-media files legitimately have none.
      if (isMediaFile(file) && !thumbBlob) {
        throw new Error(`Thumbnail capture failed for ${file.name}`);
      }
      const uploadResult = await telegramClient.uploadFileSplit(file, undefined, thumbBlob);
      return { parts: uploadResult.parts, hasThumbnail: uploadResult.hasThumbnail };
    };

    const registerFolderFileParts = async (
      file: File,
      fileHash: string | null,
      folderId: string | null,
      parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number }>,
      hasThumbnail: boolean,
    ): Promise<void> => {
      const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      await Promise.all(parts.map((part, j) =>
        registerFileBounded({
          filename: file.name,
          filesize: part.size,
          mimeType: file.type || undefined,
          messageId: part.message_id,
          fileId: part.file_id,
          accessHash: part.access_hash,
          parentId: folderId ?? undefined,
          hasThumbnail: j === 0 && hasThumbnail,
          isSplitFile: parts.length > 1,
          splitGroupId: splitGroupId,
          partIndex: j,
          totalParts: parts.length,
          originalName: file.name,
          fileHash: fileHash ?? undefined,
        })
      ));
    };

    // Limit concurrent file uploads — too many simultaneous sendFile() calls
    // cause GramJS to resolve "me" to entity ID 0 and crash.
    const fileSemaphore = new Semaphore(MAX_CONCURRENT_FILES);

    // Fresh images/videos ≤10MB go through the same producer/consumer album
    // pipeline as the drag-drop path: fileSemaphore only gates the byte-upload
    // step, grouping into SendMultiMedia + registration happen outside it.
    const SMALL_FILE_LIMIT = 10 * 1024 * 1024;
    const albumPipeline = createAlbumPipeline(fileSemaphore);

    // Batch-scoped content dedup. The folder walk streams files, so planUploads'
    // upfront hash grouping can't be used here: two identical files both miss
    // /check-hash (neither is registered yet) and each uploads its own copy —
    // that is how a single folder ended up holding 110 physical copies of the
    // same 324KB image under 110 different names. The first file to claim a hash
    // uploads for real and publishes its parts here; every later file with that
    // hash registers against those parts instead of re-uploading.
    const claimedHashes = new Map<string, Promise<RegisterableExistingPart[] | null>>();

    // Discovery promises track routing decisions (hash check, dedup, enqueue)
    // for every discovered file — settling means no more files will be added
    // to albumPipeline or uploadPromises. Upload promises track the actual
    // Telegram upload + registration work. Keeping these separate lets the
    // tail album batch flush as soon as discovery finishes, instead of
    // waiting for every other in-flight upload to complete first.
    const discoveryPromises: Promise<void>[] = [];
    const uploadPromises: Promise<void>[] = [];

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
            const discoveryPromise = (async (): Promise<void> => {
              // Fast path: if a file with the same name+size already lives in the
              // destination folder, it's already uploaded — skip entirely (no
              // hash, no check-hash, no register). Makes re-uploading an existing
              // folder nearly free instead of a per-file request storm.
              const alreadyThere = await existingFolderFiles(folderPath);
              if (alreadyThere.get(file.name) === file.size) {
                completed++;
                updateVisible(file.name, { progress: 100, status: 'complete' });
                updateUI();
                return;
              }
              const fileHash = await hashFileBounded(file);
              if (fileHash) {
                const hashCheck = await checkFileHashBounded(fileHash);
                if (hashCheck.found && hashCheck.files.length > 0) {
                  console.log('[Upload] Duplicate detected by hash (folder upload):', file.name);
                  const folderId = await ensureFolder(folderPath);
                  // Collapse to canonical parts — see the drag/picker dedup path.
                  const asExisting = canonicalExistingParts(hashCheck.files);
                  await registerDuplicateParts(file, fileHash, asExisting, folderId);
                  completed++;
                  updateVisible(file.name, { progress: 100, status: 'complete' });
                  updateUI();
                  return;
                }
              }
              // Claim this hash for the batch, or fall in behind whoever claimed it
              // first. The get/set pair stays synchronous so two concurrent
              // discoveries of the same content can never both claim.
              const claim: { publish: (parts: RegisterableExistingPart[] | null) => void } = { publish: () => {} };
              if (fileHash) {
                const claimed = claimedHashes.get(fileHash);
                if (claimed) {
                  console.log('[Upload] Duplicate detected within batch (folder upload):', file.name);
                  const folderId = await ensureFolder(folderPath);
                  // Queued as an upload promise instead of awaited here: waiting on
                  // the claim inside a discovery promise would deadlock the album
                  // pipeline, whose tail batch is only flushed once discovery settles.
                  uploadPromises.push((async () => {
                    const parts = await claimed;
                    if (!parts || parts.length === 0) {
                      failed++;
                      updateVisible(file.name, { progress: 0, status: 'error', error: '來源檔案上傳失敗' });
                      updateUI();
                      return;
                    }
                    await registerDuplicateParts(file, fileHash, parts, folderId);
                    completed++;
                    updateVisible(file.name, { progress: 100, status: 'complete' });
                    updateUI();
                  })().catch(() => {
                    failed++;
                    updateVisible(file.name, { progress: 0, status: 'error', error: '註冊失敗' });
                    updateUI();
                  }));
                  return;
                }
                claimedHashes.set(
                  fileHash,
                  new Promise<RegisterableExistingPart[] | null>((resolve) => { claim.publish = resolve; }),
                );
              }

              // Past the claim, every path must settle it — files queued behind an
              // unresolved claim would wait forever.
              try {
                if (isAlbumEligibleMedia(file) && file.size <= SMALL_FILE_LIMIT) {
                  const folderId = await ensureFolder(folderPath);
                  const uploadPromise = albumPipeline.enqueue(file, fileHash, folderId, (pct) => { updateVisible(file.name, { progress: pct }); updateUI(); })
                    .then((res) => {
                      if (res) {
                        claim.publish([{
                          filesize: file.size,
                          mime_type: file.type || null,
                          telegram_message_id: res.message_id,
                          access_hash: res.access_hash,
                          part_index: 0,
                          has_thumbnail: res.has_thumbnail,
                        }]);
                        completed++;
                        updateVisible(file.name, { progress: 100, status: 'complete' });
                      } else {
                        claim.publish(null);
                        failed++;
                        updateVisible(file.name, { progress: 0, status: 'error', error: '上傳失敗' });
                      }
                      updateUI();
                    }).catch(() => {
                      claim.publish(null);
                      failed++;
                      updateVisible(file.name, { progress: 0, status: 'error', error: '上傳失敗' });
                      updateUI();
                    });
                  uploadPromises.push(uploadPromise);
                  return;
                }
                const folderId = await ensureFolder(folderPath);
                const uploadPromise = fileSemaphore.withSlot(() => uploadFileEntryFresh(file))
                  .then(async (result) => {
                    await registerFolderFileParts(file, fileHash, folderId, result.parts, result.hasThumbnail);
                    claim.publish(result.parts.map((part, j) => ({
                      filesize: part.size,
                      mime_type: file.type || null,
                      telegram_message_id: part.message_id,
                      access_hash: part.access_hash,
                      part_index: j,
                      has_thumbnail: j === 0 && result.hasThumbnail,
                    })));
                    completed++;
                    updateVisible(file.name, { progress: 100, status: 'complete' });
                    updateUI();
                  }).catch(() => {
                    claim.publish(null);
                    failed++;
                    updateVisible(file.name, { progress: 0, status: 'error', error: '上傳失敗' });
                    updateUI();
                  });
                uploadPromises.push(uploadPromise);
              } catch (err) {
                claim.publish(null);
                throw err;
              }
            })();
            discoveryPromises.push(discoveryPromise);
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

    // All files have been routed (dedup-registered, enqueued into the album
    // pipeline, or queued for single-file upload) — safe to flush the tail
    // album batch now without waiting for any other in-flight upload.
    await Promise.allSettled(discoveryPromises);
    await albumPipeline.flush();
    await Promise.allSettled(uploadPromises);

    const { rate, floods, ceiling } = getChunkRateStats();
    console.log(`[Perf] batch done: floods=${floods} finalRate=${rate.toFixed(1)} ceiling=${ceiling?.toFixed(1) ?? 'none'} parts/s`);

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
  // Images in the current view, in display order — drives the preview gallery.
  const galleryImages = useMemo(
    () => originalFiles.filter((f) => !f.isDir && fileKind(f.mime_type, f.filename) === 'image'),
    [originalFiles],
  );

  const openPreview = useCallback(async (original: FileInfo) => {
    setPreviewFile(original);
    setPreviewUrl(null);
    setPreviewText(null);
    const kind = fileKind(original.mime_type, original.filename);
    setPreviewIndex(kind === 'image' ? galleryImages.findIndex((f) => f.file_id === original.file_id) : null);

    if (kind === 'video') return; // video streams via Service Worker, no blob download
    try {
      const cachedUrl = galleryUrlsRef.current.get(original.file_id);
      const blob = cachedUrl ? null : await fetchFileBlob(original);
      if (kind === 'text') {
        if (blob && blob.size > 1024 * 1024) setPreviewText('（檔案過大，無法預覽）');
        else if (blob) setPreviewText(await blob.text());
      } else {
        let url = cachedUrl;
        if (!url && blob) {
          url = URL.createObjectURL(blob);
          if (kind === 'image') {
            galleryUrlsRef.current.set(original.file_id, url);
            // keep only the 5 most recent image blob URLs
            if (galleryUrlsRef.current.size > 5) {
              const oldest = galleryUrlsRef.current.keys().next().value as string;
              const u = galleryUrlsRef.current.get(oldest);
              if (u) URL.revokeObjectURL(u);
              galleryUrlsRef.current.delete(oldest);
            }
          }
        }
        setPreviewUrl(url ?? null);
      }
    } catch (err) {
      console.error('[Preview] Failed to download file:', err);
    }
  }, [galleryImages]);

  const openItem = useCallback((file: FileData) => {
    if (file.isDir) { onNavigateFolder(file.id); return; }
    const original = originalFilesById.get(file.id);
    if (original) openPreview(original);
  }, [onNavigateFolder, originalFilesById, openPreview]);

  const stepGallery = useCallback((delta: number) => {
    if (previewIndex === null) return;
    const next = previewIndex + delta;
    if (next < 0 || next >= galleryImages.length) return;
    openPreview(galleryImages[next]);
  }, [previewIndex, galleryImages, openPreview]);

  const handleFileClick = useCallback((file: FileData, event: React.MouseEvent) => {
    // 若框選拖曳剛結束，此次 click 是拖曳結束而非點擊，跳過
    if (boxSelectActivatedRef.current) {
      boxSelectActivatedRef.current = false;
      return;
    }

    const fileId = file.id;

    // Touch: a plain tap with nothing selected opens the item (folder nav / preview).
    if (isTouch && selectedFiles.size === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      openItem(file);
      return;
    }

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
  }, [files, selectedFiles, openItem]);

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
    
    const tracked = new Set(galleryUrlsRef.current.values());
    if (previewUrl && !tracked.has(previewUrl)) URL.revokeObjectURL(previewUrl);
    galleryUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    galleryUrlsRef.current.clear();
    setPreviewFile(null);
    setPreviewUrl(null);
    setPreviewText(null);
    setPreviewIndex(null);
  }, [previewUrl, previewFile]);

  // Preview keyboard: Esc closes, ←/→ steps the image gallery.
  useEffect(() => {
    if (!previewFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePreview();
      else if (e.key === 'ArrowLeft') stepGallery(-1);
      else if (e.key === 'ArrowRight') stepGallery(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewFile, closePreview, stepGallery]);

  // Long-press (touch) opens the context menu for the card under the finger.
  const longPress = useLongPress((x, y) => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-file-card]') as HTMLElement | null;
    const id = el?.getAttribute('data-file-id');
    if (!id) return;
    setSelectedFiles(new Set([id]));
    lastSelectedRef.current = id;
    setContextMenu({ x, y, targetId: id });
  });

  const handleCardContextMenu = (file: FileData, e: React.MouseEvent) => {
    e.preventDefault();
    if (!selectedFiles.has(file.id)) {
      setSelectedFiles(new Set([file.id]));
      lastSelectedRef.current = file.id;
    }
    setContextMenu({ x: e.clientX, y: e.clientY, targetId: file.id });
  };

  const handleEmptyContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-file-card]')) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, targetId: null });
  };

  const downloadSelection = async (ids: Set<string>) => {
    for (const id of ids) {
      const original = originalFilesById.get(id);
      if (original && !original.isDir) await downloadFileToDisk(original).catch((err) => console.error('[Download]', err));
    }
  };

  const buildMenuItems = (): MenuItem[] => {
    if (!contextMenu) return [];
    const ids = new Set(selectedFiles);

    if (contextMenu.targetId === null) {
      if (isTrash) return [{ label: '清空垃圾桶', icon: '🗑️', danger: true, onClick: () => setEmptyTrashConfirm(true) }];
      if (!canModify) return [];
      return [
        { label: '新資料夾', icon: '📁', onClick: () => setNewFolderOpen(true) },
        { label: '上傳檔案', icon: '↑', onClick: handleUploadClick },
      ];
    }

    if (isTrash) {
      return [
        { label: '還原', icon: '♻️', onClick: () => performRestore(ids) },
        { label: '永久刪除', icon: '🗑️', danger: true, onClick: () => performPurge(ids) },
      ];
    }

    const single = ids.size === 1;
    const original = single ? originalFilesById.get(Array.from(ids)[0]) : undefined;
    const items: MenuItem[] = [];
    if (single && original && !original.isDir) {
      items.push({ label: '預覽', icon: '👁', onClick: () => openPreview(original) });
    }
    if (original && !original.isDir) items.push({ label: '下載', icon: '↓', onClick: () => downloadSelection(ids) });
    if (single && original) items.push({ label: '重新命名', icon: '✏️', onClick: () => setRenameTarget(original) });
    if (single && original) items.push({ label: '詳細資料', icon: 'ℹ️', onClick: () => setDetailsFile(original) });
    items.push({ label: '移至垃圾桶', icon: '🗑️', danger: true, onClick: () => setDeleteConfirm({ ids, hasFolder: files.some((f) => ids.has(f.id) && f.isDir) }) });
    return items;
  };

  // Resolve a file's location (parent folder name) for the details panel.
  const [detailsLocation, setDetailsLocation] = useState('我的雲端硬碟');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!detailsFile) return;
      const pid = detailsFile.parent_id;
      if (!pid) { setDetailsLocation('我的雲端硬碟'); return; }
      const cached = folderCacheRef.current.get(pid);
      if (cached) { setDetailsLocation(cached.filename); return; }
      try {
        const f = await api.getFile(pid);
        folderCacheRef.current.set(pid, f);
        if (!cancelled) setDetailsLocation(f.filename);
      } catch { if (!cancelled) setDetailsLocation('—'); }
    })();
    return () => { cancelled = true; };
  }, [detailsFile]);

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
          flexWrap: 'wrap',
          gap: '8px',
          marginBottom: '12px',
          fontSize: '16px',
          fontWeight: 600,
          color: 'var(--td-text)',
        }}
      >
        {selectedFiles.size > 0 ? (
          /* Contextual toolbar — replaces breadcrumb while items are selected */
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <button onClick={() => setSelectedFiles(new Set())} title="清除選取"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)', fontSize: 18 }}>✕</button>
            <span style={{ fontSize: 15 }}>{selectedFiles.size} 已選取</span>
            {isTrash ? (
              <>
                <TbBtn onClick={() => performRestore(new Set(selectedFiles))}>♻️ 還原</TbBtn>
                <TbBtn onClick={() => performPurge(new Set(selectedFiles))} danger>🗑️ 永久刪除</TbBtn>
              </>
            ) : (
              <>
                <TbBtn onClick={() => downloadSelection(new Set(selectedFiles))}>↓ 下載</TbBtn>
                {selectedFiles.size === 1 && (
                  <TbBtn onClick={() => { const o = originalFilesById.get(Array.from(selectedFiles)[0]); if (o) setRenameTarget(o); }}>✏️ 重新命名</TbBtn>
                )}
                <TbBtn onClick={() => setDeleteConfirm({ ids: new Set(selectedFiles), hasFolder: files.some((f) => selectedFiles.has(f.id) && f.isDir) })} danger>🗑️ 刪除</TbBtn>
                {selectedFiles.size === 1 && (
                  <TbBtn onClick={() => { const o = originalFilesById.get(Array.from(selectedFiles)[0]); if (o) setDetailsFile(o); }}>ℹ️</TbBtn>
                )}
              </>
            )}
          </span>
        ) : isTrash ? (
          <span style={{ flex: 1, color: 'var(--td-text-strong)' }}>🗑️ 垃圾桶</span>
        ) : isSearch ? (
          <span style={{ flex: 1, color: 'var(--td-text-strong)' }}>🔍 「{view.query}」的搜尋結果</span>
        ) : (
          <>
            {breadcrumb.length > 0 && (
              <button onClick={handleBack} title="Go back"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)', fontSize: '14px', padding: '4px 8px', borderRadius: '4px', display: 'flex', alignItems: 'center' }}>
                ← 返回
              </button>
            )}
            <span style={{ display: 'flex', alignItems: 'center', flex: 1, flexWrap: 'wrap' }}>
              <button
                onClick={() => handleNavigateToBreadcrumb(0)}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverBreadcrumbId('__root__'); }}
                onDragLeave={() => setDragOverBreadcrumbId(null)}
                onDrop={(e) => handleFolderDrop(null, e)}
                style={{
                  background: dragOverBreadcrumbId === '__root__' ? 'var(--td-accent-soft)' : 'none',
                  border: dragOverBreadcrumbId === '__root__' ? '2px dashed var(--td-accent)' : '2px solid transparent',
                  cursor: 'pointer', color: 'var(--td-accent)', fontSize: '16px', padding: '2px 6px', borderRadius: '4px', fontWeight: 600, transition: 'background 0.1s',
                  whiteSpace: 'nowrap',
                }}
              >
                我的雲端硬碟
              </button>
              {breadcrumb.map((folder, index) => (
                <span key={folder.id} style={{ display: 'flex', alignItems: 'center' }}>
                  <span style={{ color: 'var(--td-text-muted)', margin: '0 8px' }}>/</span>
                  <button
                    onClick={() => handleNavigateToBreadcrumb(index + 1)}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverBreadcrumbId(folder.id); }}
                    onDragLeave={() => setDragOverBreadcrumbId(null)}
                    onDrop={(e) => handleFolderDrop(folder.id, e)}
                    style={{
                      background: dragOverBreadcrumbId === folder.id ? 'var(--td-accent-soft)' : 'none',
                      border: dragOverBreadcrumbId === folder.id ? '2px dashed var(--td-accent)' : '2px solid transparent',
                      cursor: 'pointer',
                      color: index === breadcrumb.length - 1 ? 'var(--td-text-strong)' : 'var(--td-accent)',
                      fontSize: '16px', padding: '2px 6px', borderRadius: '4px',
                      fontWeight: index === breadcrumb.length - 1 ? 600 : 400, transition: 'background 0.1s',
                    }}
                  >
                    {folder.name}
                  </button>
                </span>
              ))}
            </span>
          </>
        )}

        {/* Sort dropdown */}
        <select
          value={`${sortBy}:${sortOrder}`}
          onChange={(e) => { const [b, o] = e.target.value.split(':'); onSortChange(b as SortKey, o as SortOrder); }}
          style={{ fontSize: 13, padding: '7px 8px', borderRadius: 6, border: '1px solid var(--td-border)', background: 'var(--td-surface)', color: 'var(--td-text)', cursor: 'pointer' }}
          title="排序"
        >
          <option value="date:desc">最新</option>
          <option value="date:asc">最舊</option>
          <option value="name:asc">名稱 A→Z</option>
          <option value="name:desc">名稱 Z→A</option>
          <option value="size:desc">大小 (大→小)</option>
          <option value="size:asc">大小 (小→大)</option>
        </select>

        <button
          onClick={() => setViewMode((v) => (v === 'grid' ? 'list' : 'grid'))}
          style={{ background: 'var(--td-accent)', border: 'none', cursor: 'pointer', color: 'white', fontSize: '14px', padding: '8px 16px', borderRadius: '6px', fontWeight: 500 }}
        >
          {viewMode === 'grid' ? '☰ 清單' : '⊞ 格狀'}
        </button>

        {canModify && (
          <>
            <button
              onClick={() => setNewFolderOpen(true)}
              style={{ background: 'var(--td-accent)', border: 'none', cursor: 'pointer', color: 'white', fontSize: '14px', padding: '8px 16px', borderRadius: '6px', fontWeight: 500 }}
            >
              + 新資料夾
            </button>
            <button
              onClick={handleUploadClick}
              style={{ background: '#16a34a', border: 'none', cursor: 'pointer', color: 'white', fontSize: '14px', padding: '8px 16px', borderRadius: '6px', fontWeight: 500 }}
            >
              ↑ 上傳檔案
            </button>
            <button
              onClick={handleUploadFolderClick}
              style={{ background: '#8b5cf6', border: 'none', cursor: 'pointer', color: 'white', fontSize: '14px', padding: '8px 16px', borderRadius: '6px', fontWeight: 500 }}
            >
              ↑ 上傳資料夾
            </button>
          </>
        )}

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
        onMouseDown={viewMode === 'grid' && canModify ? handleGridMouseDown : undefined}
        onContextMenu={handleEmptyContextMenu}
        {...longPress}
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
            color: 'var(--td-text-muted)',
            border: '2px dashed var(--td-border)',
            borderRadius: '8px',
          }}
        >
          <p style={{ fontSize: '16px', margin: '0 0 8px 0' }}>
            {isTrash ? '垃圾桶是空的' : isSearch ? '找不到符合的檔案' : '這個資料夾是空的'}
          </p>
          {!isTrash && !isSearch && <p style={{ fontSize: '13px', margin: 0 }}>上傳檔案或建立資料夾以開始使用</p>}
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
                data-file-id={file.id}
                ref={(el) => {
                  if (el) fileCardRefs.current.set(file.id, el);
                  else fileCardRefs.current.delete(file.id);
                }}
                draggable={canModify}
                onDragStart={canModify ? (e) => handleFileDragStart(file, e) : undefined}
                onDragEnd={canModify ? handleFileDragEnd : undefined}
                onContextMenu={(e) => handleCardContextMenu(file, e)}
                style={{
                  display: 'flex',
                  alignItems: viewMode === 'grid' ? 'center' : 'center',
                  flexDirection: viewMode === 'grid' ? 'column' : 'row',
                  padding: viewMode === 'grid' ? '12px' : '12px',
                  background: isSelected ? 'var(--td-accent-soft)' : 'var(--td-surface)',
                  border: isSelected ? '2px solid var(--td-selected-border)' : (isDragOver ? '2px dashed var(--td-accent)' : '1px solid var(--td-border)'),
                  borderRadius: '8px',
                  cursor: file.isDir ? 'pointer' : (isSelected ? 'grab' : 'default'),
                  textAlign: viewMode === 'grid' ? 'center' : 'left',
                  opacity: isTrash ? 0.6 : (!file.isDir && isSelected ? 0.8 : 1),
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
                  openItem(file);
                }}
                {...(file.isDir && canModify ? {
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
                    background: (isImage || isVideo) ? 'var(--td-surface-alt)' : 'transparent',
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
                        color: 'var(--td-text)',
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
                      <div style={{ fontSize: '12px', color: 'var(--td-text-muted)' }}>
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
      <div ref={sentinelRef} style={{ height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--td-text-muted)', fontSize: '13px' }}>
        {isLoadingMore && '載入更多...'}
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

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={buildMenuItems()} onClose={() => setContextMenu(null)} />
      )}

      {deleteConfirm && (
        <ConfirmDialog
          message={`確定要將 ${deleteConfirm.ids.size} 個項目移至垃圾桶嗎？${deleteConfirm.hasFolder ? '（資料夾將連同全部內容一起移入）' : ''}`}
          confirmLabel="移至垃圾桶"
          danger
          onConfirm={() => { const ids = deleteConfirm.ids; setDeleteConfirm(null); performDelete(ids); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {emptyTrashConfirm && (
        <ConfirmDialog
          message="確定要清空垃圾桶嗎？此動作會永久刪除所有項目，無法復原。"
          confirmLabel="清空垃圾桶"
          danger
          onConfirm={emptyTrash}
          onCancel={() => setEmptyTrashConfirm(false)}
        />
      )}

      {newFolderOpen && (
        <RenameDialog
          title="新資料夾"
          initialValue="未命名資料夾"
          confirmLabel="建立"
          onSubmit={handleCreateFolder}
          onCancel={() => setNewFolderOpen(false)}
        />
      )}

      {renameTarget && (
        <RenameDialog
          title="重新命名"
          initialValue={renameTarget.filename}
          selectBaseName={!renameTarget.isDir}
          onSubmit={(name) => performRename(renameTarget, name)}
          onCancel={() => setRenameTarget(null)}
        />
      )}

      {detailsFile && (
        <DetailsPanel
          file={detailsFile}
          thumbnailUrl={thumbnails[detailsFile.file_id]}
          locationName={detailsLocation}
          onClose={() => setDetailsFile(null)}
        />
      )}

      {/* Preview Modal — image gallery, video (SW stream), PDF, audio, text */}
      {previewFile && (() => {
        const kind = fileKind(previewFile.mime_type, previewFile.filename);
        return (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={closePreview}
        >
          {kind === 'image' && previewIndex !== null && previewIndex > 0 && (
            <button onClick={(e) => { e.stopPropagation(); stepGallery(-1); }} style={navArrowStyle('left')}>‹</button>
          )}
          {kind === 'image' && previewIndex !== null && previewIndex < galleryImages.length - 1 && (
            <button onClick={(e) => { e.stopPropagation(); stepGallery(1); }} style={navArrowStyle('right')}>›</button>
          )}
          <div
            style={{ maxWidth: '90vw', maxHeight: '90vh', background: 'var(--td-surface)', borderRadius: '8px', overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={closePreview} style={previewIconBtn('8px')}>✕</button>
            <button onClick={() => downloadFileToDisk(previewFile).catch((err) => console.error('[Download]', err))} style={previewIconBtn('48px')} title="下載">↓</button>

            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--td-border)', fontSize: 14, fontWeight: 500, color: 'var(--td-text)', paddingRight: 90 }}>
              {previewFile.filename}
            </div>

            <div style={{ padding: 8, overflow: 'auto' }}>
              {kind === 'image' ? (
                <img src={previewUrl ?? undefined} alt={previewFile.filename} decoding="async"
                  style={{ minWidth: 200, minHeight: 200, maxWidth: '100%', maxHeight: 'calc(90vh - 100px)', objectFit: 'contain' }} />
              ) : kind === 'video' ? (
                <video
                  src={previewFile.is_split_file && previewFile.split_group_id
                    ? `/preview-video/split/${previewFile.split_group_id}`
                    : `/preview-video/${previewFile.file_id}/${previewFile.telegram_message_id}`}
                  controls autoPlay style={{ maxWidth: '100%', maxHeight: 'calc(90vh - 100px)' }} />
              ) : kind === 'pdf' ? (
                previewUrl ? <iframe src={previewUrl} title={previewFile.filename} style={{ width: '80vw', height: 'calc(90vh - 100px)', border: 'none' }} />
                  : <div style={previewLoadingStyle}>載入中...</div>
              ) : kind === 'audio' ? (
                previewUrl ? <div style={{ padding: 40 }}><audio src={previewUrl} controls autoPlay style={{ width: 360, maxWidth: '80vw' }} /></div>
                  : <div style={previewLoadingStyle}>載入中...</div>
              ) : kind === 'text' ? (
                previewText !== null
                  ? <pre style={{ margin: 0, padding: 16, maxWidth: '80vw', maxHeight: 'calc(90vh - 120px)', overflow: 'auto', fontSize: 13, color: 'var(--td-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{previewText}</pre>
                  : <div style={previewLoadingStyle}>載入中...</div>
              ) : (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--td-text-muted)' }}>此檔案類型無法預覽</div>
              )}
            </div>
          </div>
        </div>
        );
      })()}
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