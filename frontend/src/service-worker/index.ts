/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

// Cache name for future use (Phase 2+)
const CACHE_NAME = 'teledrive-sw-v1';
const VIDEO_PREVIEW_PATH = '/preview-video/';
const SPLIT_PREVIEW_PATH = '/preview-video/split/';

// Rolling lookahead buffer — preloads PRELOAD_AHEAD chunks concurrently so the
// video element never stalls waiting for the next chunk to download.
const PRELOAD_AHEAD = 3; // 3 × 512 KB = 1.5 MB rolling buffer

interface PreloadEntry {
  data: ArrayBuffer | null;
  inProgress: boolean;
}

// key = `${fileId}:${messageId}:${offset}`
const preloadCache = new Map<string, PreloadEntry>();

function preloadKey(fileId: string, messageId: string, offset: number): string {
  return `${fileId}:${messageId}:${offset}`;
}

// Split file parts cache (keyed by splitGroupId)
interface SplitPartInfo {
  messageId: number;
  size: number;
  startOffset: number;
}
interface SplitCacheEntry {
  totalSize: number;
  mimeType: string;
  parts: SplitPartInfo[];
}
const splitPartsCache = new Map<string, SplitCacheEntry>();

// Install event handler
self.addEventListener('install', (_event: ExtendableEvent) => {
  console.log('[ServiceWorker] Install event triggered');
  self.skipWaiting();
});

// Activate event handler
self.addEventListener('activate', (event: ExtendableEvent) => {
  console.log('[ServiceWorker] Activate event triggered');
  event.waitUntil(self.clients.claim());
});

// Cleanup on SW uninstall (Phase 3.5)
self.addEventListener('install', () => {
  console.log('[ServiceWorker] Installing - cleanup on uninstall');
});

self.addEventListener('activate', () => {
  console.log('[ServiceWorker] Activating - cleanup scheduled');
});

// Cleanup when SW is being replaced
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEANUP') {
    console.log('[ServiceWorker] Cleanup message received');
    preloadCache.clear();
    splitPartsCache.clear();
  }
});

/**
 * Request split file metadata (total size + parts) from main app
 */
function requestSplitMetadata(splitGroupId: string): Promise<SplitCacheEntry> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Split metadata request timeout'));
    }, 15000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (event.data?.error) reject(new Error(event.data.error));
      else if (event.data?.metadata) resolve(event.data.metadata as SplitCacheEntry);
      else reject(new Error('Invalid split metadata response'));
    };
    self.clients.matchAll().then((clients) => {
      for (const client of clients) {
        client.postMessage({ type: 'GET_SPLIT_METADATA', splitGroupId }, [channel.port2]);
      }
      if (clients.length === 0) {
        clearTimeout(timeout);
        channel.port1.close();
        reject(new Error('No clients available'));
      }
    });
  });
}

/**
 * Find which part a global offset belongs to and return the part-relative offset
 */
function findPartForOffset(parts: SplitPartInfo[], globalOffset: number): { part: SplitPartInfo; partOffset: number } | null {
  for (const part of parts) {
    if (globalOffset >= part.startOffset && globalOffset < part.startOffset + part.size) {
      return { part, partOffset: globalOffset - part.startOffset };
    }
  }
  return null;
}

// Range header parsing result
interface RangeResult {
  offset: number;
  limit: number; // number of bytes to read
  valid: boolean;
  error?: number; // HTTP status code for error
}

/**
 * Parse Range header: bytes=start-end
 * Supported formats:
 *   - bytes=0-1023       : from offset 0, read 1024 bytes
 *   - bytes=0-          : from offset 0, read to end
 *   - bytes=-1024       : last 1024 bytes (offset = total - 1024)
 * 
 * Returns RangeResult with offset/limit or error status
 */
