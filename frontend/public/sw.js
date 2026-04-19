const CACHE_NAME = 'teledrive-sw-v1';
const VIDEO_PREVIEW_PATH = '/preview-video/';

// Buffer preload state for next chunk while current plays
let preloadState = null;

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
    preloadState = null;
  }
});

function parseRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader) {
    return { offset: 0, limit: 0, valid: false, error: 416 };
  }
  // Handle formats: "bytes=0-1023" (specific end) and "bytes=0-" (no end specified)
  const rangeRegex = /^bytes=(\d+)-(\d*)$/;
  const match = rangeHeader.match(rangeRegex);
  if (!match) {
    return { offset: 0, limit: 0, valid: false, error: 416 };
  }
  const start = parseInt(match[1], 10);
  const endStr = match[2];
  
  if (start >= totalSize) {
    return { offset: 0, limit: 0, valid: false, error: 416 };
  }
  
  let offset;
  let limit;
  
  if (endStr && endStr.length > 0) {
    // Specific end specified: "bytes=0-1023"
    const end = parseInt(endStr, 10);
    offset = start;
    limit = end - start + 1;
  } else {
    // No end specified: "bytes=0-" - get everything from start to end of file
    offset = start;
    limit = totalSize - start;
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
    return {
      fileId: parts[0],
      messageId: parts[1],
    };
  }
  return null;
}

/**
 * Request file chunk from main app via postMessage
 * Includes retry logic with exponential backoff (1s, 2s, 4s)
 */
