const CACHE_NAME = 'teledrive-sw-v1';
const VIDEO_PREVIEW_PATH = '/preview-video/';
const SPLIT_PREVIEW_PATH = '/preview-video/split/';

// Buffer preload state for next chunk while current plays
let preloadState = null;

// Split file parts cache (keyed by splitGroupId)
const splitPartsCache = new Map();

// Install event handler
self.addEventListener('install', (_event) => {
  console.log('[ServiceWorker] Install event triggered');
  self.skipWaiting();
});

// Activate event handler
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activate event triggered');
  event.waitUntil(self.clients.claim());
});

// Cleanup when SW is being replaced
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEANUP') {
    console.log('[ServiceWorker] Cleanup message received');
    preloadState = null;
    splitPartsCache.clear();
  }
});

/**
 * Request split file metadata (total size + parts) from main app
 */
function requestSplitMetadata(splitGroupId) {
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
      else if (event.data?.metadata) resolve(event.data.metadata);
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
function findPartForOffset(parts, globalOffset) {
  for (const part of parts) {
    if (globalOffset >= part.startOffset && globalOffset < part.startOffset + part.size) {
      return { part, partOffset: globalOffset - part.startOffset };
    }
  }
  return null;
}

/**
 * Parse Range header: bytes=start-end
 */
function parseRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader) {
    return { offset: 0, limit: 0, valid: false, error: 416 };
  }

  const rangeRegex = /^bytes=(\d+)-(\d*)$/;
  const match = rangeHeader.match(rangeRegex);

  if (!match) {
    return { offset: 0, limit: 0, valid: false, error: 416 };
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : null;

  if (start >= totalSize) {
    return { offset: 0, limit: 0, valid: false, error: 416 };
  }

  let offset;
  let limit;

  if (end !== null) {
    offset = start;
    limit = end - start + 1;
  } else if (match[2] === '') {
    offset = start;
    limit = totalSize - start;
  } else {
    offset = totalSize - start;
    limit = start;
  }

  return { offset, limit, valid: true };
}

function getRangeHeader(request) {
  return request.headers.get('Range');
}

/**
 * Parse URL to extract fileId and messageId
 * URL format: /preview-video/{fileId}/{messageId}
 */
function parseVideoUrl(pathname) {
  const parts = pathname.replace(VIDEO_PREVIEW_PATH, '').split('/');
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return { fileId: parts[0], messageId: parts[1] };
  }
  return null;
}

/**
 * Request file chunk from main app via postMessage (with retry)
 */
