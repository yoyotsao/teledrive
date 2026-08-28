import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getPrimaryClient, getClientFor, getAllClients } from './lib/gramjs';
import { StreamGate } from './lib/streamGate';

// Global state for keepalive mechanism
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
const KEEPALIVE_INTERVAL_MS = 15000; // 15 seconds
// Skip the getMe() ping in ensureTelegramConnected() if the connection was verified
// alive (by either the keepalive tick or a prior chunk request) within this window —
// avoids a round trip before every single 512KB SW chunk request.
const CONNECTION_CHECK_INTERVAL_MS = 20000;
let lastVerifiedAliveAt = 0;
let isStreamingActive = false;
// Shut when the user closes the video, reopened when a preview opens, so
// that preload chunk requests arriving after a close are rejected immediately.
const streamGate = new StreamGate();

/** Client for the account that stores a message. 0 (or unknown) = the primary. */
function clientForAccount(accountId?: number) {
  return accountId ? getClientFor(accountId) : getPrimaryClient();
}

/**
 * Ensure Telegram is connected, reconnect if needed.
 * Returns true if connected, false otherwise.
 */
async function ensureTelegramConnected(): Promise<boolean> {
  if (Date.now() - lastVerifiedAliveAt < CONNECTION_CHECK_INTERVAL_MS) {
    return true;
  }

  console.log('[App] === ensureTelegramConnected START ===');
  // Every account, not just the primary — a stream can be served by any of them.
  const clients = getAllClients();

  // Instead of just checking isConnected(), actually try a ping
  // to verify the connection is truly alive
  try {
    const pings = await Promise.all(clients.map((c) => c.invokePing().catch(() => false)));
    const pingSuccess = pings.length > 0 && pings.every(Boolean);
    console.log('[App] ping result:', pingSuccess);
    if (pingSuccess) {
      lastVerifiedAliveAt = Date.now();
      console.log('[App] === ensureTelegramConnected: ALREADY CONNECTED (ping success) ===');
      return true;
    }
  } catch (err: any) {
    console.log('[App] ping failed:', err?.message || err);
  }

  console.log('[App] Telegram not responding, attempting reconnection...');

  try {
    // Try to reconnect every client
    await Promise.all(clients.map((c) => c.connect()));
    lastVerifiedAliveAt = Date.now();
    console.log('[App] Telegram reconnected successfully');
    console.log('[App] === ensureTelegramConnected: RECONNECTED ===');
    return true;
  } catch (err: any) {
    console.error('[App] Failed to reconnect:', err?.message || err);
    console.log('[App] === ensureTelegramConnected: FAILED ===');
  }

  return false;
}

/**
 * Start periodic keepalive ping to prevent connection drops.
 */
function stopKeepalive() {
  isStreamingActive = false;
  streamGate.closed();
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

// ChonkyDrive dispatches this when the video preview closes
window.addEventListener('teledrive:stop-streaming', () => {
  stopKeepalive();
});

// ...and this when one opens. Without it the gate stays shut after the first
// close: handleGetFileChunk consults the gate BEFORE it reaches startKeepalive(),
// so nothing on the serving path can ever reopen it — every later video would
// answer 503 until the page was reloaded.
window.addEventListener('teledrive:start-streaming', () => {
  streamGate.opened();
});

function startKeepalive() {
  if (keepaliveInterval) {
    console.log('[App] keepalive already running, skipping start');
    return;
  }

  console.log('[App] === STARTING KEEPALIVE INTERVAL ===');
  isStreamingActive = true;
  
  keepaliveInterval = setInterval(async () => {
    console.log('[App] ===== KEEPALIVE TICK =====');

    const clients = getAllClients();
    
    // Instead of just checking isConnected(), actually try to make an API call
    // to verify the connection is truly alive
    try {
      // Try a simple API call to verify connection
      await Promise.all(clients.map((c) => c.invokePing()));
      lastVerifiedAliveAt = Date.now();
      console.log('[App] Keepalive: connection truly ALIVE (ping success)');
    } catch (err: any) {
      console.log('[App] Keepalive: ping failed, connection likely dead:', err?.message || err);
      console.log('[App] Keepalive: attempting reconnect...');
      try {
        await Promise.all(clients.map((c) => c.connect()));
        lastVerifiedAliveAt = Date.now();
        console.log('[App] Keepalive: RECONNECTED');
      } catch (reconnectErr: any) {
        console.error('[App] Keepalive: reconnect failed:', reconnectErr?.message || reconnectErr);
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
}

// Register Service Worker (nginx serves /sw.js with Cache-Control: no-cache,
// so the browser always revalidates and picks up updates without a cache-busting query string)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        console.log('[App] Service Worker registered:', registration.scope);
        
        // Listen for messages from Service Worker
        if (registration.active) {
          setupServiceWorkerMessageHandler();
        } else {
          // If not active yet, wait for controller change
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            setupServiceWorkerMessageHandler();
          });
        }
      })
      .catch((error) => {
        console.error('[App] Service Worker registration failed:', error);
      });
  });
}