function parseRangeHeader(rangeHeader: string | null, totalSize: number): RangeResult {
  // No Range header - return 416
  if (!rangeHeader) {
    return { offset: 0, limit: 0, valid: false, error: 416 };
  }

  // Parse: bytes=start-end
  const rangeRegex = /^bytes=(\d+)-(\d*)$/;
  const match = rangeHeader.match(rangeRegex);

  if (!match) {
    // Malformed Range header - return 416
    return { offset: 0, limit: 0, valid: false, error: 416 };
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : null;

  // Validate start is within bounds
  if (start >= totalSize) {
    return { offset: 0, limit: 0, valid: false, error: 416 };
  }

  let offset: number;
  let limit: number;

  if (end !== null) {
    // Format: bytes=start-end
    offset = start;
    limit = end - start + 1;
  } else if (match[2] === '') {
    // Format: bytes=start- (read to end)
    offset = start;
    limit = totalSize - start;
  } else {
    // Format: bytes=-1024 (last N bytes)
    offset = totalSize - start;
    limit = start;
  }

  return { offset, limit, valid: true };
}

/**
 * Get Range header value
 */
function getRangeHeader(request: Request): string | null {
  return request.headers.get('Range');
}

/**
 * Parse URL to extract fileId and messageId
 * URL format: /preview-video/{fileId}/{messageId}
 */
function parseVideoUrl(pathname: string): { fileId: string; messageId: string } | null {
  const parts = pathname.replace(VIDEO_PREVIEW_PATH, '').split('/');
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return {
      fileId: parts[0],
      messageId: parts[1],
    };
  }
  return null;
}

/**
 * Request file chunk from main app via postMessage
 * With retry logic for failed chunks (max 3 retries with exponential backoff)
 */
async function requestChunkFromApp(
  fileId: string,
  messageId: string,
  offset: number,
  limit: number,
  fileSize?: number,
  retries = 3,
  baseDelay = 1000
): Promise<ArrayBuffer> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await requestChunkOnce(fileId, messageId, offset, limit, fileSize);
    } catch (err: any) {
      lastError = err;
      
      // Don't retry on client unavailable errors - they're not recoverable
      if (err?.message?.includes('No clients available') || 
          err?.message?.includes('main app may not be running')) {
        throw err;
      }
      
      // Exponential backoff before retry
      if (attempt < retries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[ServiceWorker] Chunk request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error('Chunk request failed after retries');
}

/**
 * Single attempt to request chunk from main app
 */
function requestChunkOnce(
  fileId: string,
  messageId: string,
  offset: number,
  limit: number,
  fileSize?: number
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const channel = new MessageChannel();
    
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error(`Chunk request timeout: offset=${offset}, limit=${limit}`));
    }, 30000);

    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      
      if (event.data?.error) {
        reject(new Error(event.data.error));
      } else if (event.data?.chunk) {
        resolve(event.data.chunk);
      } else {
        reject(new Error('Invalid response from main app'));
      }
    };

    self.clients.matchAll().then((clients) => {
      for (const client of clients) {
        client.postMessage({
          type: 'GET_FILE_CHUNK',
          requestId,
          fileId,
          messageId: parseInt(messageId, 10),
          offset,
          limit,
          fileSize,
        }, [channel.port2]);
      }
      
      if (clients.length === 0) {
        clearTimeout(timeout);
        channel.port1.close();
        reject(new Error('No clients available - main app may not be running'));
      }
    });
  });
}

/**
 * Get file metadata (size and mimeType) from main app
 */
async function requestFileMetadata(fileId: string, messageId: string): Promise<{ size: number; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const requestId = `meta_${Date.now()}`;
    const channel = new MessageChannel();
    
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Metadata request timeout'));
    }, 10000);

    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      
      if (event.data?.error) {
        reject(new Error(event.data.error));
      } else if (event.data?.metadata) {
        resolve(event.data.metadata);
      } else {
        reject(new Error('Invalid metadata response'));
      }
    };

    self.clients.matchAll().then((clients) => {
      for (const client of clients) {
        client.postMessage({
          type: 'GET_FILE_METADATA',
          requestId,
          fileId,
          messageId: parseInt(messageId, 10),
        }, [channel.port2]);
      }
      
      if (clients.length === 0) {
        clearTimeout(timeout);
        channel.port1.close();
        reject(new Error('No clients available'));
      }
    });
  });
}

/**
 * Kick off parallel preloads for the next PRELOAD_AHEAD chunks after currentOffset.
 * Already-cached or in-progress offsets are skipped.
 * Evicts entries that are behind currentOffset or beyond the lookahead window.
 */
