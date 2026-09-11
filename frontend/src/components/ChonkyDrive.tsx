import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../api/client';
import { sha256File } from '../lib/hashFile';
import { getAllClients, PreparedAlbumFile, AlbumFileResult, TelegramClientManager } from '../lib/gramjs';
import { uploadFileSpread, type SplitUploadProgress } from '../lib/splitUpload';
import { durableUploadFile } from '../lib/durableUploadRuntime';
import { ensureDedupPartsInCurrentTarget } from '../lib/dedupRelocationRuntime';
import { withSlotOn, nextAccount } from '../lib/accountPool';
import { captureThumb, isMediaFile, type ThumbCaptureResult } from '../lib/thumbCapture';
import { getCachedThumbnail, setCachedThumbnail } from '../lib/thumbnailCache';
import { FileInfo, FileData } from '../types';
import { Semaphore } from '../lib/semaphore';
import { ThumbBatchQueue } from '../lib/thumbQueue';
import { ALBUM_BATCH } from '../config';
import { registerDuplicateParts, registerFileBounded, hashFileBounded, checkFileHashBounded, checkFileHashesBounded, canonicalExistingParts, assertPartsCoverFile, RegisterableExistingPart } from '../lib/uploadPlanner';
import { DriveView, SortKey, SortOrder } from '../hooks/useUrlState';
import { useUploadQueue } from '../hooks/useUploadQueue';
import { safeErrorMessage, type UploadErrorStage } from '../lib/uploadQueue';
import { selectCounts } from '../lib/uploadQueueSelectors';
import type { UploadDestination } from '../lib/uploadIdentity';
import { UploadCenter } from './UploadCenter';
import { ContextMenu, MenuItem } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { RenameDialog } from './RenameDialog';
import { ImportChatDialog } from './ImportChatDialog';
import { DetailsPanel } from './DetailsPanel';
import { fileKind } from '../lib/fileKind';
import { downloadFileToDisk, fetchFileBlob, fetchFileThumbnail, thumbnailCacheKey } from '../lib/download';
import { streamPreviewUrl } from '../lib/mainWindowStreamBridge';
import { useLongPress } from '../hooks/useLongPress';

const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

const previewLoadingStyle: React.CSSProperties = { padding: 40, textAlign: 'center', color: 'var(--td-text-muted)', minWidth: 200 };

function previewBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * What a preview shows before it has anything to render.
 *
 * A preview has to download the WHOLE file first (an image with a hole in it
 * is not an image, and a PDF's cross-reference table is at the END), so a big
 * file legitimately sits here for a while. Showing the byte count is what
 * separates "still coming" from "hung", and showing the error is what stops a
 * failed download — which only ever reached console.error — from looking like
 * an eternal spinner.
 */
function PreviewStatus({ error, progress }: {
  error: string | null;
  progress: { received: number; total: number } | null;
}) {
  if (error) {
    return (
      <div style={{ ...previewLoadingStyle, maxWidth: 460 }}>
        <div style={{ color: '#dc2626', fontWeight: 500, marginBottom: 8 }}>預覽失敗</div>
        <div style={{ fontSize: 12, wordBreak: 'break-word' }}>{error}</div>
      </div>
    );
  }
  const showPercent = progress !== null && progress.total > 0;
  return (
    <div style={previewLoadingStyle}>
      <div>載入中...</div>
      {showPercent && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          {Math.floor((progress.received / progress.total) * 100)}%
          {` (${previewBytes(progress.received)} / ${previewBytes(progress.total)})`}
        </div>
      )}
    </div>
  );
}

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