/**
 * Handle messages from Service Worker
 * Service Worker requests file chunks via postMessage
 */
function setupServiceWorkerMessageHandler() {
  if (!navigator.serviceWorker) return;
  
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const msg = event.data;
    
    console.log('[App] Received SW message:', msg.type, 'requestId:', msg.requestId);
    
    // Handle file chunk request
    if (msg.type === 'GET_FILE_CHUNK') {
      await handleGetFileChunk(event);
    }
    // Handle metadata request
    else if (msg.type === 'GET_FILE_METADATA') {
      await handleGetFileMetadata(event);
    }
    // Handle split file metadata request
    else if (msg.type === 'GET_SPLIT_METADATA') {
      await handleGetSplitMetadata(event);
    }
    // Handle connection check from Service Worker
    else if (msg.type === 'CHECK_CONNECTION') {
      await handleCheckConnection(event);
    }
    // Handle reconnect request from Service Worker
    else if (msg.type === 'RECONNECT_TELEGRAM') {
      await handleReconnectTelegram(event);
    }
  });
  
  console.log('[App] Service Worker message handler set up');
}

/**
 * Handle CHECK_CONNECTION request from Service Worker
 * Returns current Telegram connection status
 */
async function handleCheckConnection(event: MessageEvent) {
  const msg = event.data;
  const { requestId } = msg;
  const port = event.ports[0];
  
  try {
    const clients = getAllClients();
    const connected = clients.length > 0 && clients.every((c) => c.isConnected());
    port?.postMessage({ type: 'CONNECTION_STATUS', requestId, connected });
  } catch (error) {
    port?.postMessage({ type: 'CONNECTION_STATUS', requestId, connected: false });
  }
}

/**
 * Handle RECONNECT_TELEGRAM request from Service Worker
 * Triggers reconnection to Telegram
 */
async function handleReconnectTelegram(event: MessageEvent) {
  const msg = event.data;
  const { requestId } = msg;
  const port = event.ports[0];
  
  try {
    console.log('[App] Reconnecting Telegram due to SW request...');
    const clients = getAllClients();
    if (clients.length > 0) {
      const wasConnected = clients.every((c) => c.isConnected());
      if (wasConnected) {
        console.log('[App] Telegram already connected');
        port?.postMessage({ type: 'RECONNECT_RESULT', requestId, success: true, alreadyConnected: true });
      } else {
        // Use the connect() method which handles reconnection properly
        await Promise.all(clients.map((c) => c.connect()));
        console.log('[App] Telegram reconnected successfully');
        port?.postMessage({ type: 'RECONNECT_RESULT', requestId, success: true, alreadyConnected: false });
      }
    } else {
      port?.postMessage({ type: 'RECONNECT_RESULT', requestId, success: false, error: 'No client' });
    }
  } catch (error) {
    console.error('[App] Failed to reconnect Telegram:', error);
    port?.postMessage({ type: 'RECONNECT_RESULT', requestId, success: false, error: String(error) });
  }
}

/**
 * Handle GET_FILE_CHUNK request from Service Worker
 * Uses GramJS to download a chunk from Telegram
 */