function preloadAhead(
  fileId: string,
  messageId: string,
  currentOffset: number,
  chunkSize: number,
  fileSize: number
): void {
  // Evict stale entries (behind current position or beyond window)
  const maxAheadOffset = currentOffset + (PRELOAD_AHEAD + 1) * chunkSize;
  for (const key of preloadCache.keys()) {
    const parts = key.split(':');
    const entryOffset = parseInt(parts[2], 10);
    if (entryOffset < currentOffset || entryOffset > maxAheadOffset) {
      preloadCache.delete(key);
    }
  }

  // Schedule PRELOAD_AHEAD chunks ahead
  for (let i = 1; i <= PRELOAD_AHEAD; i++) {
    const nextOffset = currentOffset + i * chunkSize;
    if (nextOffset >= fileSize) break;

    const key = preloadKey(fileId, messageId, nextOffset);
    if (preloadCache.has(key)) continue;

    const entry: PreloadEntry = { data: null, inProgress: true };
    preloadCache.set(key, entry);

    requestChunkFromApp(fileId, messageId, nextOffset, chunkSize, fileSize)
      .then((data) => {
        const e = preloadCache.get(key);
        if (e) { e.data = data; e.inProgress = false; }
      })
      .catch(() => {
        preloadCache.delete(key); // will be retried on next request
      });
  }
}

/**
 * Return and evict a preloaded chunk if ready, or null if still downloading.
 */
function consumePreloadedChunk(fileId: string, messageId: string, offset: number): ArrayBuffer | null {
  const key = preloadKey(fileId, messageId, offset);
  const entry = preloadCache.get(key);
  if (entry?.data) {
    preloadCache.delete(key);
    return entry.data;
  }
  return null;
}

