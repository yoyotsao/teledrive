/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

// Cache name for future use (Phase 2+)
const CACHE_NAME = 'teledrive-sw-v1';
const VIDEO_PREVIEW_PATH = '/preview-video/';

// Buffer preload state for next chunk while current plays
interface PreloadState {
  fileId: string;
  messageId: string;
  offset: number;
  limit: number;
  data: ArrayBuffer | null;
  inProgress: boolean;
}

let preloadState: PreloadState | null = null;

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
    // Clear preload state
    preloadState = null;
  }
});

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
  retries = 3,
  baseDelay = 1000
): Promise<ArrayBuffer> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await requestChunkOnce(fileId, messageId, offset, limit);
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
  limit: number
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const channel = new MessageChannel();
    
    // Timeout after 30 seconds
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

    // Send request to all clients (main app)
    self.clients.matchAll().then((clients) => {
      for (const client of clients) {
        client.postMessage({
          type: 'GET_FILE_CHUNK',
          requestId,
          fileId,
          messageId: parseInt(messageId, 10),
          offset,
          limit,
        }, [channel.port2]);
      }
      
      // If no clients available, reject
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
 * Preload next chunk while current plays (Phase 3.4)
 */
function preloadNextChunk(
  fileId: string,
  messageId: string,
  currentOffset: number,
  limit: number
): void {
  // Don't preload if already preloading same range
  if (preloadState?.inProgress && 
      preloadState.fileId === fileId && 
      preloadState.messageId === messageId &&
      preloadState.offset === currentOffset + limit) {
    console.log('[ServiceWorker] Already preloading next chunk');
    return;
  }
  
  console.log('[ServiceWorker] Preloading next chunk, offset:', currentOffset + limit);
  
  preloadState = {
    fileId,
    messageId,
    offset: currentOffset + limit,
    limit,
    data: null,
    inProgress: true,
  };
  
  requestChunkFromApp(fileId, messageId, currentOffset + limit, limit)
    .then((data) => {
      preloadState!.data = data;
      preloadState!.inProgress = false;
      console.log('[ServiceWorker] Preloaded next chunk, size:', data.byteLength);
    })
    .catch((err) => {
      console.error('[ServiceWorker] Preload failed:', err);
      preloadState!.inProgress = false;
    });
}

/**
 * Check if we have preloaded data for the requested range
 */
function getPreloadedChunk(fileId: string, messageId: string, offset: number, _limit: number): ArrayBuffer | null {
  if (preloadState && 
      preloadState.fileId === fileId && 
      preloadState.messageId === messageId &&
      preloadState.offset === offset &&
      preloadState.data) {
    console.log('[ServiceWorker] Using preloaded chunk, size:', preloadState.data.byteLength);
    const data = preloadState.data;
    preloadState = null; // Clear after use
    return data;
  }
  return null;
}

// Fetch event handler - intercept requests
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  console.log('[ServiceWorker] Fetch intercepted:', url.pathname);

  // For now, only handle /preview-video/* routes
  // Return 404 for non-video routes (Phase 1 requirement)
  if (!url.pathname.startsWith(VIDEO_PREVIEW_PATH)) {
    console.log('[ServiceWorker] Non-video route - returning 404:', url.pathname);
    event.respondWith(
      new Response(null, {
        status: 404,
        statusText: 'Not Found',
      })
    );
    return;
  }

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

        // Telegram API requires limit to be divisible by 4096 for precise downloads
        // Round up to nearest 4096 multiple
        const CHUNK_ALIGNMENT = 4096;
        const alignedLimit = Math.ceil(rawRange.limit / CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT;
        // Don't exceed file size
        const limit = Math.min(alignedLimit, metadata.size - rawRange.offset);
        
        console.log('[ServiceWorker] Raw Range - offset:', rawRange.offset, 'limit:', rawRange.limit);
        console.log('[ServiceWorker] Aligned Range - offset:', rawRange.offset, 'limit:', limit, '(aligned to 4KB)');

        // Check preloaded chunk first (Phase 3.4 - buffer preload)
        const preloaded = getPreloadedChunk(urlParams.fileId, urlParams.messageId, rawRange.offset, limit);
        
        let chunkData: ArrayBuffer;
        
        if (preloaded) {
          console.log('[ServiceWorker] Using preloaded chunk');
          chunkData = preloaded;
        } else {
          // Request chunk from main app via postMessage
          console.log('[ServiceWorker] Requesting chunk from main app...');
          chunkData = await requestChunkFromApp(
            urlParams.fileId,
            urlParams.messageId,
            rawRange.offset,
            limit
          );
          console.log('[ServiceWorker] Got chunk, size:', chunkData.byteLength);
        }

        // Preload next chunk while current plays (Phase 3.4)
        preloadNextChunk(
          urlParams.fileId,
          urlParams.messageId,
          rawRange.offset,
          limit
        );

        // Return HTTP 206 Partial Content
        // Use the ACTUAL bytes returned (may be larger than requested due to alignment)
        const actualEndByte = Math.min(rawRange.offset + limit, metadata.size);
        const responseEndByte = Math.min(rawRange.offset + rawRange.limit, metadata.size) - 1;
        
        return new Response(chunkData, {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Type': metadata.mimeType || 'video/mp4',
            'Content-Range': `bytes ${rawRange.offset}-${responseEndByte}/${metadata.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkData.byteLength),
            'Cache-Control': 'no-cache',
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