async function requestChunkFromApp(fileId, messageId, offset, limit, fileSize, retries = 3, baseDelay = 1000) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await requestChunkOnce(fileId, messageId, offset, limit, fileSize);
    } catch (err) {
      lastError = err;
      if (err?.message?.includes('No clients available') || err?.message?.includes('main app may not be running')) {
        throw err;
      }
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
function requestChunkOnce(fileId, messageId, offset, limit, fileSize) {
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
function requestFileMetadata(fileId, messageId) {
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

function preloadNextChunk(fileId, messageId, currentOffset, limit, fileSize) {
  const nextOffset = currentOffset + limit;
  if (nextOffset >= fileSize) return;

  if (preloadState?.inProgress &&
      preloadState.fileId === fileId &&
      preloadState.messageId === messageId &&
      preloadState.offset === nextOffset) {
    return;
  }

  preloadState = { fileId, messageId, offset: nextOffset, limit, data: null, inProgress: true };

  requestChunkFromApp(fileId, messageId, nextOffset, limit, fileSize)
    .then((data) => {
      preloadState.data = data;
      preloadState.inProgress = false;
    })
    .catch((err) => {
      console.error('[ServiceWorker] Preload failed:', err);
      preloadState.inProgress = false;
    });
}

function getPreloadedChunk(fileId, messageId, offset) {
  if (preloadState &&
      preloadState.fileId === fileId &&
      preloadState.messageId === messageId &&
      preloadState.offset === offset &&
      preloadState.data) {
    const data = preloadState.data;
    preloadState = null;
    return data;
  }
  return null;
}

// Fetch event handler - intercept requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (!url.pathname.startsWith(VIDEO_PREVIEW_PATH)) {
    return;
  }

  // ── Split file streaming ───────────────────────────────────────────────
  if (url.pathname.startsWith(SPLIT_PREVIEW_PATH)) {
    const splitGroupId = url.pathname.slice(SPLIT_PREVIEW_PATH.length);
    const rangeHeader = getRangeHeader(event.request);

    event.respondWith((async () => {
      try {
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

        const ALIGN = 4096;
        const MAX_CHUNK = 512 * 1024;

        const found = findPartForOffset(parts, rawRange.offset);
        if (!found) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${totalSize}` } });
        }
        const { part, partOffset } = found;

        // Align partOffset DOWN to 4KB boundary (GramJS MTProto requirement)
        const alignedPartOffset = Math.floor(partOffset / ALIGN) * ALIGN;
        const sliceStart = partOffset - alignedPartOffset;

        const available = Math.min(rawRange.limit, totalSize - rawRange.offset);
        const rawLimit = Math.min(available, MAX_CHUNK);
        // Extend limit to cover sliceStart + rawLimit, rounded up to 4KB, capped at part size
        const adjustedLimit = Math.min(
          Math.ceil((sliceStart + rawLimit) / ALIGN) * ALIGN,
          part.size - alignedPartOffset
        );
        const effectiveLimit = Math.max(adjustedLimit, ALIGN);

        const chunkData = await requestChunkFromApp(
          splitGroupId,
          String(part.messageId),
          alignedPartOffset,
          effectiveLimit,
          part.size
        );

        preloadNextChunk(splitGroupId, String(part.messageId), alignedPartOffset, effectiveLimit, part.size);

        // Slice to exactly the bytes the browser requested (RFC 7233 + 4KB alignment fix)
        const sliceAvailable = Math.max(0, chunkData.byteLength - sliceStart);
        const bytesNeeded = Math.min(rawRange.limit, sliceAvailable);
        const responseData = bytesNeeded > 0
          ? chunkData.slice(sliceStart, sliceStart + bytesNeeded)
          : new ArrayBuffer(0);

        // If no data available (upload incomplete / beyond EOF), return 416 so browser
        // does not receive an invalid Content-Range (start > end) which crashes FFmpegDemuxer
        if (responseData.byteLength === 0) {
          return new Response(null, {
            status: 416,
            statusText: 'Range Not Satisfiable',
            headers: { 'Content-Range': `bytes */${totalSize}`, 'Accept-Ranges': 'bytes' },
          });
        }

        const responseEndByte = rawRange.offset + responseData.byteLength - 1;
        return new Response(responseData, {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Type': mimeType || 'video/mp4',
            'Content-Range': `bytes ${rawRange.offset}-${responseEndByte}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(responseData.byteLength),
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        });
      } catch (err) {
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

  // Single file streaming
  const urlParams = parseVideoUrl(url.pathname);
  if (!urlParams) {
    event.respondWith(new Response(null, { status: 400, statusText: 'Bad Request' }));
    return;
  }

  const rangeHeader = getRangeHeader(event.request);
  if (!rangeHeader) {
    event.respondWith(new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': 'bytes */0' },
    }));
    return;
  }

  event.respondWith((async () => {
    try {
      const metadata = await requestFileMetadata(urlParams.fileId, urlParams.messageId);
      const rawRange = parseRangeHeader(rangeHeader, metadata.size);

      if (!rawRange.valid) {
        return new Response(null, {
          status: 416,
          statusText: 'Range Not Satisfiable',
          headers: { 'Content-Range': `bytes */${metadata.size}` },
        });
      }

      const ALIGN = 4096;
      const MAX_CHUNK = 512 * 1024;

      // Align offset DOWN to 4KB boundary (GramJS MTProto requirement)
      const alignedOffset = Math.floor(rawRange.offset / ALIGN) * ALIGN;
      const sliceStart = rawRange.offset - alignedOffset;

      const available = Math.min(rawRange.limit, metadata.size - rawRange.offset);
      const rawLimit = Math.min(available, MAX_CHUNK);
      // Extend limit to cover sliceStart + rawLimit, rounded up to 4KB, capped at file size
      const adjustedLimit = Math.min(
        Math.ceil((sliceStart + rawLimit) / ALIGN) * ALIGN,
        metadata.size - alignedOffset
      );
      const limit = Math.max(adjustedLimit, ALIGN);

      const preloaded = getPreloadedChunk(urlParams.fileId, urlParams.messageId, alignedOffset);
      let chunkData;

      if (preloaded) {
        chunkData = preloaded;
      } else {
        chunkData = await requestChunkFromApp(
          urlParams.fileId,
          urlParams.messageId,
          alignedOffset,
          limit,
          metadata.size
        );
      }

      preloadNextChunk(urlParams.fileId, urlParams.messageId, alignedOffset, limit, metadata.size);

      // Slice to exactly the bytes the browser requested (RFC 7233 + 4KB alignment fix)
      const sliceAvailable = Math.max(0, chunkData.byteLength - sliceStart);
      const bytesNeeded = Math.min(rawRange.limit, sliceAvailable);
      const responseData = bytesNeeded > 0
        ? chunkData.slice(sliceStart, sliceStart + bytesNeeded)
        : new ArrayBuffer(0);

      // If no data available (upload incomplete / beyond EOF), return 416
      if (responseData.byteLength === 0) {
        return new Response(null, {
          status: 416,
          statusText: 'Range Not Satisfiable',
          headers: { 'Content-Range': `bytes */${metadata.size}`, 'Accept-Ranges': 'bytes' },
        });
      }

      const responseEndByte = rawRange.offset + responseData.byteLength - 1;
      return new Response(responseData, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'Content-Type': metadata.mimeType || 'video/mp4',
          'Content-Range': `bytes ${rawRange.offset}-${responseEndByte}/${metadata.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(responseData.byteLength),
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    } catch (err) {
      console.error('[ServiceWorker] Error:', err?.message || err);
      const errorMessage = err?.message || 'Unknown error';
      let message = errorMessage;
      if (errorMessage.includes('not connected') || errorMessage.includes('client not connected')) {
        message = 'Telegram client disconnected. Please refresh the page and reconnect.';
      } else if (errorMessage.includes('No clients available')) {
        message = 'Main application not running. Please refresh the page.';
      } else if (errorMessage.includes('timeout')) {
        message = 'Request timed out. Please check your connection and refresh.';
      }
      return new Response(JSON.stringify({ error: message }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      });
    }
  })());
});
