import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getTelegramClient } from './lib/gramjs';

// Global state for keepalive mechanism
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
const KEEPALIVE_INTERVAL_MS = 15000; // 15 seconds
let isStreamingActive = false;
// Set to true when the user closes the video; reset when a new video opens.
// Preload chunk requests that arrive after close are rejected immediately.
let streamingStopped = false;

/**
 * Ensure Telegram is connected, reconnect if needed.
 * Returns true if connected, false otherwise.
 */
async function ensureTelegramConnected(): Promise<boolean> {
  console.log('[App] === ensureTelegramConnected START ===');
  const telegramClient = getTelegramClient();
  
  // Instead of just checking isConnected(), actually try a ping
  // to verify the connection is truly alive
  try {
    const pingSuccess = await telegramClient.invokePing();
    console.log('[App] ping result:', pingSuccess);
    if (pingSuccess) {
      console.log('[App] === ensureTelegramConnected: ALREADY CONNECTED (ping success) ===');
      return true;
    }
  } catch (err: any) {
    console.log('[App] ping failed:', err?.message || err);
  }
  
  console.log('[App] Telegram not responding, attempting reconnection...');
  
  try {
    // Try to reconnect the client
    await telegramClient.connect();
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
  streamingStopped = true;
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

// ChonkyDrive dispatches this when the video preview closes
window.addEventListener('teledrive:stop-streaming', () => {
  stopKeepalive();
});

function startKeepalive() {
  if (keepaliveInterval) {
    console.log('[App] keepalive already running, skipping start');
    return;
  }

  console.log('[App] === STARTING KEEPALIVE INTERVAL ===');
  streamingStopped = false; // new video opened — allow chunk requests again
  isStreamingActive = true;
  
  keepaliveInterval = setInterval(async () => {
    console.log('[App] ===== KEEPALIVE TICK =====');

    const telegramClient = getTelegramClient();
    
    // Instead of just checking isConnected(), actually try to make an API call
    // to verify the connection is truly alive
    try {
      // Try a simple API call to verify connection
      await telegramClient.invokePing();
      console.log('[App] Keepalive: connection truly ALIVE (ping success)');
    } catch (err: any) {
      console.log('[App] Keepalive: ping failed, connection likely dead:', err?.message || err);
      console.log('[App] Keepalive: attempting reconnect...');
      try {
        await telegramClient.connect();
        console.log('[App] Keepalive: RECONNECTED');
      } catch (reconnectErr: any) {
        console.error('[App] Keepalive: reconnect failed:', reconnectErr?.message || reconnectErr);
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
}

// Register Service Worker with cache-busting (use timestamp for always-fresh SW)
const SW_VERSION = Date.now();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`/sw.js?v=${SW_VERSION}`)
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
    const telegramClient = getTelegramClient();
    const connected = telegramClient?.isConnected() === true;
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
    const telegramClient = getTelegramClient();
    if (telegramClient) {
      const wasConnected = telegramClient.isConnected() === true;
      if (wasConnected) {
        console.log('[App] Telegram already connected');
        port?.postMessage({ type: 'RECONNECT_RESULT', requestId, success: true, alreadyConnected: true });
      } else {
        // Use the connect() method which handles reconnection properly
        await telegramClient.connect();
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
  const { requestId, messageId, offset, limit, fileSize } = msg;
  const port = event.ports[0];
  
  try {
    // Reject preload requests that arrive after the user closed the video
    if (streamingStopped) {
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
    
    const telegramClient = getTelegramClient();

    console.log('[App] Getting chunk - messageId:', messageId, 'offset:', offset, 'limit:', limit, 'fileSize:', fileSize);
    
    let actualFileSize = fileSize;
    if (actualFileSize === undefined) {
      console.log('[App] fileSize not provided, fetching metadata...');
      const metadata = await telegramClient.downloadFileMetadata(messageId);
      actualFileSize = metadata.size;
      console.log('[App] Retrieved fileSize from Telegram:', actualFileSize);
    }
    
    const blob = await telegramClient.downloadFileChunkedByOffset(messageId, offset, limit, actualFileSize);
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
  const { requestId, messageId } = msg;
  const port = event.ports[0];
  
  try {
    const telegramClient = getTelegramClient();
    
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
      return { messageId: p.telegram_message_id as number, size: p.filesize as number, startOffset };
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