async function requestChunkFromApp(fileId, messageId, offset, limit) {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s
  
  // Helper: Send request to main app via MessageChannel
  function sendChunkRequest() {
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

  // Helper: Check if Telegram needs reconnection
  async function checkTelegramConnection() {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const requestId = `check_${Date.now()}`;
      const timeout = setTimeout(() => {
        channel.port1.close();
        resolve(false); // Assume disconnected on timeout
      }, 5000);

      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        channel.port1.close();
        if (event.data?.type === 'CONNECTION_STATUS') {
          resolve(event.data.connected === true);
        } else {
          resolve(false);
        }
      };

      self.clients.matchAll().then((clients) => {
        for (const client of clients) {
          client.postMessage({
            type: 'CHECK_CONNECTION',
            requestId,
          }, [channel.port2]);
        }
        if (clients.length === 0) {
          clearTimeout(timeout);
          channel.port1.close();
          resolve(false);
        }
      });
    });
  }

  // Retry loop with exponential backoff
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log('[ServiceWorker] Chunk request attempt', attempt + 1, '/', MAX_RETRIES + 1);
      
      // If this is a retry (not first attempt), check connection first
      if (attempt > 0) {
        console.log(`[ServiceWorker] Retry attempt ${attempt}/${MAX_RETRIES} for chunk offset=${offset}, waiting ${RETRY_DELAYS[attempt - 1]}ms...`);
        
        // Wait with exponential backoff
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
        
        // Check if Telegram needs reconnection
        const isConnected = await checkTelegramConnection();
        if (!isConnected) {
          console.log('[ServiceWorker] Telegram disconnected, triggering reconnect...');
          // Send reconnect request to main app
          await new Promise((resolve) => {
            const channel = new MessageChannel();
            self.clients.matchAll().then((clients) => {
              for (const client of clients) {
                client.postMessage({ type: 'RECONNECT_TELEGRAM' }, [channel.port2]);
              }
              // Wait briefly for reconnect to happen
              setTimeout(resolve, 2000);
            });
          });
        }
      }
      
      // Attempt to get chunk
      const chunk = await sendChunkRequest();
      if (attempt > 0) {
        console.log(`[ServiceWorker] Retry successful on attempt ${attempt} for chunk offset=${offset}`);
      }
      return chunk;
      
    } catch (error) {
      lastError = error;
      console.log(`[ServiceWorker] Chunk request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${error.message}`);
      
      // If this was the last attempt, throw the error
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Chunk request failed after ${MAX_RETRIES + 1} attempts: ${error.message}`);
      }
    }
  }
  
  // Should never reach here, but just in case
  throw lastError || new Error('Unknown error in chunk request');
}

/**
 * Get file metadata (size and mimeType) from main app
 */
async function requestFileMetadata(fileId, messageId) {
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
function preloadNextChunk(fileId, messageId, currentOffset, limit, fileSize) {
  const nextOffset = currentOffset + limit;
  if (nextOffset >= fileSize) {
    console.log('[ServiceWorker] Skipping preload - at end of file');
    return;
  }

  if (preloadState?.inProgress && 
      preloadState.fileId === fileId && 
      preloadState.messageId === messageId &&
      preloadState.offset === nextOffset) {
    console.log('[ServiceWorker] Already preloading next chunk');
    return;
  }
  
  console.log('[ServiceWorker] Preloading next chunk, offset:', nextOffset);
  
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
      preloadState.data = data;
      preloadState.inProgress = false;
      console.log('[ServiceWorker] Preloaded next chunk, size:', data.byteLength);
    })
    .catch((err) => {
      console.error('[ServiceWorker] Preload failed:', err);
      preloadState.inProgress = false;
    });
}

/**
 * Check if we have preloaded data for the requested range
 */
function getPreloadedChunk(fileId, messageId, offset, limit) {
  if (preloadState && 
      preloadState.fileId === fileId && 
      preloadState.messageId === messageId &&
      preloadState.offset === offset &&
      preloadState.data) {
    console.log('[ServiceWorker] Using preloaded chunk, size:', preloadState.data.byteLength);
    const data = preloadState.data;
    preloadState = null;
    return data;
  }
  return null;
}

// Fetch event handler - intercept requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  console.log('[ServiceWorker] Fetch intercepted:', url.pathname, 'range:', event.request.headers.get('Range'));

  // Only handle /preview-video/* routes - let others pass through
  if (!url.pathname.startsWith(VIDEO_PREVIEW_PATH)) {
    console.log('[ServiceWorker] Non-video route - letting through:', url.pathname);
    return; // Don't call respondWith - let browser handle normally
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

  const rangeHeader = getRangeHeader(event.request);
  console.log('[ServiceWorker] Range header:', rangeHeader);

  if (!rangeHeader) {
    console.log('[ServiceWorker] No Range header - returning 416');
    event.respondWith(
      new Response(null, {
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: { 'Content-Range': 'bytes */0' },
      })
    );
    return;
  }

  // Phase 3.2: Get file metadata to know actual size, then process Range
  event.respondWith(
    (async () => {
      try {
        console.log('[ServiceWorker] Requesting file metadata...');
        const metadata = await requestFileMetadata(urlParams.fileId, urlParams.messageId);
        console.log('[ServiceWorker] Got metadata - size:', metadata.size, 'mimeType:', metadata.mimeType);

        const rawRange = parseRangeHeader(rangeHeader, metadata.size);

        if (!rawRange.valid) {
          console.log('[ServiceWorker] Invalid Range - returning 416');
          return new Response(null, {
            status: 416,
            statusText: 'Range Not Satisfiable',
            headers: { 'Content-Range': `bytes */${metadata.size}` },
          });
        }

        const ALIGN = 4096;
        const MAX_CHUNK = 512 * 1024;
        const available = metadata.size - rawRange.offset;
        const boundedLimit = Math.min(rawRange.limit, available);
        const maxBytes = Math.floor(Math.min(boundedLimit, MAX_CHUNK) / ALIGN) * ALIGN;
        const limit = Math.max(Math.min(boundedLimit, maxBytes), ALIGN);

        console.log('[ServiceWorker] Raw Range - offset:', rawRange.offset, 'limit:', rawRange.limit);
        console.log('[ServiceWorker] Aligned Range - offset:', rawRange.offset, 'limit:', limit, '(aligned to 4KB)');

        // Check preloaded chunk first (Phase 3.4 - buffer preload)
        const preloaded = getPreloadedChunk(urlParams.fileId, urlParams.messageId, rawRange.offset, limit);

        let chunkData;

        if (preloaded) {
          console.log('[ServiceWorker] Using preloaded chunk');
          chunkData = preloaded;
        } else {
          console.log('[ServiceWorker] Requesting chunk from main app... offset:', rawRange.offset, 'limit:', limit);
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
          limit,
          metadata.size
        );

        // Return HTTP 206 Partial Content
        const responseEndByte = Math.min(rawRange.offset + rawRange.limit, metadata.size) - 1;
        
        // Trim the chunk if it was larger due to 4KB alignment
        // The API might return more bytes than needed (e.g., request 512KB but get 516KB aligned)
        let responseData = chunkData;
        let contentLength = chunkData.byteLength;
        
        if (chunkData.byteLength > actualBytesNeeded) {
          console.log('[ServiceWorker] Trimming aligned chunk from', chunkData.byteLength, 'to', actualBytesNeeded);
          responseData = chunkData.slice(0, actualBytesNeeded);
          contentLength = actualBytesNeeded;
        }
        
        return new Response(responseData, {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Type': metadata.mimeType || 'video/mp4',
            'Content-Range': `bytes ${rawRange.offset}-${responseEndByte}/${metadata.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': contentLength,
            'Cache-Control': 'no-cache',
          },
        });
      } catch (err) {
        // Phase 3.3: Handle download errors gracefully
        console.error('[ServiceWorker] Error:', err?.message || err);
        const errorMessage = err?.message || 'Unknown error';
        return new Response(JSON.stringify({ error: errorMessage }), {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'application/json' },
        });
      }
    })()
  );
});
