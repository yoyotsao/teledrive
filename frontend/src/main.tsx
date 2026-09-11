import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getAllClients } from './lib/gramjs';
import { api } from './api/client';
import { resolveFileLocation } from './lib/fileLocationResolver';
import { fileInfoToLocation } from './lib/storageLocation';
import { MainWindowStreamBridge } from './lib/mainWindowStreamBridge';
import { StreamGate } from './lib/streamGate';

// Global state for keepalive mechanism
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
const KEEPALIVE_INTERVAL_MS = 15000; // 15 seconds
// Shut when the user closes the video, reopened when a preview opens, so
// that preload chunk requests arriving after a close are rejected immediately.
const streamGate = new StreamGate();

const streamBridge = new MainWindowStreamBridge({
  getFile: api.getFile,
  resolve: resolveFileLocation,
  readChunk: async (resolved, offset, length, file) => {
    const manager = resolved.manager as any;
    if (!manager?.downloadFileChunkedByOffset) {
      throw Object.assign(new Error('Main-window Telegram reader is unavailable'), { code: 'CLIENT_UNAVAILABLE' });
    }
    const frozenLocation = fileInfoToLocation(file);
    if (!frozenLocation) throw Object.assign(new Error('Missing canonical location'), { code: 'READ_UNAVAILABLE' });
    const blob = await manager.downloadFileChunkedByOffset(
      resolved.message.id,
      offset,
      length,
      resolved.media.size || file.filesize,
      resolved.media.id,
      resolved.media,
      async () => (await resolveFileLocation(frozenLocation, 'stream')).media,
    );
    return blob.arrayBuffer();
  },
});

/**
 * Start periodic keepalive ping to prevent connection drops.
 */
function stopKeepalive() {
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
  
  keepaliveInterval = setInterval(async () => {
    console.log('[App] ===== KEEPALIVE TICK =====');

    const clients = getAllClients();
    
    // Instead of just checking isConnected(), actually try to make an API call
    // to verify the connection is truly alive
    try {
      // Try a simple API call to verify connection
      await Promise.all(clients.map((c) => c.invokePing()));
      console.log('[App] Keepalive: connection truly ALIVE (ping success)');
    } catch (err: any) {
      console.log('[App] Keepalive: ping failed, connection likely dead:', err?.message || err);
      console.log('[App] Keepalive: attempting reconnect...');
      try {
        await Promise.all(clients.map((c) => c.connect()));
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
  const msg = event.data;
  const requestId = String(msg.request_id ?? msg.requestId ?? '');
  const port = event.ports[0];

  try {
    if (!streamGate.accepts()) {
      port?.postMessage({ request_id: requestId, error: 'CLIENT_UNAVAILABLE' });
      return;
    }
    startKeepalive();
    const result = await streamBridge.handle({
      request_id: requestId,
      file_id: String(msg.file_id ?? msg.fileId ?? ''),
      part_id: msg.part_id,
      location_version: Number(msg.location_version ?? 0),
      offset: Number(msg.offset ?? 0),
      length: Number(msg.length ?? msg.limit ?? 0),
    });
    if (result.error || !result.chunk) {
      port?.postMessage({ request_id: requestId, error: result.error ?? 'READ_UNAVAILABLE' });
      return;
    }
    port?.postMessage({ request_id: requestId, chunk: result.chunk }, [result.chunk]);
  } catch (err: any) {
    port?.postMessage({ request_id: requestId, error: err?.code || err?.message || 'READ_UNAVAILABLE' });
  }
}

/**
 * Handle GET_FILE_METADATA request from Service Worker
 * Gets file size and mimeType from Telegram
 */
async function handleGetFileMetadata(event: MessageEvent) {
  const msg = event.data;
  const requestId = String(msg.request_id ?? msg.requestId ?? '');
  const port = event.ports[0];
  const result = await streamBridge.metadata({
    request_id: requestId,
    file_id: String(msg.file_id ?? msg.fileId ?? ''),
    location_version: Number(msg.location_version ?? 0),
  });
  if (result.error) port?.postMessage({ request_id: requestId, error: result.error });
  else port?.postMessage({ request_id: requestId, metadata: result.metadata });
}

/**
 * Handle GET_SPLIT_METADATA request from Service Worker
 * Queries backend for all parts of a split file, returns total size + parts map
 */
async function handleGetSplitMetadata(event: MessageEvent) {
  const { splitGroupId } = event.data;
  const port = event.ports[0];
  try {
    const data = await api.getSplitGroupFiles(String(splitGroupId));
    const parts = [...data.files].sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0));
    if (parts.length === 0) throw new Error('No parts found for split group');

    let totalSize = 0;
    const partsWithOffset = parts.map((part) => {
      const startOffset = totalSize;
      totalSize += part.filesize;
      return {
        fileId: part.file_id,
        locationVersion: part.location_version ?? 0,
        size: part.filesize,
        startOffset,
      };
    });

    port?.postMessage({ metadata: {
      totalSize,
      mimeType: parts[0]?.mime_type || 'video/mp4',
      parts: partsWithOffset,
    } });
  } catch (err: any) {
    port?.postMessage({ error: err?.code || err?.message || 'READ_UNAVAILABLE' });
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