async function handleGetFileChunk(event: MessageEvent) {
  console.log('[App] ========== handleGetFileChunk START ==========');
  const msg = event.data;
  const { requestId, messageId, accountId, fileId, offset, limit, fileSize } = msg;
  const port = event.ports[0];
  
  try {
    // Reject preload requests that arrive after the user closed the video
    if (!streamGate.accepts()) {
      port?.postMessage({ requestId, error: 'Streaming stopped' });
      return;
    }

    // Start keepalive when streaming begins
    console.log('[App] Calling startKeepalive()...');
    startKeepalive();

    console.log('[App] startKeepalive called, isStreamingActive:', isStreamingActive);
    
    // Ensure Telegram is connected before downloading chunk
    console.log('[App] Calling ensureTelegramConnected()...');
    const isConnected = await ensureTelegramConnected();
    console.log('[App] ensureTelegramConnected result:', isConnected);
    
    if (!isConnected) {
      console.log('[App] ERROR: Telegram not connected, sending error to SW');
      port?.postMessage({ requestId, error: 'Telegram client not connected' });
      return;
    }
    
    // access_hash is per (account, document): the wrong client either fails or,
    // worse, hits a same-numbered message in ITS Saved Messages and streams the
    // wrong file. Pick by the account the SW passed along with the message id.
    const telegramClient = clientForAccount(accountId);

    console.log('[App] Getting chunk - messageId:', messageId, 'account:', accountId, 'offset:', offset, 'limit:', limit, 'fileSize:', fileSize);
    
    let actualFileSize = fileSize;
    if (actualFileSize === undefined) {
      console.log('[App] fileSize not provided, fetching metadata...');
      const metadata = await telegramClient.downloadFileMetadata(messageId);
      actualFileSize = metadata.size;
      console.log('[App] Retrieved fileSize from Telegram:', actualFileSize);
    }
    
    // Only pass file_id when it really is the Telegram document id — dedup rows
    // and split groups use synthetic ids that would false-alarm the guard.
    const expectedFileId = /^\d+$/.test(String(fileId ?? '')) ? String(fileId) : undefined;
    const blob = await telegramClient.downloadFileChunkedByOffset(messageId, offset, limit, actualFileSize, expectedFileId);
    const arrayBuffer = await blob.arrayBuffer();
    console.log('[App] Got chunk, size:', arrayBuffer.byteLength);
    
    port?.postMessage({ requestId, chunk: arrayBuffer }, [arrayBuffer]);
    console.log('[App] ========== handleGetFileChunk END ==========');
    
  } catch (err: any) {
    console.error('[App] Chunk download failed:', err?.message || err);
    port?.postMessage({ requestId, error: err?.message || 'Failed to get chunk' });
  }
}

/**
 * Handle GET_FILE_METADATA request from Service Worker
 * Gets file size and mimeType from Telegram
 */
async function handleGetFileMetadata(event: MessageEvent) {
  const msg = event.data;
  const { requestId, messageId, accountId } = msg;
  const port = event.ports[0];
  
  try {
    const telegramClient = clientForAccount(accountId);
    
    if (!telegramClient.isConnected()) {
      port?.postMessage({ requestId, error: 'Telegram client not connected' });
      return;
    }
    
    console.log('[App] Getting metadata for messageId:', messageId);
    
    // Get metadata from GramJS
    const metadata = await telegramClient.downloadFileMetadata(messageId);
    
    console.log('[App] Got metadata:', metadata);
    
    // Send metadata back to Service Worker
    port?.postMessage({ requestId, metadata });
    
  } catch (err: any) {
    console.error('[App] Error getting metadata:', err?.message || err);
    port?.postMessage({ requestId, error: err?.message || 'Failed to get metadata' });
  }
}

/**
 * Handle GET_SPLIT_METADATA request from Service Worker
 * Queries backend for all parts of a split file, returns total size + parts map
 */
async function handleGetSplitMetadata(event: MessageEvent) {
  const { splitGroupId } = event.data;
  const port = event.ports[0];
  try {
    const token = localStorage.getItem('tg_jwt');
    const response = await fetch(`/api/v1/files?split_group_id=${encodeURIComponent(splitGroupId)}&page_size=100`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`Failed to fetch split parts: ${response.status}`);
    const data = await response.json();

    const parts = (data.files as any[]).sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0));
    if (parts.length === 0) throw new Error('No parts found for split group');

    let totalSize = 0;
    const partsWithOffset = parts.map((p: any) => {
      const startOffset = totalSize;
      totalSize += p.filesize;
      // Parts of one split file may sit on different accounts — carry each
      // part's own so the SW can ask the right client for its bytes.
      return {
        messageId: p.telegram_message_id as number,
        accountId: (p.telegram_user_id as number) || 0,
        size: p.filesize as number,
        startOffset,
      };
    });

    const mimeType: string = parts[0]?.mime_type || 'video/mp4';
    port?.postMessage({ metadata: { totalSize, mimeType, parts: partsWithOffset } });
  } catch (err: any) {
    console.error('[App] handleGetSplitMetadata error:', err?.message);
    port?.postMessage({ error: err?.message || 'Failed to get split metadata' });
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
