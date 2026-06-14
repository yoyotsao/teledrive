import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import { Api } from "telegram/tl";
import bigInt from "big-integer";
import { api } from "../api/client";
import { MAX_UPLOAD_CONCURRENCY, CHUNK_RETRY_COUNT } from "../config";
import { Semaphore } from "./semaphore";

/**
 * Redirect GramJS's Telegram WebSocket connections through the backend proxy.
 * Browsers block ws:// (plain WebSocket) from https:// pages. Our proxy accepts
 * wss:// (valid SSL via Cloudflare) and forwards to Telegram via plain ws://.
 * Called once before TelegramClient initialization when on HTTPS.
 */
function installTelegramWsProxy(): void {
  if ((window as any).__telegramWsProxyInstalled) return;
  (window as any).__telegramWsProxyInstalled = true;

  const OrigWebSocket = window.WebSocket;

  class TelegramProxiedWebSocket extends OrigWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      let finalUrl = url;
      if (url.includes('/apiws')) {
        try {
          const tgUrl = new URL(url);
          const port = tgUrl.port || '80';
          const proxyPath = `/api/v1/ws-proxy?host=${encodeURIComponent(tgUrl.hostname)}&port=${port}`;
          finalUrl = `wss://${window.location.host}${proxyPath}`;
        } catch {
          // keep original url on parse failure
        }
      }
      super(finalUrl, protocols);
    }
  }

  (window as any).WebSocket = TelegramProxiedWebSocket;
}

// Constants for split upload
const MAX_PARTS = 1000;
const PART_SIZE = 512 * 1024; // 512KB

// Module-level semaphore shared across all file uploads
const uploadSemaphore = new Semaphore(MAX_UPLOAD_CONCURRENCY);

/**
 * Generate a random BigInteger for fileId in SaveBigFilePart operations.
 * Uses big-integer library for compatibility with GramJS API.
 */
function generateRandomBigInt(): ReturnType<typeof bigInt> {
  // Generate 8 random bytes and convert to BigInteger
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  
  // Convert bytes to BigInteger-compatible value
  let result = bigInt(0);
  for (let i = 0; i < 8; i++) {
    result = result.shiftLeft(8).add(bigInt(bytes[i]));
  }
  
  return result;
}

/**
 * GramJS client wrapper for browser-based Telegram operations.
 * Manages direct MTProto connections to Telegram for file upload/download.
 */
export class TelegramClientManager {
  private client: TelegramClient | null = null;
  private session: StringSession | null = null;
  // Limit concurrent sendFile calls — parallel sendFile before "me" entity is cached causes ID 0 errors
  private readonly sendFileSemaphore = new Semaphore(2);