// Fetch event handler - intercept requests
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  console.log('[ServiceWorker] Fetch intercepted:', url.pathname);

  if (!url.pathname.startsWith(VIDEO_PREVIEW_PATH)) {
    console.log('[ServiceWorker] Non-video route - passing through:', url.pathname);
    return;
  }

  // ── Split file streaming ───────────────────────────────────────────────
  if (url.pathname.startsWith(SPLIT_PREVIEW_PATH)) {
    const splitGroupId = url.pathname.slice(SPLIT_PREVIEW_PATH.length);
    const rangeHeader = getRangeHeader(event.request);

    event.respondWith((async () => {
      try {
        // Get (or fetch) parts metadata
        let entry = splitPartsCache.get(splitGroupId);
        if (!entry) {
          entry = await requestSplitMetadata(splitGroupId);
          splitPartsCache.set(splitGroupId, entry);
        }
        const { totalSize, mimeType, parts } = entry;

        if (!rangeHeader) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}`, 'Accept-Ranges': 'bytes' },
          });
        }

        const rawRange = parseRangeHeader(rangeHeader, totalSize);
        if (!rawRange.valid) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}` },
          });
        }

        // Align limit to 4KB, cap at 512KB
        const ALIGN = 4096;
        const MAX_CHUNK = 512 * 1024;
        const available = totalSize - rawRange.offset;
        const boundedLimit = Math.min(rawRange.limit, available);
        const limit = Math.max(Math.floor(Math.min(boundedLimit, MAX_CHUNK) / ALIGN) * ALIGN, ALIGN);

        // Find which part owns this offset
        const found = findPartForOffset(parts, rawRange.offset);
        if (!found) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${totalSize}` } });
        }
        const { part, partOffset } = found;

        // Clip limit to stay within the current part (browser will request next part separately)
        const bytesLeftInPart = part.size - partOffset;
        const effectiveLimit = Math.min(limit, bytesLeftInPart);

        const chunkData = await requestChunkFromApp(
          splitGroupId,
          String(part.messageId),
          partOffset,
          effectiveLimit,
          part.size
        );

        // Preload next PRELOAD_AHEAD chunks within the same part
        preloadAhead(splitGroupId, String(part.messageId), partOffset, effectiveLimit, part.size);

        const responseEndByte = rawRange.offset + chunkData.byteLength - 1;
        return new Response(chunkData, {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Type': mimeType || 'video/mp4',
            'Content-Range': `bytes ${rawRange.offset}-${responseEndByte}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkData.byteLength),
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        });
      } catch (err: any) {
        console.error('[ServiceWorker] Split chunk error:', err?.message);
        return new Response(JSON.stringify({ error: err?.message || 'Unknown error' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    })());
    return;
  }
  // ── End split file streaming ───────────────────────────────────────────

  // Phase 3: Parse fileId and messageId from URL
  const urlParams = parseVideoUrl(url.pathname);
  if (!urlParams) {
    console.log('[ServiceWorker] Invalid URL format - returning 400');
    event.respondWith(
      new Response(null, {
        status: 400,
        statusText: 'Bad Request - URL should be /preview-video/{fileId}/{messageId}',
      })
    );
    return;
  }

  console.log('[ServiceWorker] Parsed URL - fileId:', urlParams.fileId, 'messageId:', urlParams.messageId);

  // Handle request with Range header
  const rangeHeader = getRangeHeader(event.request);
  console.log('[ServiceWorker] Range header:', rangeHeader);

  if (!rangeHeader) {
    // No Range header - return 416
    console.log('[ServiceWorker] No Range header - returning 416');
    event.respondWith(
      new Response(null, {
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: {
          'Content-Range': 'bytes */0',
        },
      })
    );
    return;
  }

  // Phase 3.2: Get file metadata to know actual size, then process Range
  event.respondWith(
    (async () => {
      try {
        // Get file metadata
        console.log('[ServiceWorker] Requesting file metadata...');
        const metadata = await requestFileMetadata(urlParams.fileId, urlParams.messageId);
        console.log('[ServiceWorker] Got metadata - size:', metadata.size, 'mimeType:', metadata.mimeType);

        // Parse Range header with actual file size
        const rawRange = parseRangeHeader(rangeHeader, metadata.size);

        if (!rawRange.valid) {
          // Return 416 Range Not Satisfiable
          console.log('[ServiceWorker] Invalid Range - returning 416');
          return new Response(null, {
            status: 416,
            statusText: 'Range Not Satisfiable',
            headers: {
              'Content-Range': `bytes */${metadata.size}`,
            },
          });
        }

        const ALIGN = 4096;
        const MAX_CHUNK = 512 * 1024;
        const available = metadata.size - rawRange.offset;
        const boundedLimit = Math.min(rawRange.limit, available);
        const maxBytes = Math.floor(Math.min(boundedLimit, MAX_CHUNK) / ALIGN) * ALIGN;
        const limit = Math.max(Math.min(boundedLimit, maxBytes), ALIGN);
        
        console.log('[ServiceWorker] Raw Range - offset:', rawRange.offset, 'limit:', rawRange.limit);
        console.log('[ServiceWorker] File size:', metadata.size, 'Available:', available);
        console.log('[ServiceWorker] Aligned Range - offset:', rawRange.offset, 'limit:', limit, '(aligned to 4KB, capped at 512KB)');

        // Serve from lookahead buffer if already downloaded, else fetch now
        const preloaded = consumePreloadedChunk(urlParams.fileId, urlParams.messageId, rawRange.offset);

        let chunkData: ArrayBuffer;

        if (preloaded) {
          console.log('[ServiceWorker] Using preloaded chunk');
          chunkData = preloaded;
        } else {
          console.log('[ServiceWorker] Requesting chunk from main app...');
          chunkData = await requestChunkFromApp(
            urlParams.fileId,
            urlParams.messageId,
            rawRange.offset,
            limit,
            metadata.size
          );
          console.log('[ServiceWorker] Got chunk, size:', chunkData.byteLength);
        }

        // Immediately kick off preloading the next PRELOAD_AHEAD chunks in parallel
        preloadAhead(urlParams.fileId, urlParams.messageId, rawRange.offset, limit, metadata.size);

        const responseEndByte = rawRange.offset + chunkData.byteLength - 1;
        
        return new Response(chunkData, {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Type': metadata.mimeType || 'video/mp4',
            'Content-Range': `bytes ${rawRange.offset}-${responseEndByte}/${metadata.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkData.byteLength),
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        });
      } catch (err: any) {
        // Phase 3.3: Handle download errors gracefully
        // Phase 6.2: Improve error handling for disconnected Telegram client
        console.error('[ServiceWorker] Error:', err?.message || err);
        
        const errorMessage = err?.message || 'Unknown error';
        
        // Provide helpful error messages based on the error type
        let status = 503;
        let message = errorMessage;
        
        if (errorMessage.includes('not connected') || errorMessage.includes('client not connected')) {
          message = 'Telegram client disconnected. Please refresh the page and reconnect to Telegram in the app.';
        } else if (errorMessage.includes('No clients available') || errorMessage.includes('main app may not be running')) {
          message = 'Main application not running. Please refresh the page.';
        } else if (errorMessage.includes('timeout')) {
          message = 'Request timed out. Please check your connection and refresh.';
        }
        
        // Return 503 Service Unavailable with helpful message
        return new Response(JSON.stringify({ error: message }), {
          status: status,
          statusText: 'Service Unavailable',
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }
    })()
  );
});

// Expose cache name for potential future use
export { CACHE_NAME };
