import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getTelegramClient } from './lib/gramjs';

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
  });
  
  console.log('[App] Service Worker message handler set up');
}

/**
 * Handle GET_FILE_CHUNK request from Service Worker
 * Uses GramJS to download a chunk from Telegram
 */
async function handleGetFileChunk(event: MessageEvent) {
  const msg = event.data;
  const { requestId, messageId, offset, limit } = msg;
  const port = event.ports[0];
  
  try {
    const telegramClient = getTelegramClient();
    
    if (!telegramClient.isConnected()) {
      port?.postMessage({ requestId, error: 'Telegram client not connected' });
      return;
    }
    
    console.log('[App] Getting chunk - messageId:', messageId, 'offset:', offset, 'limit:', limit);
    
    // Use GramJS to download chunk
    const blob = await telegramClient.downloadFileChunkedByOffset(
      messageId, 
      offset, 
      limit
    );
    
    // Convert Blob to ArrayBuffer for transfer
    const arrayBuffer = await blob.arrayBuffer();
    
    console.log('[App] Got chunk, size:', arrayBuffer.byteLength);
    
    // Send chunk back to Service Worker
    port?.postMessage({ requestId, chunk: arrayBuffer }, [arrayBuffer]);
    
  } catch (err: any) {
    console.error('[App] Error getting chunk:', err?.message || err);
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