  /**
   * Initialize the Telegram client with API credentials and session.
   * @param apiId - Telegram API ID from my.telegram.org
   * @param apiHash - Telegram API Hash from my.telegram.org
   * @param sessionString - Saved session string for authentication
   */
  async initialize(apiId: number, apiHash: string, sessionString: string): Promise<void> {
    // On HTTPS, browsers block plain ws:// connections (mixed content).
    // Monkey-patch WebSocket so GramJS's Telegram connections are routed through
    // our backend proxy (/api/v1/ws-proxy), which forwards to Telegram via plain ws://.
    if (window.location.protocol === 'https:') {
      installTelegramWsProxy();
    }

    this.session = new StringSession(sessionString || "");

    this.client = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: window.location.protocol === 'https:',
      deviceModel: "TeleDrive Browser",
      appVersion: "1.0.0",
    });

    // Connect to Telegram
    await this.client.connect();
    
    // Check if session is valid by trying to get the current user
    try {
      const myself = await this.client.getMe() as { username?: string; firstName?: string };
      console.log('[GramJS] Connected as:', myself.username || myself.firstName);
    } catch (err) {
      console.warn('[GramJS] Session might need re-authentication:', err);
    }
  }

  /**
   * Send a file through sendFileSemaphore with retry on entity-ID-0 errors.
   * GramJS can fail with "Missing MTProto Entity ID 0" when concurrent sendFile
   * calls race before the "me" entity is cached; serialising them (max 2) and
   * refreshing the cache on failure fixes this.
   */
  private async sendFileLocked(params: any, maxRetries = 3): Promise<unknown> {
    return this.sendFileSemaphore.withSlot(async () => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await this.client!.sendFile("me", params);
        } catch (err: any) {
          const isEntityZero = err?.message?.includes('ID 0') || err?.message?.includes('Entity');
          if (isEntityZero && attempt < maxRetries - 1) {
            console.warn(`[GramJS] sendFile entity-0 error (attempt ${attempt + 1}), refreshing entity cache...`);
            try { await this.client!.getMe(); } catch { /* ignore */ }
            continue;
          }
          throw err;
        }
      }
    });
  }

  /**
   * Upload a file to Telegram Saved Messages.
   * @param file - The file to upload (Browser File object)
   * @returns Promise with upload result containing message_id, file_id, and access_hash
   */
  async uploadFile(file: File): Promise<{
    message_id: number;
    file_id: string;
    access_hash?: string;
  }> {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    // For browser File objects, convert to array buffer then to Buffer (polyfilled)
    const arrayBuffer = await file.arrayBuffer();
    const buffer = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));

    // Create a CustomFile with buffer for browser environment
    // Signature: CustomFile(name: string, size: number, path: string, buffer?: Buffer)
    const customFile = new CustomFile(file.name, file.size, "", buffer);

    // Send file to "me" (Saved Messages)
    const message = await this.client.sendFile("me", {
      file: customFile,
      workers: 4, // Use multiple workers for faster upload
    });

    // Extract media info from Api.Message
    const msg = message as Api.Message;
    const media = msg.media;

    // Get file_id and access_hash from document or photo
    let fileId = "";
    let accessHash: string | undefined;

    if (media) {
      // Use constructor name to identify media type
      const mediaConstructor = (media as { className?: string }).className;
      if (mediaConstructor === "MessageMediaDocument") {
        const doc = media as unknown as { document: { id: bigint; accessHash?: bigint } };
        fileId = String(doc.document.id);
        accessHash = doc.document.accessHash
          ? String(doc.document.accessHash)
          : undefined;
      } else if (mediaConstructor === "MessageMediaPhoto") {
        const photo = media as unknown as { photo: { id: bigint; accessHash?: bigint } };
        fileId = String(photo.photo.id);
        accessHash = photo.photo.accessHash
          ? String(photo.photo.accessHash)
          : undefined;
      }
    }

    return {
      message_id: msg.id,
      file_id: fileId,
      access_hash: accessHash,
    };
  }

  /**
   * Upload a thumbnail image to Telegram Saved Messages.
   * @param file - The thumbnail blob to upload
   * @param filename - The filename for the thumbnail
   * @returns Promise with upload result containing message_id and file_id
   */
  async uploadThumbnail(file: Blob, filename: string): Promise<{
    message_id: number;
    file_id: string;
  }> {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    // Convert Blob to array buffer then to Buffer (polyfilled)
    const arrayBuffer = await file.arrayBuffer();
    const buffer = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));

    // Create CustomFile for thumbnail
    const customFile = new CustomFile(filename, file.size, "", buffer);

    // Send thumbnail to Saved Messages
    const message = await this.client.sendFile("me", {
      file: customFile,
      workers: 2, // Fewer workers for thumbnails
    });

    // Extract message and media info
    const msg = message as Api.Message;
    const media = msg.media;

    // Get file_id from document or photo
    let fileId = "";
    if (media) {
      // Use constructor name to identify media type
      const mediaConstructor = (media as { className?: string }).className;
      if (mediaConstructor === "MessageMediaDocument") {
        const doc = media as unknown as { document: { id: bigint } };
        fileId = String(doc.document.id);
      } else if (mediaConstructor === "MessageMediaPhoto") {
        const photo = media as unknown as { photo: { id: bigint } };
        fileId = String(photo.photo.id);
      }
    }

    return {
      message_id: msg.id,
      file_id: fileId,
    };
  }

  /**
   * Upload a large file to Telegram using SaveBigFilePart API.
   * Automatically splits file into 512KB chunks and switches to new file
   * when partIndex reaches MAX_PARTS (3900 parts = 2GB).
   * 
   * @param file - The file to upload (Browser File object)
   * @returns Promise with upload results containing message_id, file_id, access_hash, and size for each part
   */
  async uploadFileSplit(file: File, onProgress?: (pct: number) => void): Promise<{
    parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number }>;
    originalName: string;
    totalParts: number;
  }> {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    const useBigFile = file.size > 10 * 1024 * 1024;
    console.log('[SplitUpload] File:', file.name, 'Size:', file.size, 'bytes, useBigFile:', useBigFile);

    if (!useBigFile) {
      console.log('[SplitUpload] Small file - using CustomFile approach');
      const arrayBuffer = await file.arrayBuffer();
      const buffer = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));
      const customFile = new CustomFile(file.name, file.size, "", buffer);

      const message = await this.sendFileLocked({
        file: customFile,
        workers: 4,
        forceDocument: true,
      });

      const msg = message as Api.Message;
      let fileId = "";
      let accessHash: string | undefined;

      if (msg.media) {
        const mediaConstructor = (msg.media as { className?: string }).className;
        if (mediaConstructor === "MessageMediaDocument") {
          const doc = msg.media as unknown as { document: { id: bigint; accessHash?: bigint } };
          fileId = String(doc.document.id);
          accessHash = doc.document.accessHash ? String(doc.document.accessHash) : undefined;
        } else if (mediaConstructor === "MessageMediaPhoto") {
          const photo = msg.media as unknown as { photo: { id: bigint; accessHash?: bigint } };
          fileId = String(photo.photo.id);
          accessHash = photo.photo.accessHash ? String(photo.photo.accessHash) : undefined;
        }
      }

      console.log('[SplitUpload] Small file uploaded, message_id:', msg.id);
      onProgress?.(100);
      return {
        parts: [{ message_id: msg.id, file_id: fileId, access_hash: accessHash, size: file.size }],
        originalName: file.name,
        totalParts: 1,
      };
    }

    const uploadedParts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number }> = [];
    let fileId = generateRandomBigInt();
    let segmentStartOffset = 0;
    let remainingSize = file.size;
    const totalChunks = Math.ceil(file.size / PART_SIZE);
    let completedChunks = 0;

    console.log('[SplitUpload] Large file - total parts:', totalChunks);

    const client = this.client;

    while (remainingSize > 0) {
      const partsInSegment = Math.min(MAX_PARTS, Math.ceil(remainingSize / PART_SIZE));
      const isBoundarySegment = partsInSegment === MAX_PARTS;
      const segmentSize = partsInSegment * PART_SIZE;
      
      console.log('[SplitUpload] Starting segment with', partsInSegment, 'parts, offset:', segmentStartOffset);
      
      // Upload all chunks in this segment in parallel (bounded by semaphore)
      const chunkPromises: Promise<void>[] = [];
      
      for (let i = 0; i < partsInSegment; i++) {
        const partIdx = i;
        const offset = segmentStartOffset + i * PART_SIZE;
        
        chunkPromises.push(
          uploadSemaphore.withSlot(async () => {
            const chunk = file.slice(offset, Math.min(offset + PART_SIZE, file.size));
            const arrayBuffer = await chunk.arrayBuffer();
            const bytes = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));
            
            for (let retry = 0; retry < CHUNK_RETRY_COUNT; retry++) {
              try {
                await client!.invoke(
                  new Api.upload.SaveBigFilePart({
                    fileId: fileId,
                    filePart: partIdx,
                    fileTotalParts: partsInSegment,
                    bytes: bytes,
                  })
                );
                completedChunks++;
                onProgress?.(Math.min(99, Math.round((completedChunks / totalChunks) * 100)));
                console.log('[SplitUpload] Part', partIdx, 'uploaded successfully');
                return;
              } catch (err: any) {
                console.error('[SplitUpload] Part', partIdx, 'attempt', retry + 1, 'FAILED:', err?.message || err);
                if (retry === CHUNK_RETRY_COUNT - 1) {
                  throw err;
                }
              }
            }
          })
        );
      }
      
      await Promise.all(chunkPromises);
      
      // Serial: send InputFileBig for this segment
      console.log('[SplitUpload] All chunks uploaded, sending file with', partsInSegment, 'parts...');
      
      const inputFileBig = new Api.InputFileBig({
        id: fileId,
        parts: partsInSegment,
        name: file.name,
      });

      try {
        const message = await this.sendFileLocked({ file: inputFileBig, forceDocument: true });
        const msg = message as Api.Message;
        console.log('[SplitUpload] File sent successfully, message_id:', msg?.id);
        const media = msg.media;

        let accessHash: string | undefined;
        if (media) {
          const mediaConstructor = (media as { className?: string }).className;
          if (mediaConstructor === "MessageMediaDocument") {
            const doc = media as unknown as { document: { id: bigint; accessHash?: bigint } };
            accessHash = doc.document.accessHash ? String(doc.document.accessHash) : undefined;
          }
        }

        uploadedParts.push({
          message_id: msg.id,
          file_id: String(fileId),
          access_hash: accessHash,
          size: isBoundarySegment ? Math.min(segmentSize, file.size) : segmentSize,
        });
        console.log('[SplitUpload] Segment registered, parts:', partsInSegment, 'size:', isBoundarySegment ? Math.min(segmentSize, file.size) : segmentSize, 'bytes');
      } catch (err: any) {
        console.error('[SplitUpload] SendFile FAILED:', err?.message || err);
        throw err;
      }

      fileId = generateRandomBigInt();
      segmentStartOffset += segmentSize;
      remainingSize -= segmentSize;
    }

    // Sort uploadedParts by segment order after parallel chunk collection
    uploadedParts.sort((a, b) => a.message_id - b.message_id);

    return {
      parts: uploadedParts,
      originalName: file.name,
      totalParts: uploadedParts.reduce((sum, p) => sum + Math.ceil(p.size / PART_SIZE), 0),
    };
  }

  /**
   * Download a thumbnail from Telegram by message_id.
   * @param messageId - The Telegram message ID of the thumbnail
   * @returns Promise with Blob of the thumbnail image
   */
  async downloadThumbnail(messageId: number): Promise<Blob> {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    // Get the message from Saved Messages
    const messages = await this.client.getMessages("me", { ids: [messageId] });
    const message = messages[0] as Api.Message;
    
    if (!message || !message.media) {
      throw new Error("Message not found or has no media");
    }

    // Download the media
    const buffer = await this.client.downloadMedia(message.media);
    
    if (!buffer) {
      throw new Error("Failed to download thumbnail");
    }

    // Convert Uint8Array to Blob
    return new Blob([buffer], { type: 'image/jpeg' });
  }

  /**
   * Download file metadata (size and mime type) from Telegram by message_id.
   * @param messageId - The Telegram message ID of the file
   * @returns Promise with { size: number; mimeType: string }
   */
  async downloadFileMetadata(messageId: number): Promise<{ size: number; mimeType: string }> {
    console.log('[FileMetadata] Getting metadata for message:', messageId);
    
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    // Get the message from Saved Messages
    const messages = await this.client.getMessages("me", { ids: [messageId] });
    const message = messages[0] as Api.Message;
    
    if (!message || !message.media) {
      throw new Error("No media found for message: " + messageId);
    }

    const media = message.media as any;
    let size = 0;
    let mimeType = 'application/octet-stream';

    if (media?.className === 'MessageMediaDocument') {
      const doc = media.document;
      if (!doc) {
        throw new Error("No document in media");
      }
      size = Number(doc.size || 0);
      mimeType = doc.mimeType || 'application/octet-stream';
    } else if (media?.className === 'MessageMediaPhoto') {
      const photo = media.photo;
      if (!photo) {
        throw new Error("No photo in media");
      }
      size = Number(photo.size || 0);
      mimeType = 'image/jpeg';
    } else {
      throw new Error("Unsupported media type: " + media?.className);
    }

    console.log('[FileMetadata] Got metadata - size:', size, 'mimeType:', mimeType);
    
    return { size, mimeType };
  }

  /**
   * Download a file from Telegram by message_id using chunked GetFile API.
   * @param messageId - The Telegram message ID of the file
   * @param mimeType - The MIME type of the file (for Blob type)
   * @returns Promise with Blob of the file
   */
  async downloadFile(messageId: number, mimeType: string = 'application/octet-stream'): Promise<Blob> {
    console.log('[Download] downloadFile called, messageId:', messageId, 'mimeType:', mimeType);
    
    if (!this.client) {
      console.error('[Download] Client not initialized');
      throw new Error("Client not initialized. Call initialize() first.");
    }

    console.log('[Download] Getting message from Saved Messages, messageId:', messageId);
    // Get the message from Saved Messages
    const messages = await this.client.getMessages("me", { ids: [messageId] });
    console.log('[Download] Got messages, count:', messages?.length, 'first:', messages?.[0]?.constructor?.name);
    
    const message = messages[0] as Api.Message;
    
    if (!message) {
      console.error('[Download] Message not found for id:', messageId);
      throw new Error("Message not found: " + messageId);
    }
    
    console.log('[Download] Message found, media:', !!message.media, 'type:', message.media?.constructor?.name);
    
    if (!message.media) {
      console.error('[Download] Message has no media');
      throw new Error("Message has no media for id: " + messageId);
    }

    let fileSize = 0;
    const media = message.media as any;
    if (media?.className === 'MessageMediaDocument' && media.document) {
      fileSize = Number(media.document.size || 0);
    }

    if (mimeType.startsWith('video/') && fileSize < 10 * 1024 * 1024) {
      console.log('[Download] Video file under 10MB, using downloadMedia for reliable playback...');
      const buffer = await this.client.downloadMedia(message.media);
      if (!buffer || buffer.length === 0) {
        throw new Error("Failed to download file - empty buffer");
      }
      return new Blob([buffer], { type: mimeType });
    }

    // For photos, use downloadMedia directly (Telegram photos don't have direct size property)
    if (mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType.startsWith('image/')) {
      console.log('[Download] Image file, using downloadMedia...');
      const buffer = await this.client.downloadMedia(message.media);
      if (!buffer || buffer.length === 0) {
        throw new Error("Failed to download file - empty buffer");
      }
      return new Blob([buffer], { type: mimeType });
    }

    // Try chunked download first (better for large files)
    try {
      console.log('[Download] Trying chunked GetFile download...');
      const result = await this.downloadFileChunked(message, mimeType);
      return result;
    } catch (err: any) {
      console.error('[Download] Chunked download failed, trying downloadMedia:', err.message);
      // Fallback to downloadMedia for small files
      console.log('[Download] Starting downloadMedia fallback...');
      const buffer = await this.client.downloadMedia(message.media);
      if (!buffer || buffer.length === 0) {
        throw new Error("Failed to download file - empty buffer");
      }
      return new Blob([buffer], { type: mimeType });
    }
  }

  /**
   * Download file using streaming - returns blob immediately for playback while downloading continues.
   */
  async downloadFileChunked(message: Api.Message, mimeType: string = 'application/octet-stream'): Promise<Blob> {
    console.log('[Streaming] Starting streaming download...');
    
    // Extract file location from message media
    let fileSize: number = 0;
    let docId: bigint = BigInt(0);
    let accessHash: bigint = BigInt(0);
    let fileReference: Uint8Array | undefined;
    
    const media = message.media as any;
    
    if (media?.className === 'MessageMediaDocument') {
      const doc = media.document;
      if (!doc) throw new Error('No document in media');
      docId = doc.id;
      accessHash = doc.accessHash;
      fileReference = doc.fileReference;
      fileSize = Number(doc.size);
      console.log('[Streaming] Document size:', fileSize);
    } else if (media?.className === 'MessageMediaPhoto') {
      const photo = media.photo;
      if (!photo) throw new Error('No photo in media');
      docId = photo.id;
      accessHash = photo.accessHash;
      fileReference = photo.fileReference;
      fileSize = Number(photo.size);
      console.log('[Streaming] Photo size:', fileSize);
    } else {
      throw new Error('Unsupported media type: ' + media?.className);
    }

    const CHUNK_SIZE = 32 * 1024;
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    console.log('[Streaming] Total size:', fileSize, 'chunks:', totalChunks);

    // Store downloaded chunks
    const downloadedChunks: Uint8Array[] = [];
    let isDownloadComplete = false;

    // Start downloading in background immediately
    const downloadInBackground = async () => {
      let offset = 0;
      let chunkIndex = 0;
      
      while (offset < fileSize) {
        const limit = Math.min(CHUNK_SIZE, fileSize - offset);
        
        const chunkLocation = new Api.InputDocumentFileLocation({
          id: docId as any,
          accessHash: accessHash as any,
          fileReference: fileReference,
          thumbSize: "",
        });
        
        const client = this.client;
        try {
          const fileResult = await client!.invoke(
            new Api.upload.GetFile({
              location: chunkLocation!,
              offset: BigInt(offset) as any,
              limit: limit,
              precise: false,
              cdnSupported: true,
            })
          ) as any;
          
          if (fileResult?.bytes) {
            downloadedChunks.push(new Uint8Array(fileResult.bytes));
            console.log(`[Streaming] Chunk ${chunkIndex + 1}/${totalChunks} ready`);
          }
        } catch (err: any) {
          console.error('[Streaming] GetFile error:', err.message);
          throw err;
        }
        
        offset += limit;
        chunkIndex++;
      }
      
      isDownloadComplete = true;
      console.log('[Streaming] All chunks downloaded!');
    };

    // Start background download (don't await - run in parallel)
    downloadInBackground().catch(err => console.error('[Streaming] Background download failed:', err));

    // Wait for enough chunks (at least 10MB) for playback to start reliably - video needs keyframes
    const waitForEnoughChunks = (minSize: number = 10 * 1024 * 1024): Promise<Blob> => new Promise((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const currentSize = downloadedChunks.reduce((sum, c) => sum + c.length, 0);
        if (currentSize >= minSize) {
          clearInterval(checkInterval);
          const blobs = downloadedChunks.map(c => new Uint8Array(c).buffer);
          const blob = new Blob(blobs as ArrayBuffer[], { type: mimeType });
          console.log('[Streaming] Enough chunks ready, size:', blob.size);
          resolve(blob);
        }
        if (isDownloadComplete && downloadedChunks.length > 0) {
          clearInterval(checkInterval);
          const blobs = downloadedChunks.map(c => new Uint8Array(c).buffer);
          const blob = new Blob(blobs as ArrayBuffer[], { type: mimeType });
          console.log('[Streaming] Download complete, final size:', blob.size);
          resolve(blob);
        }
        if (Date.now() - startTime > 60000) {
          clearInterval(checkInterval);
          const blobs = downloadedChunks.map(c => new Uint8Array(c).buffer);
          const blob = new Blob(blobs as ArrayBuffer[], { type: mimeType });
          console.log('[Streaming] Timeout, returning blob with size:', blob.size);
          resolve(blob);
        }
      }, 100);
    });

    return await waitForEnoughChunks();
  }

  async downloadFileChunkedByOffset(messageId: number, offset: number, limit: number, fileSize?: number): Promise<Blob> {
    if (!this.client) {
      throw new Error("Client not initialized");
    }

    if (fileSize !== undefined && offset >= fileSize) {
      throw new Error('Invalid chunk request: offset=' + offset + ' >= fileSize=' + fileSize);
    }

    // MTProto upload.GetFile (precise=true) constraints:
    //   1. offset must be 4KB-aligned
    //   2. limit must be a multiple of 4KB, ≤ 512KB
    //   3. offset + limit must NOT cross a 1MB boundary
    // Note: precise=true does NOT require offset % limit == 0
    const ALIGN = 4096;
    const MB = 1024 * 1024;

    const alignedOffset = Math.floor(offset / ALIGN) * ALIGN;
    const prefix = offset - alignedOffset;

    // Max bytes fetchable before hitting the next 1MB boundary (constraint 3)
    const nextMb = (Math.floor(alignedOffset / MB) + 1) * MB;
    const maxFromBoundary = nextMb - alignedOffset;

    // Pick the largest candidate that fits within the 1MB boundary
    const candidates = [524288, 262144, 131072, 65536, 32768, 16384, 8192, 4096];
    let downloadLimit = ALIGN;
    for (const c of candidates) {
      if (c <= maxFromBoundary) {
        downloadLimit = c;
        break;
      }
    }

    const messages = await this.client.getMessages("me", { ids: [messageId] });
    const message = messages[0] as Api.Message;
    if (!message?.media) throw new Error("Message has no media");

    const media = message.media as any;
    let docId: bigint, accessHash: bigint, fileReference: Uint8Array | undefined;
    if (media?.className === 'MessageMediaDocument') {
      const doc = media.document;
      docId = doc.id;
      accessHash = doc.accessHash;
      fileReference = doc.fileReference;
    } else {
      throw new Error('Unsupported media type: ' + media?.className);
    }

    const chunkLocation = new Api.InputDocumentFileLocation({
      id: docId as any,
      accessHash: accessHash as any,
      fileReference: fileReference,
      thumbSize: "",
    });

    let fileResult: any;
    try {
      fileResult = await this.client.invoke(
        new Api.upload.GetFile({
          location: chunkLocation,
          offset: BigInt(alignedOffset) as any,
          limit: downloadLimit,
          precise: true,
          cdnSupported: true,
        })
      );
    } catch (err: any) {
      console.error('[ChunkByOffset] GetFile failed — alignedOffset:', alignedOffset, 'limit:', downloadLimit, err?.message);
      throw err;
    }

    if (!fileResult.bytes) throw new Error('No data returned');

    let bytes = new Uint8Array(fileResult.bytes);

    // If Telegram returned fewer bytes than downloadLimit AND file has more data,
    // retry with 512KB alignment to fetch the full upload-part chunk
    if (bytes.length < downloadLimit && fileSize !== undefined && alignedOffset + bytes.length < fileSize) {
      const PART_SIZE = 524288;
      const aligned512 = Math.floor(offset / PART_SIZE) * PART_SIZE;
      const retryLimit = Math.min(PART_SIZE, fileSize - aligned512);
      let retryResult: any;
      try {
        retryResult = await this.client.invoke(
          new Api.upload.GetFile({
            location: chunkLocation,
            offset: BigInt(aligned512) as any,
            limit: retryLimit,
            precise: true,
            cdnSupported: true,
          })
        );
      } catch (err: any) {
        console.error('[ChunkByOffset] Retry GetFile failed:', err?.message);
        throw err;
      }
      if (retryResult?.bytes && retryResult.bytes.length > bytes.length) {
        bytes = new Uint8Array(retryResult.bytes);
        // Adjust prefix to start from original aligned offset
        const adjustedPrefix = alignedOffset - aligned512;
        const sliced2 = bytes.slice(adjustedPrefix + prefix, adjustedPrefix + prefix + limit);
        return new Blob([sliced2], { type: 'video/mp4' });
      }
    }

    // Discard prefix bytes so caller gets exactly offset..offset+limit
    const sliced = bytes.slice(prefix, prefix + limit);
    return new Blob([sliced], { type: 'video/mp4' });
  }

  /**
   * Download and merge split file parts from Telegram.
   * @param splitGroupId - The split group ID to identify all parts
   * @param mimeType - The MIME type of the merged file (for Blob type)
   * @returns Promise with merged Blob of the complete file
   */
  async downloadFileMerge(splitGroupId: string, mimeType: string = 'application/octet-stream'): Promise<Blob> {
    console.log('[DownloadMerge] Starting for split_group_id:', splitGroupId);
    // Query backend for all parts in this split group
    const filePartsResponse = await api.getSplitGroupFiles(splitGroupId);
    const fileParts = filePartsResponse.files;
    console.log('[DownloadMerge] Found parts:', fileParts.length);

    if (!fileParts || fileParts.length === 0) {
      throw new Error("No files found for split group: " + splitGroupId);
    }

    // Sort by part_index and download sequentially
    const sortedParts = fileParts.sort((a, b) => {
      const aIndex = (a as unknown as { part_index?: number }).part_index ?? 0;
      const bIndex = (b as unknown as { part_index?: number }).part_index ?? 0;
      return aIndex - bIndex;
    });

    console.log('[DownloadMerge] Sorted parts:', sortedParts.map(p => ({ idx: (p as any).part_index, msgId: p.telegram_message_id })));

    // Download each part sequentially
    const parts: Blob[] = [];
    for (let i = 0; i < sortedParts.length; i++) {
      const part = sortedParts[i];
      const messageId = part.telegram_message_id;
      console.log('[DownloadMerge] Downloading part', i, 'messageId:', messageId);
      
      if (!messageId) {
        throw new Error(`Missing telegram_message_id for part: ${part.file_id}`);
      }
      
      const blob = await this.downloadFile(messageId, mimeType);
      console.log('[DownloadMerge] Part', i, 'downloaded, size:', blob.size);
      parts.push(blob);
    }

    console.log('[DownloadMerge] All parts downloaded, merging...');
    // Merge all parts using Blob
    const merged = new Blob(parts, { type: mimeType });
    console.log('[DownloadMerge] Merged size:', merged.size);
    return merged;
  }

  /**
   * Start QR code login. Calls onQRCode with a fresh tg://login URL whenever
   * Telegram issues a new token (every ~30 s). Resolves with session string
   * when the user scans and the handshake completes.
   */
  async startQRLogin(
    apiId: number,
    apiHash: string,
    onQRCode: (url: string, expiresAt: number) => void,
    onPasswordRequired: (hint: string) => Promise<string>,
  ): Promise<string> {
    if (window.location.protocol === 'https:') {
      installTelegramWsProxy();
    }
    this.session = new StringSession('');
    this.client = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: window.location.protocol === 'https:',
      deviceModel: 'TeleDrive Browser',
      appVersion: '1.0.0',
    });

    // Connect first, then use signInUserWithQrCode directly.
    // GramJS 2.26.x start() _authFlow only routes to signInUser or signInBot —
    // qrCode callback in start() params is not dispatched.
    await this.client.connect();

    await (this.client as any).signInUserWithQrCode(
      { apiId, apiHash },
      {
        qrCode: async (qr: { token: Buffer; expires: number }) => {
          const tokenBase64 = btoa(String.fromCharCode(...new Uint8Array(qr.token)));
          onQRCode(`tg://login?token=${tokenBase64}`, qr.expires);
        },
        password: onPasswordRequired,
        onError: (err: Error) => { console.error('[QRLogin]', err); },
      },
    );

    return this.session.save();
  }

  /**
   * Start phone number login. Returns `waitForLogin` (resolves with session
   * string on success) plus `submitCode` / `submitPassword` callbacks that the
   * UI calls to push values into `client.start()`'s promise bridges.
   */
  startPhoneLogin(
    apiId: number,
    apiHash: string,
    phone: string,
    onCodeRequired: () => void,
    onPasswordRequired: (hint: string) => void,
  ): { waitForLogin: Promise<string>; submitCode: (code: string) => void; submitPassword: (pwd: string) => void } {
    if (window.location.protocol === 'https:') {
      installTelegramWsProxy();
    }
    this.session = new StringSession('');
    this.client = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: window.location.protocol === 'https:',
      deviceModel: 'TeleDrive Browser',
      appVersion: '1.0.0',
    });

    let resolveCode: ((code: string) => void) | null = null;
    let resolvePassword: ((pwd: string) => void) | null = null;

    const waitForLogin = (this.client as any).start({
      phoneNumber: phone,
      phoneCode: async () => {
        onCodeRequired();
        return new Promise<string>((resolve) => { resolveCode = resolve; });
      },
      password: async (hint?: string) => {
        onPasswordRequired(hint ?? '');
        return new Promise<string>((resolve) => { resolvePassword = resolve; });
      },
      onError: (err: Error) => { console.error('[PhoneLogin]', err); },
    }).then(() => this.session!.save());

    return {
      waitForLogin,
      submitCode: (code: string) => { resolveCode?.(code); },
      submitPassword: (pwd: string) => { resolvePassword?.(pwd); },
    };
  }

  /**
   * Disconnect and cleanup the Telegram client.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
      this.session = null;
    }
  }

  /**
   * Check if client is currently connected.
   */
  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  /**
   * Connect/reconnect the Telegram client.
   * Used for reconnection after connection drops.
   */
  async connect(): Promise<void> {
    if (this.client && !this.client.connected) {
      console.log('[GramJS] Reconnecting to Telegram...');
      await this.client.connect();
      console.log('[GramJS] Reconnected successfully');
    }
  }

  /**
   * Ping Telegram to test if connection is alive.
   * This is more reliable than just checking isConnected().
   */
  async invokePing(): Promise<boolean> {
    if (!this.client || !this.client.connected) {
      return false;
    }
    try {
      // Try to get current user as a ping test
      await this.client.getMe();
      return true;
    } catch (err) {
      console.log('[GramJS] Ping failed:', err);
      return false;
    }
  }

  /**
   * Get the current session string for storage.
   * This can be saved and used to restore the session later.
   */
  getSessionString(): string {
    if (!this.session) {
      throw new Error("Session not initialized");
    }
    return this.session.save();
  }
}

// Singleton instance for app-wide use
let clientInstance: TelegramClientManager | null = null;

/**
 * Get or create the singleton Telegram client instance.
 */
export function getTelegramClient(): TelegramClientManager {
  if (!clientInstance) {
    clientInstance = new TelegramClientManager();
  }
  return clientInstance;
}

/**
 * Reset the singleton client instance (useful for logout).
 */
export function resetTelegramClient(): void {
  if (clientInstance) {
    clientInstance.disconnect();
    clientInstance = null;
  }
}

export function saveCredentialsToStorage(sessionString: string, jwt: string): void {
  localStorage.setItem('tg_session', sessionString);
  localStorage.setItem('tg_jwt', jwt);
}

export function loadCredentialsFromStorage(): { sessionString: string | null; jwt: string | null } {
  return {
    sessionString: localStorage.getItem('tg_session'),
    jwt: localStorage.getItem('tg_jwt'),
  };
}

export function clearCredentialsFromStorage(): void {
  localStorage.removeItem('tg_session');
  localStorage.removeItem('tg_jwt');
}