/** One line per account — each learns its own ceiling, so a shared number would hide which one is throttled. */
function logChunkRates(what: string): void {
  for (const client of getAllClients()) {
    const { rate, floods, ceiling } = client.getChunkRateStats();
    console.log(`[Perf] ${what} account=${client.accountId}: floods=${floods} finalRate=${rate.toFixed(1)} ceiling=${ceiling?.toFixed(1) ?? 'none'} parts/s`);
  }
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
function createAlbumPipeline() {
  type RoutedAlbumResult = AlbumFileResult & { account_id: number };
  // 失敗時把「哪一個階段失敗」與原始錯誤一起交回呼叫端。spec 的錯誤處理要求
  // 所有失敗都必須保存原始錯誤訊息；早期版本一律 resolve(null)，呼叫端只能
  // 捏造一個 'Upload failed'，錯誤詳細資訊面板對最常見的相簿路徑因此毫無用處。
  type AlbumOutcome =
    | { ok: true; result: RoutedAlbumResult }
    | { ok: false; stage: UploadErrorStage; error: unknown };
  type PendingEntry = {
    prepared: PreparedAlbumFile;
    hash: string | null;
    parentId: string | null;
    onProgress?: (pct: number) => void;
    resolve: (outcome: AlbumOutcome) => void;
  };

  // One queue per account. A prepared file's bytes live on the account that
  // uploaded them, and SendMultiMedia can only group media from that same
  // account — so batches are never mixed.
  const pending = new Map<TelegramClientManager, PendingEntry[]>();
  const preparePromises: Promise<void>[] = [];
  const sendPromises: Promise<void>[] = [];

  const queueFor = (client: TelegramClientManager): PendingEntry[] => {
    let q = pending.get(client);
    if (!q) { q = []; pending.set(client, q); }
    return q;
  };

  const dispatchBatch = (client: TelegramClientManager) => {
    const batch = queueFor(client).splice(0, ALBUM_BATCH);
    if (batch.length === 0) return;
    sendPromises.push((async () => {
      const t0 = performance.now();
      let results: AlbumFileResult[];
      try {
        results = await client.sendAlbum(batch.map((e) => e.prepared));
      } catch (err) {
        console.error('[AlbumPipeline] sendAlbum failed:', err);
        batch.forEach((e) => { e.onProgress?.(100); e.resolve({ ok: false, stage: 'telegram', error: err }); });
        return;
      }
      const tSend = performance.now();
      const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      await Promise.all(batch.map((entry, j) => {
        const res = results[j];
        const file = entry.prepared.file;
        if (!res.message_id) {
          entry.onProgress?.(100);
          // sendAlbum 回了佔位結果（message_id 0）：這個檔案在 Telegram 端沒有
          // 產生訊息，位元組並未落地，所以是 'telegram' 階段的失敗。
          entry.resolve({ ok: false, stage: 'telegram', error: new Error(`Telegram returned no message for ${file.name}`) });
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
          telegramUserId: client.accountId,
        }).then(
          () => { entry.onProgress?.(100); entry.resolve({ ok: true, result: { message_id: res.message_id, file_id: res.file_id, access_hash: res.access_hash, size: res.size, has_thumbnail: res.has_thumbnail, account_id: client.accountId } }); },
          // 位元組已經在 Telegram 上，失敗的只有中繼資料註冊。
          (err) => { console.error('[AlbumPipeline] registerFile failed:', err); entry.onProgress?.(100); entry.resolve({ ok: false, stage: 'register', error: err }); },
        );
      }));
      console.log(`[Perf] dispatchBatch x${batch.length} on account ${client.accountId}: sendAlbum=${Math.round(tSend - t0)}ms register=${Math.round(performance.now() - tSend)}ms`);
    })());
  };

  return {
    /** Prepare one file under an account slot, releasing the slot the instant
     * bytes are on Telegram's servers. Resolves once the file's batch has
     * been sent and registered (which may happen well after this call returns
     * — the caller awaits the returned promise to know the final outcome). */
    enqueue(file: File, hash: string | null, parentId: string | null, onProgress?: (pct: number) => void): Promise<AlbumOutcome> {
      return new Promise((resolve) => {
        const tQueued = performance.now();
        // The account is chosen here and stays with this file all the way
        // through sendAlbum — bytes and the album call must be on one account.
        const client = nextAccount();
        // 一個 slot 裡有兩個階段，失敗的意義不同：縮圖擷取是 'thumbnail'，
        // 之後的位元組上傳是 'telegram'。這個變數記著已經跑到哪一步。
        let prepareStage: UploadErrorStage = 'thumbnail';
        const p = withSlotOn(client, async () => {
          const tSlot = performance.now();
          const { thumb, undecodable } = await captureThumb(file);
          // The album path only ever handles media files, which MUST carry a
          // thumbnail — a null capture (even after retries) fails the upload
          // rather than silently landing a thumbless file in the drive. The one
          // exception is a video the browser cannot decode: no retry produces a
          // frame, so it goes up as a plain thumbless document instead of being
          // permanently unstorable.
          if (!thumb && !undecodable) throw new Error(`Thumbnail capture failed for ${file.name}`);
          const tThumb = performance.now();
          prepareStage = 'telegram';
          const prepared = await client.prepareAlbumFile(file, thumb);
          console.log(`[Perf] enqueue ${file.name} on account ${client.accountId}: slotWait=${Math.round(tSlot - tQueued)}ms captureThumb=${Math.round(tThumb - tSlot)}ms prepare=${Math.round(performance.now() - tThumb)}ms`);
          return prepared;
        }).then((prepared) => {
          onProgress?.(50);
          // prepareAlbumFile 回 null：位元組沒有成功送到 Telegram。
          if (!prepared) { resolve({ ok: false, stage: prepareStage, error: new Error(`Album prepare returned no media for ${file.name}`) }); return; }
          const queue = queueFor(client);
          queue.push({ prepared, hash, parentId, onProgress, resolve });
          if (queue.length >= ALBUM_BATCH) dispatchBatch(client);
        }).catch((err) => {
          console.error('[AlbumPipeline] Prepare failed:', err);
          onProgress?.(50);
          resolve({ ok: false, stage: prepareStage, error: err });
        });
        preparePromises.push(p);
      });
    },
    /** Call once all enqueue() calls have been made: waits for every prepare
     * to finish, sends each account's leftover partial batch, then waits for
     * every send+register to complete. */
    async flush(): Promise<void> {
      await Promise.allSettled(preparePromises);
      for (const [client, queue] of pending) {
        while (queue.length > 0) dispatchBatch(client);
      }
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
  const [purgeConfirm, setPurgeConfirm] = useState<{ ids: Set<string> } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string | null } | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileInfo | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [showImportChat, setShowImportChat] = useState(false);
  const [detailsFile, setDetailsFile] = useState<FileInfo | null>(null);
  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  // A preview downloads the WHOLE file before it can render anything, so
  // without these two the modal sits on "載入中..." forever — both while a
  // large file is legitimately still arriving and after the download has
  // failed outright, since the failure used to go to the console only.
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewProgress, setPreviewProgress] = useState<{ received: number; total: number } | null>(null);
  // Recent image blob URLs for the gallery — revoked on close to avoid leaks.
  const galleryUrlsRef = useRef<Map<string, string>>(new Map());

  const dragCounterRef = useRef(0);
  const canModifyRef = useRef(canModify);
  canModifyRef.current = canModify; // uploads/dnd only meaningful in folder view
  const isDraggingRef = useRef(false); // Track external file drag for upload
  const pendingThumbsRef = useRef<Set<string>>(new Set());
  const thumbnailAbortRef = useRef<AbortController | null>(null);
  const thumbQueueRef = useRef(new ThumbBatchQueue());
  // The page after the last rendered one, fetched early so its thumbnails are
  // already downloading (or cached) by the time the user scrolls into it.
  const prefetchRef = useRef<{ page: number; promise: Promise<{ items: FileInfo[]; total: number }> } | null>(null);

  const PAGE_SIZE = 200;
  const currentPageRef = useRef(1);
  const hasMoreRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Monotonically increasing id for list requests. Upload-time polling and a
  // normal navigation refresh can overlap; only the newest response may update
  // the grid, otherwise a slower, older response can make a just-uploaded file
  // disappear again until the next refresh.
  const contentsRequestRef = useRef(0);
  const uploadRefreshInFlightRef = useRef(false);
  // Session-long upload centre. Replaces the per-batch `uploadingFiles` rows:
  // every entry point dispatches into one queue that outlives a single batch.
  const queue = useUploadQueue();

  const currentDestination = useCallback((): UploadDestination => ({
    rootFolderId: currentFolderId,
    relativePath: '',
    folderResolved: true,          // 拖放／挑選路徑不需要建立資料夾
    resolvedFolderId: currentFolderId,
  }), [currentFolderId]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Box select state
  const boxSelectStartRef = useRef<{ x: number; y: number } | null>(null);
  const boxSelectActivatedRef = useRef(false);
  const [boxSelectRect, setBoxSelectRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const fileCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // One page's worth of thumbnail work. Only ever called from the queue below —
  // running two of these at once is what used to kill the MTProto connection.
  const downloadThumbBatch = useCallback(async (thumbFiles: FileInfo[], signal?: AbortSignal) => {
    // Cache keys include canonical location_version so a migration/relocation
    // cannot keep showing bytes fetched from an older Telegram message.
    const cacheCheckSemaphore = new Semaphore(6);
    const misses: FileInfo[] = [];
    await Promise.all(thumbFiles.map((file) => cacheCheckSemaphore.withSlot(async () => {
      if (signal?.aborted) return;
      try {
        const cached = await getCachedThumbnail(thumbnailCacheKey(file));
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

    // Every canonical read goes through the shared location resolver. This is
    // intentionally per logical file: telegram_user_id is only the historical
    // uploader for channel-backed rows and must never select the runtime reader.
    const downloadSemaphore = new Semaphore(6);
    await Promise.all(misses.map((file) => downloadSemaphore.withSlot(async () => {
      try {
        if (signal?.aborted) return;
        const blob = await fetchFileThumbnail(file);
        if (!blob || signal?.aborted) return;
        setCachedThumbnail(thumbnailCacheKey(file), blob).catch(() => {});
        setThumbnails((prev) => ({ ...prev, [file.file_id]: URL.createObjectURL(blob) }));
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.warn('[Thumb] Download error:', err?.message);
        }
      } finally {
        pendingThumbsRef.current.delete(file.file_id);
      }
    })));
  }, []);

  // Queue a page's thumbnails. The queue runs one page at a time, newest page
  // first — a fast scroll that appends many pages must not fan out its downloads
  // across all of them at once (that dropped the connection and froze thumbs).
  const loadThumbnails = useCallback(async (files: FileInfo[], signal?: AbortSignal) => {
    const thumbFiles = files.filter(
      (f) => (f.mime_type?.startsWith('image/') || f.mime_type?.startsWith('video/'))
             && f.has_thumbnail
             && f.telegram_message_id
             && !pendingThumbsRef.current.has(f.file_id)
    );
    if (thumbFiles.length === 0) return;
    thumbFiles.forEach((f) => pendingThumbsRef.current.add(f.file_id));
    const outcome = await thumbQueueRef.current.enqueue(
      () => downloadThumbBatch(thumbFiles, signal),
      signal,
    );
    // Never ran (view changed while queued) — let a later visit retry these ids.
    if (outcome !== 'done') thumbFiles.forEach((f) => pendingThumbsRef.current.delete(f.file_id));
  }, [downloadThumbBatch]);

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

  // Fetch a page ahead of the viewport and start its thumbnails right away, so
  // scrolling into it shows pictures instead of placeholders. loadMoreFiles then
  // reuses this promise instead of re-fetching the same page.
  const prefetchPage = useCallback((page: number, signal?: AbortSignal) => {
    if (prefetchRef.current?.page === page) return;
    const promise = fetchPage(page);
    prefetchRef.current = { page, promise };
    promise.then(({ items }) => {
      if (!signal?.aborted) loadThumbnails(items, signal);
    }).catch(() => {
      // Let loadMoreFiles retry the fetch itself if this one failed.
      if (prefetchRef.current?.page === page) prefetchRef.current = null;
    });
  }, [fetchPage, loadThumbnails]);

  const loadContents = useCallback(async () => {
    const requestId = ++contentsRequestRef.current;
    thumbnailAbortRef.current?.abort();
    const thumbAbort = new AbortController();
    thumbnailAbortRef.current = thumbAbort;

    currentPageRef.current = 1;
    hasMoreRef.current = false;
    prefetchRef.current = null; // the old view's look-ahead page is meaningless now
    setSelectedFiles(new Set()); // view changed — drop selection of now-absent ids
    setLoading(true);
    setError(null);
    try {
      const { items, total } = await fetchPage(1);
      if (requestId !== contentsRequestRef.current) return;
      hasMoreRef.current = total > PAGE_SIZE;

      const fileEntries: FileData[] = [
        ...items.filter((f) => f.isDir).map(toFileData),
        ...items.filter((f) => !f.isDir).map(toFileData),
      ];

      pendingThumbsRef.current.clear();
      setFiles(fileEntries);
      setOriginalFiles(items);
      loadThumbnails(items, thumbAbort.signal);
      if (hasMoreRef.current) prefetchPage(2, thumbAbort.signal);
    } catch (err) {
      if (requestId !== contentsRequestRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load files');
      setFiles([]);
      setOriginalFiles([]);
    } finally {
      if (requestId === contentsRequestRef.current) setLoading(false);
    }
  }, [fetchPage, loadThumbnails, prefetchPage]);

  // During a multi-file upload, metadata is registered one file at a time but
  // the old code refreshed only after the entire batch settled. Poll the first
  // page quietly while work is active so completed files appear promptly. The
  // in-flight guard bounds this to one list request at a time even on a slow
  // backend, and the final loadContents() still performs a full authoritative
  // refresh when the batch ends.
  const refreshUploadedContents = useCallback(async () => {
    if (uploadRefreshInFlightRef.current) return;
    uploadRefreshInFlightRef.current = true;
    const requestId = ++contentsRequestRef.current;
    try {
      const { items, total } = await fetchPage(1);
      if (requestId !== contentsRequestRef.current) return;

      currentPageRef.current = 1;
      hasMoreRef.current = total > PAGE_SIZE;
      prefetchRef.current = null;
      setFiles([
        ...items.filter((f) => f.isDir).map(toFileData),
        ...items.filter((f) => !f.isDir).map(toFileData),
      ]);
      setOriginalFiles(items);

      const signal = thumbnailAbortRef.current?.signal;
      loadThumbnails(items, signal);
      if (hasMoreRef.current) prefetchPage(2, signal);
    } catch (err) {
      // An upload should keep running even if one background list refresh
      // fails. The next tick (or the final full refresh) will retry.
      console.warn('[Upload] Failed to refresh file list:', err);
    } finally {
      uploadRefreshInFlightRef.current = false;
    }
  }, [fetchPage, loadThumbnails, prefetchPage]);
  const loadMoreFiles = useCallback(async () => {
    if (isLoadingMoreRef.current || !hasMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    const requestId = contentsRequestRef.current;
    const nextPage = currentPageRef.current + 1;
    const signal = thumbnailAbortRef.current?.signal;
    // Already prefetched? Take that fetch (and its already-queued thumbnails).
    const prefetched = prefetchRef.current?.page === nextPage ? prefetchRef.current : null;
    prefetchRef.current = null;
    try {
      const { items, total } = await (prefetched ? prefetched.promise : fetchPage(nextPage));
      if (requestId !== contentsRequestRef.current) return;
      currentPageRef.current = nextPage;
      hasMoreRef.current = nextPage * PAGE_SIZE < total;
      setOriginalFiles((prev) => [...prev, ...items]);
      setFiles((prev) => [...prev, ...items.map(toFileData)]);
      if (!prefetched) loadThumbnails(items, signal);
      if (hasMoreRef.current) prefetchPage(nextPage + 1, signal);
    } catch (err) {
      console.error('Failed to load more files:', err);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [fetchPage, loadThumbnails, prefetchPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) loadMoreFiles(); },
      // `root` MUST be the scroll container. With root:null the margin expands
      // the VIEWPORT rect but not the container's clip rect, so the prefetch
      // margin is silently dead: measured live, the sentinel then only counted
      // as intersecting at scrollTop === maxScroll exactly — that is why the
      // next page (and its thumbnails) only started at the absolute bottom.
      { root, rootMargin: '800px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreFiles]);

  useEffect(() => {
    loadContents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadContents]);

  const uploadInProgress = selectCounts(queue.state).active > 0;
  useEffect(() => {
    if (!canModify || !uploadInProgress) return;
    const timer = window.setInterval(() => {
      void refreshUploadedContents();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [canModify, uploadInProgress, refreshUploadedContents]);

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

  // precomputedHash: string when the streaming planner already proved the file is fresh (skip
  // internal dedup check); null when hashing failed at plan time (upload without dedup);
  // undefined when called without a pre-pass (legacy fallback: check for duplicates here).
  //
  // Only does the Telegram upload — metadata registration is the caller's job, done
  // AFTER releasing whatever concurrency slot wraps this call, so a slow backend
  // register never holds up the next file's bytes from starting.
  const uploadFileToTelegram = async (
    file: File,
    onProgress?: SplitUploadProgress,
    precomputedHash?: string | null,
  ): Promise<{
    parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean; account_id: number }>;
    fileHash: string | null;
    alreadyRegistered: boolean;
  }> => {

    // Start thumbnail capture NOW from the local file so it runs concurrently with
    // the dedup check. Capturing a frame from a local file takes < 1 second
    // regardless of file size.
    const thumbPromise: Promise<ThumbCaptureResult> = captureThumb(file, 60000);

    let fileHash: string | null = precomputedHash ?? null;
    if (precomputedHash === undefined) {
      fileHash = await sha256File(file).catch(() => null);
      if (fileHash) {
        const hashCheck = await api.checkFileHash(fileHash).catch(() => ({ found: false, files: [] as FileInfo[] }));
        // Collapse to the canonical part set — /check-hash returns every row
        // sharing the hash (including prior dedup rows), and registering one
        // new row per returned row doubles the count on each re-upload. An
        // empty result means nothing stored covers the whole file; the upload
        // below then runs for real instead of cloning a truncated record.
        const asExisting = hashCheck.found
          ? canonicalExistingParts(hashCheck.files, file.size)
          : [];
        if (asExisting.length > 0) {
          onProgress?.(100);
          const targetParts = await ensureDedupPartsInCurrentTarget(asExisting);
          await registerDuplicateParts(file, fileHash, targetParts, currentFolderId);
          return {
            // file_id is unused here — alreadyRegistered=true tells the caller to
            // skip registerUploadedParts, which is the only consumer that needs it.
            parts: targetParts.map((p) => ({ message_id: p.telegram_message_id, file_id: p.telegram_media_id ?? '', access_hash: p.access_hash ?? undefined, size: p.filesize, has_thumbnail: p.has_thumbnail ?? false, account_id: p.telegram_user_id ?? 0 })),
            fileHash,
            alreadyRegistered: true,
          };
        }
      }
    }

    const { thumb: thumbBlob, undecodable } = await thumbPromise;
    // Media files must carry a thumbnail — if capture failed (even after retries)
    // the upload fails instead of registering a thumbless media file. Non-media
    // files legitimately have no thumbnail, and so does a video whose codec the
    // browser has no decoder for (`undecodable`) — there is no frame to capture
    // on any attempt, so it registers thumbless rather than never uploading.
    if (isMediaFile(file) && !thumbBlob && !undecodable) {
      throw new Error(`Thumbnail capture failed for ${file.name}`);
    }
    console.log('[Upload] Starting split upload for:', file.name, 'size:', file.size);
    // Durable shared-storage uploads freeze the target/writer, persist every
    // operation + random id before Telegram can create a message, persist the
    // authoritative result, and only then commit metadata registration.
    const uploadResult = await durableUploadFile(file, {
      parentId: currentFolderId,
      fileHash,
      thumb: thumbBlob,
      onProgress,
    });
    console.log('[Upload] Durable upload completed, parts:', uploadResult.parts.length);

    return {
      parts: uploadResult.parts.map((p, i) => ({ ...p, has_thumbnail: i === 0 && uploadResult.hasThumbnail })),
      fileHash,
      alreadyRegistered: true,
    };
  };

  // Registers Telegram-uploaded parts as file metadata. Called OUTSIDE any
  // upload concurrency slot so a slow backend never blocks the next upload.
  const registerUploadedParts = async (
    file: File,
    fileHash: string | null,
    parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean; account_id: number }>,
    parentId: string | null,
  ): Promise<void> => {
    assertPartsCoverFile(file, parts);
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
        // Parts of one file can live on different accounts — each row records its own.
        telegramUserId: part.account_id,
      })
    ));
    console.log('[Upload] All parts registered with split_group_id:', splitGroupId);
  };

  /**
   * Shared upload entry point for drag-drop and the file picker. Each file
   * passes its dedup check before it touches an upload slot, while already
   * checked files can upload in parallel with the remaining hash work.
   */
  const startUploadBatch = async (selectedFiles: File[]): Promise<void> => {
    const destination = currentDestination();
    // 每個 File 先拿到自己的 id；身分確認可能把它併到別的 id 上。
    const enqueued = selectedFiles.map((file) => ({ file, id: queue.enqueueFile(file, destination) }));

    const SINGLE_PATH_SIZE_LIMIT = 10 * 1024 * 1024;
    const batchStorageTarget = await api.getStorageTarget();
    const albumPipeline = createAlbumPipeline();
    const uploadPromises: Promise<void>[] = [];

    // The first fresh file with a hash publishes its registered Telegram parts.
    // Later identical files in this selection wait for that promise and create
    // metadata only, preserving batch-local dedup without an upfront pre-pass.
    const claimedHashes = new Map<string, Promise<RegisterableExistingPart[] | null>>();

    const routingPromises = enqueued.map(async ({ file, id: enqueuedId }) => {
      queue.dispatch({ type: 'setStatus', id: enqueuedId, attempt: 1, status: 'hashing', now: Date.now() });
      const fileHash = await hashFileBounded(file);

      // 身分確認閘門：這一步之後才知道要用哪個 id、哪個 attempt 做事。
      const settled = queue.dispatch({ type: 'setHash', id: enqueuedId, attempt: 1, contentHash: fileHash, now: Date.now() });
      const resolution = settled.resolutions[enqueuedId];
      if (!resolution || resolution.outcome === 'discarded') return;   // 相同工作已在進行中
      const id = resolution.targetId;
      const attempt = resolution.attempt;
      queue.holdFile(id, file);

      const done = () => { queue.dispatch({ type: 'complete', id, attempt, now: Date.now() }); queue.releaseFile(id); };
      const failed = (stage: UploadErrorStage, err: unknown) => {
        queue.dispatch({ type: 'fail', id, attempt, stage, message: safeErrorMessage(err), now: Date.now() });
        queue.releaseFile(id);
      };
      const onProgress: SplitUploadProgress = (pct, detail) => queue.dispatch(
        detail?.reason === 'migration'
          ? { type: 'migrationProgressReset', id, attempt, progress: pct, message: detail.message, now: Date.now() }
          : { type: 'setProgress', id, attempt, progress: pct, now: Date.now() },
      );

      // hashFileBounded 把讀取錯誤吞成 null（uploadPlanner 由其他呼叫端共用，
      // 不在這裡改），因此「雜湊算不出來」與「檔案已經讀不到了」長得一樣。
      // 再讀一個位元組就能分辨：真的讀不到就報 'hash'，否則照舊無雜湊上傳。
      if (!fileHash) {
        try {
          await file.slice(0, 1).arrayBuffer();
        } catch (err) {
          failed('hash', err);
          return;
        }
      }

      if (fileHash) {
        const checked = await checkFileHashesBounded([fileHash]);
        const existing = checked[fileHash] ?? [];
        const reusable = canonicalExistingParts(existing, file.size);
        if (reusable.length > 0) {
          queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
          uploadPromises.push(
            ensureDedupPartsInCurrentTarget(reusable)
              .then((targetParts) => registerDuplicateParts(file, fileHash, targetParts, destination.resolvedFolderId))
              .then(done).catch((err) => failed('register', err)),
          );
          return;
        }
        if (existing.length > 0) {
          console.warn('[Upload] Hash matched but stored copy is incomplete, re-uploading:', file.name);
        }
      }

      let publishParts: (parts: RegisterableExistingPart[] | null) => void = () => {};
      if (fileHash) {
        const claimed = claimedHashes.get(fileHash);
        if (claimed) {
          queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
          uploadPromises.push(
            claimed.then(async (parts) => {
              if (!parts || parts.length === 0) throw new Error('Matching upload failed');
              await registerDuplicateParts(file, fileHash, parts, destination.resolvedFolderId);
              done();
            }).catch((err) => failed('register', err)),
          );
          return;
        }
        claimedHashes.set(fileHash, new Promise((resolve) => { publishParts = resolve; }));
      }

      queue.dispatch({ type: 'setStatus', id, attempt, status: 'uploading', now: Date.now() });

      if (batchStorageTarget.storage_mode === 'saved_messages' && isAlbumEligibleMedia(file) && file.size <= SINGLE_PATH_SIZE_LIMIT) {
        uploadPromises.push(
          albumPipeline.enqueue(file, fileHash, destination.resolvedFolderId, onProgress)
            .then((outcome) => {
              // 用 pipeline 回報的真實階段與原始錯誤，不要捏造一個 'Upload failed'
              // ——錯誤詳細資訊面板要的就是這個原因。
              if (!outcome.ok) { publishParts(null); failed(outcome.stage, outcome.error); return; }
              const res = outcome.result;
              publishParts([{
                filesize: res.size, mime_type: file.type || null,
                telegram_message_id: res.message_id, access_hash: res.access_hash,
                part_index: 0, has_thumbnail: res.has_thumbnail, telegram_user_id: res.account_id,
              }]);
              done();
            }).catch((err) => { publishParts(null); failed('telegram', err); }),
        );
        return;
      }

      // uploadFileSpread claims an account slot only after the hash check.
      // Its large-file path reads and sends bounded chunks incrementally.
      uploadPromises.push(
        uploadFileToTelegram(file, onProgress, fileHash)
          .then(async (result) => {
            if (!result.alreadyRegistered) {
              queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
              try {
                await registerUploadedParts(file, result.fileHash, result.parts, destination.resolvedFolderId);
              } catch (err) {
                // 位元組已經在 Telegram 上，失敗的只有註冊。報 'telegram' 會叫
                // 使用者重新上傳，實際上只要重新註冊就好。publishParts 在這條
                // 路徑上一樣被 settle，後面排隊的同內容檔案才不會永遠等下去。
                publishParts(null);
                failed('register', err);
                return;
              }
            }
            publishParts(result.parts.map((part, i) => ({
              filesize: part.size, mime_type: file.type || null,
              telegram_message_id: part.message_id, access_hash: part.access_hash,
              part_index: i, has_thumbnail: i === 0 && part.has_thumbnail,
              telegram_user_id: part.account_id,
            })));
            done();
          }).catch((err) => { publishParts(null); failed('telegram', err); }),
      );
    });

    // flush() must see every album enqueue. Uploads have already started while
    // these routing promises settle, so this wait is not an upload barrier.
    await Promise.allSettled(routingPromises);
    await Promise.allSettled([...uploadPromises, albumPipeline.flush()]);

    logChunkRates('batch done');

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

    // Upload one file's bytes to Telegram. Called only for files already proven
    // fresh (not a duplicate) — hash check happens before this is invoked.
    // Does NOT register metadata — that happens after the caller releases
    // fileSemaphore, so a slow backend never blocks the next file's bytes.
    const uploadFileEntryFresh = async (file: File, onProgress?: SplitUploadProgress): Promise<{
      parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number; account_id: number }>;
      hasThumbnail: boolean;
    }> => {
      const { thumb: thumbBlob, undecodable } = await captureThumb(file);
      // Media files must carry a thumbnail — fail rather than register a
      // thumbless media file. Non-media files legitimately have none, and so
      // does a video the browser cannot decode (`undecodable`).
      if (isMediaFile(file) && !thumbBlob && !undecodable) {
        throw new Error(`Thumbnail capture failed for ${file.name}`);
      }
      const uploadResult = await uploadFileSpread(file, onProgress, thumbBlob);
      return { parts: uploadResult.parts, hasThumbnail: uploadResult.hasThumbnail };
    };

    const registerFolderFileParts = async (
      file: File,
      fileHash: string | null,
      folderId: string | null,
      parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number; account_id: number }>,
      hasThumbnail: boolean,
    ): Promise<void> => {
      assertPartsCoverFile(file, parts);
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
          telegramUserId: part.account_id,
        })
      ));
    };

    // Fresh images/videos ≤10MB go through the same producer/consumer album
    // pipeline as the drag-drop path: an account slot only gates the byte-upload
    // step, grouping into SendMultiMedia + registration happen outside it.
    const SMALL_FILE_LIMIT = 10 * 1024 * 1024;
    const albumPipeline = createAlbumPipeline();

    // Batch-scoped content dedup. The folder walk streams files, so two
    // identical files can both miss
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
            const folderPath = basePath.replace(/\/$/, '');
            const enqueuedId = queue.enqueueFile(file, {
              rootFolderId: parentFolderId,
              relativePath: folderPath,
              folderResolved: false,        // ensureFolder() 尚未回報
              resolvedFolderId: null,
            });
            const discoveryPromise = (async (): Promise<void> => {
              const folderId = await ensureFolder(folderPath);
              queue.dispatch({ type: 'setResolved', id: enqueuedId, attempt: 1, resolvedFolderId: folderId, now: Date.now() });

              // 快速判定：目的資料夾已有同名同大小的檔案就整個跳過。這條路徑不做內容
              // 雜湊，因此不會與既有失敗列合併——但先前失敗的檔案本來就不會在目的地，
              // 所以實務上碰不到。
              const alreadyThere = await existingFolderFiles(folderPath);
              if (alreadyThere.get(file.name) === file.size) {
                queue.dispatch({ type: 'setHash', id: enqueuedId, attempt: 1, contentHash: null, now: Date.now() });
                const settled = queue.dispatch({ type: 'complete', id: enqueuedId, attempt: 1, now: Date.now() });
                void settled;
                return;
              }

              queue.dispatch({ type: 'setStatus', id: enqueuedId, attempt: 1, status: 'hashing', now: Date.now() });
              const fileHash = await hashFileBounded(file);
              const settled = queue.dispatch({ type: 'setHash', id: enqueuedId, attempt: 1, contentHash: fileHash, now: Date.now() });
              const resolution = settled.resolutions[enqueuedId];
              if (!resolution || resolution.outcome === 'discarded') return;
              const id = resolution.targetId;
              const attempt = resolution.attempt;
              queue.holdFile(id, file);

              const done = () => { queue.dispatch({ type: 'complete', id, attempt, now: Date.now() }); queue.releaseFile(id); };
              const failed = (stage: UploadErrorStage, err: unknown) => {
                queue.dispatch({ type: 'fail', id, attempt, stage, message: safeErrorMessage(err), now: Date.now() });
                queue.releaseFile(id);
              };
              const onProgress: SplitUploadProgress = (pct, detail) => queue.dispatch(
                detail?.reason === 'migration'
                  ? { type: 'migrationProgressReset', id, attempt, progress: pct, message: detail.message, now: Date.now() }
                  : { type: 'setProgress', id, attempt, progress: pct, now: Date.now() },
              );

              // hashFileBounded 把讀取錯誤吞成 null，所以雜湊為 null 時再讀一個
              // 位元組，分辨「算不出雜湊」與「檔案已經讀不到了」。此處還沒搶
              // claim（fileHash 為 null 時根本不會建 claim），提早 return 安全。
              if (!fileHash) {
                try {
                  await file.slice(0, 1).arrayBuffer();
                } catch (err) {
                  failed('hash', err);
                  return;
                }
              }

              // 後端去重命中：直接註冊中繼資料，不碰 Telegram。
              if (fileHash) {
                const hashCheck = await checkFileHashBounded(fileHash);
                const asExisting = hashCheck.found ? canonicalExistingParts(hashCheck.files, file.size) : [];
                if (asExisting.length > 0) {
                  queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
                  try {
                    await registerDuplicateParts(file, fileHash, asExisting, folderId);
                    done();
                  } catch (err) {
                    failed('register', err);
                  }
                  return;
                }
                if (hashCheck.files.length > 0) {
                  console.warn('[Upload] Hash matched but stored copy is incomplete, re-uploading:', file.name);
                }
              }

              // 批次內去重：搶到 claim 的人負責真的上傳，其餘的人排在它後面只註冊。
              // get/set 這一對必須保持同步，否則兩個同內容的 discovery 會同時搶到。
              const claim: { publish: (parts: RegisterableExistingPart[] | null) => void } = { publish: () => {} };
              if (fileHash) {
                const claimed = claimedHashes.get(fileHash);
                if (claimed) {
                  queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
                  // 排進 uploadPromises 而不是在這裡 await：discovery promise 內等 claim
                  // 會讓 album pipeline 的尾批永遠等不到 flush。
                  uploadPromises.push((async () => {
                    const parts = await claimed;
                    if (!parts || parts.length === 0) throw new Error('來源檔案上傳失敗');
                    await registerDuplicateParts(file, fileHash, parts, folderId);
                    done();
                  })().catch((err) => failed('register', err)));
                  return;
                }
                claimedHashes.set(fileHash, new Promise((resolve) => { claim.publish = resolve; }));
              }

              queue.dispatch({ type: 'setStatus', id, attempt, status: 'uploading', now: Date.now() });

              // 過了 claim 之後每條路徑都必須把它 settle 掉，排在後面的檔案才不會永遠等下去。
              try {
                if (isAlbumEligibleMedia(file) && file.size <= SMALL_FILE_LIMIT) {
                  uploadPromises.push(
                    albumPipeline.enqueue(file, fileHash, folderId, onProgress)
                      .then((outcome) => {
                        // 保留 pipeline 回報的階段與原始錯誤，不要捏造「上傳失敗」。
                        if (!outcome.ok) { claim.publish(null); failed(outcome.stage, outcome.error); return; }
                        const res = outcome.result;
                        claim.publish([{
                          filesize: file.size, mime_type: file.type || null,
                          telegram_message_id: res.message_id, access_hash: res.access_hash,
                          part_index: 0, has_thumbnail: res.has_thumbnail, telegram_user_id: res.account_id,
                        }]);
                        done();
                      })
                      .catch((err) => { claim.publish(null); failed('telegram', err); }),
                  );
                  return;
                }

                uploadPromises.push(
                  uploadFileEntryFresh(file, onProgress)
                    .then(async (result) => {
                      queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
                      try {
                        await registerFolderFileParts(file, fileHash, folderId, result.parts, result.hasThumbnail);
                      } catch (err) {
                        // 位元組已經上去了，失敗的只有註冊——報 'register'。
                        // claim 一樣在這條路徑上被 settle。
                        claim.publish(null);
                        failed('register', err);
                        return;
                      }
                      claim.publish(result.parts.map((part, j) => ({
                        filesize: part.size, mime_type: file.type || null,
                        telegram_message_id: part.message_id, access_hash: part.access_hash,
                        part_index: j, has_thumbnail: j === 0 && result.hasThumbnail,
                      })));
                      done();
                    })
                    .catch((err) => { claim.publish(null); failed('telegram', err); }),
                );
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

    const rootEntries = Array.from({ length: items.length }, (_, i) => items[i].webkitGetAsEntry?.()).filter(Boolean);
    await Promise.all(rootEntries.map((e) => processEntry(e, '')));

    // All files have been routed (dedup-registered, enqueued into the album
    // pipeline, or queued for single-file upload) — safe to flush the tail
    // album batch now without waiting for any other in-flight upload.
    await Promise.allSettled(discoveryPromises);
    await albumPipeline.flush();
    await Promise.allSettled(uploadPromises);

    logChunkRates('batch done');

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
    setPreviewError(null);
    setPreviewProgress(null);
    const kind = fileKind(original.mime_type, original.filename);
    setPreviewIndex(kind === 'image' ? galleryImages.findIndex((f) => f.file_id === original.file_id) : null);

    if (kind === 'video') return; // video streams via Service Worker, no blob download
    try {
      const cachedUrl = galleryUrlsRef.current.get(original.file_id);
      const blob = cachedUrl
        ? null
        : await fetchFileBlob(original, (received, total) => setPreviewProgress({ received, total }));
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
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewProgress(null);
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

  // Tell main.tsx a video stream is starting. The chunk-serving gate it keeps
  // is shut by closePreview() below, and the serving path cannot reopen it —
  // without this signal the second video of a session (and every one after it)
  // is answered 503 'Streaming stopped' until the page is reloaded.
  useLayoutEffect(() => {
    if (!previewFile?.mime_type?.startsWith('video/')) return;
    window.dispatchEvent(new CustomEvent('teledrive:start-streaming'));
  }, [previewFile?.file_id, previewFile?.mime_type]);

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
    setPreviewError(null);
    setPreviewProgress(null);
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
        { label: '永久刪除', icon: '🗑️', danger: true, onClick: () => setPurgeConfirm({ ids }) },
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

      <UploadCenter
        state={queue.state}
        isVideoPreviewOpen={previewFile !== null && fileKind(previewFile.mime_type, previewFile.filename) === 'video'}
        onFilter={(filter) => queue.dispatch({ type: 'setFilter', filter })}
        onQuery={(query) => queue.dispatch({ type: 'setQuery', query })}
        onToggleCompleted={() => queue.dispatch({ type: 'toggleCompleted' })}
        onErrorDetail={(id) => queue.dispatch({ type: 'setErrorDetail', id })}
        onPanelMode={(mode, byUser) => queue.dispatch({ type: 'setPanelMode', mode, byUser })}
        onClearTerminal={() => queue.dispatch({ type: 'clearTerminal' })}
      />
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
                <TbBtn onClick={() => setPurgeConfirm({ ids: new Set(selectedFiles) })} danger>🗑️ 永久刪除</TbBtn>
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
              onClick={() => setShowImportChat(true)}
              style={{ background: 'var(--td-accent)', border: 'none', cursor: 'pointer', color: 'white', fontSize: '14px', padding: '8px 16px', borderRadius: '6px', fontWeight: 500 }}
            >
              匯入 chat
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
        data-testid="drive-scroll"
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

      {purgeConfirm && (
        <ConfirmDialog
          message={`確定要永久移除 ${purgeConfirm.ids.size} 個 TeleDrive 紀錄嗎？Telegram Saved Messages 中的原始訊息會保留；此動作無法復原。`}
          confirmLabel="永久移除紀錄"
          danger
          onConfirm={() => { const ids = purgeConfirm.ids; setPurgeConfirm(null); performPurge(ids); }}
          onCancel={() => setPurgeConfirm(null)}
        />
      )}

      {emptyTrashConfirm && (
        <ConfirmDialog
          message="確定要清空垃圾桶嗎？這只會永久移除 TeleDrive 紀錄，Telegram Saved Messages 中的原始訊息會保留；此動作無法復原。"
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

      {showImportChat && (
        <ImportChatDialog
          onClose={() => setShowImportChat(false)}
          onDone={() => { void loadContents(); }}
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
                previewUrl
                  ? <img src={previewUrl} alt={previewFile.filename} decoding="async"
                      style={{ minWidth: 200, minHeight: 200, maxWidth: '100%', maxHeight: 'calc(90vh - 100px)', objectFit: 'contain' }} />
                  : <PreviewStatus error={previewError} progress={previewProgress} />
              ) : kind === 'video' ? (
                <video
                  src={previewFile.is_split_file && previewFile.split_group_id
                    ? `/preview-video/split/${previewFile.split_group_id}`
                    : streamPreviewUrl(previewFile)}
                  controls autoPlay style={{ maxWidth: '100%', maxHeight: 'calc(90vh - 100px)' }} />
              ) : kind === 'pdf' ? (
                previewUrl ? <iframe src={previewUrl} title={previewFile.filename} style={{ width: '80vw', height: 'calc(90vh - 100px)', border: 'none' }} />
                  : <PreviewStatus error={previewError} progress={previewProgress} />
              ) : kind === 'audio' ? (
                previewUrl ? <div style={{ padding: 40 }}><audio src={previewUrl} controls autoPlay style={{ width: 360, maxWidth: '80vw' }} /></div>
                  : <PreviewStatus error={previewError} progress={previewProgress} />
              ) : kind === 'text' ? (
                previewText !== null
                  ? <pre style={{ margin: 0, padding: 16, maxWidth: '80vw', maxHeight: 'calc(90vh - 120px)', overflow: 'auto', fontSize: 13, color: 'var(--td-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{previewText}</pre>
                  : <PreviewStatus error={previewError} progress={previewProgress} />
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
function VideoPreviewLoader({ fileId, locationVersion }: { fileId: string; locationVersion: number }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const src = `/preview-video/${encodeURIComponent(fileId)}/${locationVersion}`;

  useEffect(() => {
    const video = document.createElement('video');
    video.src = src;
    const onCanPlay = () => setLoading(false);
    const onError = () => { setLoading(false); setError('Failed to load video'); };
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('error', onError);
    const timeout = setTimeout(() => setLoading(false), 3000);
    return () => {
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('error', onError);
      clearTimeout(timeout);
    };
  }, [src]);

  return (
    <div style={{ padding: '8px', minHeight: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {loading && <div style={{ textAlign: 'center', color: '#6b7280' }}><div style={{ fontSize: '24px', marginBottom: '8px' }}>⏳</div><div>Loading video...</div></div>}
      {error && <div style={{ color: '#dc2626', textAlign: 'center' }}>{error}</div>}
      <video src={src} controls autoPlay style={{ maxWidth: '100%', maxHeight: 'calc(90vh - 100px)', display: loading ? 'none' : 'block' }} />
    </div>
  );
}

export { VideoPreviewLoader };
