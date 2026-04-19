import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getTelegramClient } from './lib/gramjs';

// Global state for keepalive mechanism
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
let lastChunkTime = Date.now();
const IDLE_TIMEOUT_MS = 30000; // 30 seconds
const KEEPALIVE_INTERVAL_MS = 15000; // 15 seconds
let isStreamingActive = false;

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
function startKeepalive() {
  if (keepaliveInterval) {
    console.log('[App] keepalive already running, skipping start');
    return;
  }
  
  console.log('[App] === STARTING KEEPALIVE INTERVAL ===');
  isStreamingActive = true;
  
  keepaliveInterval = setInterval(async () => {
    console.log('[App] ===== KEEPALIVE TICK =====');
    lastChunkTime = Date.now();
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

/**
 * Stop keepalive interval when streaming is idle.
 */
function stopKeepalive() {
  if (keepaliveInterval) {
    console.log('[App] Stopping keepalive interval');
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

/**
 * Check if we should stop keepalive (idle for 30 seconds).
 */
function checkIdleTimeout() {
  const now = Date.now();
  if (now - lastChunkTime > IDLE_TIMEOUT_MS) {
    stopKeepalive();
  }
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
  const { requestId, messageId, offset, limit } = msg;
  const port = event.ports[0];
  
  try {
    // Start keepalive when streaming begins
    console.log('[App] Calling startKeepalive()...');
    startKeepalive();
    lastChunkTime = Date.now();
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
    
    let arrayBuffer: ArrayBuffer;
    
    try {
      const blob = await telegramClient.downloadFileChunkedByOffset(messageId, offset, limit);
      arrayBuffer = await blob.arrayBuffer();
      console.log('[App] Got chunk, size:', arrayBuffer.byteLength);
    } catch (chunkErr: any) {
      console.error('[App] Chunked download failed, falling back to full download:', chunkErr?.message);
      const fullBlob = await telegramClient.downloadFile(messageId, 'video/mp4');
      arrayBuffer = await fullBlob.arrayBuffer();
      console.log('[App] Full file downloaded, size:', arrayBuffer.byteLength);
    }
    
    port?.postMessage({ requestId, chunk: arrayBuffer }, [arrayBuffer]);
    console.log('[App] ========== handleGetFileChunk END ==========');
    
  } catch (err: any) {
    console.error('[App] Error getting chunk:', err?.message || err);
    console.error('[App] Stack:', err?.stack);
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
