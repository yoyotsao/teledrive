/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

// Cache name for future use (Phase 2+)
const CACHE_NAME = 'teledrive-sw-v1';
const VIDEO_PREVIEW_PATH = '/preview-video/';

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
    // This case shouldn't happen due to regex, but handle it
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

  // Phase 2: Handle Range header for video requests
  const rangeHeader = getRangeHeader(event.request);
  console.log('[ServiceWorker] Range header:', rangeHeader);

  if (rangeHeader) {
    // Parse Range header - for now assume a mock total size
    // In Phase 3, we'll get actual file size from Telegram
    // Using a placeholder total size - in real implementation,
    // we'll first fetch file metadata to get the actual size
    const MOCK_TOTAL_SIZE = 10 * 1024 * 1024; // 10MB placeholder
    const range = parseRangeHeader(rangeHeader, MOCK_TOTAL_SIZE);

    if (!range.valid) {
      // Return 416 Range Not Satisfiable
      console.log('[ServiceWorker] Invalid Range - returning 416');
      event.respondWith(
        new Response(null, {
          status: 416,
          statusText: 'Range Not Satisfiable',
          headers: {
            'Content-Range': `bytes */${MOCK_TOTAL_SIZE}`,
          },
        })
      );
      return;
    }

    // Range is valid - pass through to network with Range header
    // In Phase 3, we'll fetch partial data from Telegram
    console.log('[ServiceWorker] Valid Range - offset:', range.offset, 'limit:', range.limit);
    event.respondWith(fetch(event.request));
  } else {
    // No Range header - per requirement 2.3, return 416
    // Note: This is strict interpretation. Some servers return full content.
    // For video streaming, Range header should always be present.
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
  }
});

// Expose cache name for potential future use
export { CACHE_NAME };