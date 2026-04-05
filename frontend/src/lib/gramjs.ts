import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import { Api } from "telegram/tl";
import bigInt from "big-integer";
import { api } from "../api/client";

// Constants for split upload
const MAX_PARTS = 1000;
const PART_SIZE = 512 * 1024; // 512KB

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

  /**
   * Initialize the Telegram client with API credentials and session.
   * @param apiId - Telegram API ID from my.telegram.org
   * @param apiHash - Telegram API Hash from my.telegram.org
   * @param sessionString - Saved session string for authentication
   */
  async initialize(apiId: number, apiHash: string, sessionString: string): Promise<void> {
    // Create session - use empty string for new session or existing string for restore
    this.session = new StringSession(sessionString || "");

    // Initialize client with session and API credentials
    this.client = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: false, // Use regular TCP connections in browser
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

    // For browser File objects, convert to array buffer then to Uint8Array
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

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

    // Convert Blob to array buffer then to Uint8Array
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

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
  async uploadFileSplit(file: File): Promise<{
    parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number }>;
    originalName: string;
    totalParts: number;
  }> {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    const uploadedParts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number }> = [];
    let fileId = generateRandomBigInt();
    let partIndex = 0;
    
    // Calculate total parts for current file segment
    let remainingForCurrentFile = file.size;
    let partsForCurrentFile = Math.min(MAX_PARTS, Math.ceil(remainingForCurrentFile / PART_SIZE));
    
    console.log('[SplitUpload] File:', file.name, 'Size:', file.size, 'bytes');
    console.log('[SplitUpload] Total parts needed:', Math.ceil(file.size / PART_SIZE));
    console.log('[SplitUpload] First file segment - parts:', partsForCurrentFile);

    // Process file in chunks
    for (let offset = 0; offset < file.size; offset += PART_SIZE) {
      const chunk = file.slice(offset, offset + PART_SIZE);
      const arrayBuffer = await chunk.arrayBuffer();
      // Use globalThis.Buffer (provided by vite-plugin-node-polyfills)
      const bytes = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));

      console.log('[SplitUpload] Uploading part', partIndex, '/', partsForCurrentFile, '- offset:', offset);

      // Save this part using SaveBigFilePart API
      try {
        await this.client.invoke(
          new Api.upload.SaveBigFilePart({
            fileId: fileId,
            filePart: partIndex,
            fileTotalParts: partsForCurrentFile,
            bytes: bytes,
          })
        );
        console.log('[SplitUpload] Part', partIndex, 'uploaded successfully');
      } catch (err: any) {
        console.error('[SplitUpload] Part', partIndex, 'FAILED:', err?.message || err);
        throw err;
      }

      partIndex++;
      remainingForCurrentFile -= PART_SIZE;

      // If we've reached max parts, finalize this file and start a new one
      if (partIndex >= MAX_PARTS) {
        console.log('[SplitUpload] Reached MAX_PARTS, sending file with', partIndex, 'parts...');
        
        const inputFileBig = new Api.InputFileBig({
          id: fileId,
          parts: partIndex,
          name: file.name,
        });

        try {
          const message = await this.client.sendFile("me", { file: inputFileBig });
          console.log('[SplitUpload] File sent successfully, message_id:', message?.id);
          
          // Extract media info
          const msg = message as Api.Message;
          const media = msg.media;

          let accessHash: string | undefined;
          if (media) {
            const mediaConstructor = (media as { className?: string }).className;
            if (mediaConstructor === "MessageMediaDocument") {
              const doc = media as unknown as { document: { id: bigint; accessHash?: bigint } };
              accessHash = doc.document.accessHash ? String(doc.document.accessHash) : undefined;
            }
          }

          const segmentSize = partIndex * PART_SIZE;
          uploadedParts.push({
            message_id: msg.id,
            file_id: String(fileId),
            access_hash: accessHash,
            size: Math.min(segmentSize, file.size), // Actual size of this segment
          });
          console.log('[SplitUpload] Segment registered, parts:', partIndex, 'size:', Math.min(segmentSize, file.size), 'bytes');
        } catch (err: any) {
          console.error('[SplitUpload] SendFile FAILED:', err?.message || err);
          throw err;
        }

        // Start new file with updated remaining parts
        fileId = generateRandomBigInt();
        partIndex = 0;
        partsForCurrentFile = Math.min(MAX_PARTS, Math.ceil(remainingForCurrentFile / PART_SIZE));
        console.log('[SplitUpload] Starting new file segment, parts:', partsForCurrentFile, 'remaining:', remainingForCurrentFile);
      }
    }

    // Upload final file if there are remaining parts
    if (partIndex > 0) {
      console.log('[SplitUpload] Sending final file with', partIndex, 'parts...');
      const inputFileBig = new Api.InputFileBig({
        id: fileId,
        parts: partIndex, // This is the actual number of parts for this final file
        name: file.name,
      });

      try {
        const message = await this.client.sendFile("me", { file: inputFileBig });
        console.log('[SplitUpload] Final file sent, message_id:', message?.id);
        
        const msg = message as Api.Message;
        const media = msg.media;

        let accessHash: string | undefined;
        if (media) {
          const mediaConstructor = (media as { className?: string }).className;
          if (mediaConstructor === "MessageMediaDocument") {
            const doc = media as unknown as { document: { id: bigint; accessHash?: bigint } };
            accessHash = doc.document.accessHash ? String(doc.document.accessHash) : undefined;
          }
        }

        const finalSegmentSize = partIndex * PART_SIZE;
        uploadedParts.push({
          message_id: msg.id,
          file_id: String(fileId),
          access_hash: accessHash,
          size: finalSegmentSize, // Actual size of final segment
        });
        console.log('[SplitUpload] Final segment registered, parts:', partIndex, 'size:', finalSegmentSize, 'bytes');
      } catch (err: any) {
        console.error('[SplitUpload] Final SendFile FAILED:', err?.message || err);
        throw err;
      }
    }

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
          id: docId,
          accessHash: accessHash,
          fileReference: fileReference,
          thumbSize: "",
        });
        
        try {
          const fileResult = await this.client.invoke(
            new Api.upload.GetFile({
              location: chunkLocation,
              offset: BigInt(offset),
              limit: limit,
              precise: true,
              cdnSupported: true,
            })
          );
          
          if (fileResult.bytes) {
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
    const waitForEnoughChunks = (minSize: number = 10 * 1024 * 1024): Promise<Blob> => new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const currentSize = downloadedChunks.reduce((sum, c) => sum + c.length, 0);
        if (currentSize >= minSize) {
          clearInterval(checkInterval);
          // Correct way to create blob from chunks
          const blob = new Blob(downloadedChunks, { type: mimeType });
          console.log('[Streaming] Enough chunks ready, size:', blob.size);
          resolve(blob);
        }
        if (isDownloadComplete && downloadedChunks.length > 0) {
          clearInterval(checkInterval);
          const blob = new Blob(downloadedChunks, { type: mimeType });
          console.log('[Streaming] Download complete, final size:', blob.size);
          resolve(blob);
        }
        // Timeout after 60 seconds
        if (Date.now() - startTime > 60000) {
          clearInterval(checkInterval);
          // Return whatever we have even if not enough
          const blob = new Blob(downloadedChunks, { type: mimeType });
          console.log('[Streaming] Timeout, returning blob with size:', blob.size);
          resolve(blob);
        }
      }, 100);
    });

    return await waitForEnoughChunks();
  }

  /**
   * Download a specific chunk of a file by offset - for streaming playback.
   */
  async downloadFileChunkedByOffset(messageId: number, offset: number, limit: number): Promise<Blob> {
    console.log('[ChunkByOffset] ===== START =====');
    console.log('[ChunkByOffset] Downloading chunk, messageId:', messageId, 'offset:', offset, 'limit:', limit);
    console.log('[ChunkByOffset] limit in KB:', (limit / 1024).toFixed(1), 'KB');
    console.log('[ChunkByOffset] limit is valid:', limit % 4096 === 0 ? 'YES (divisible by 4KB)' : 'NO!');
    console.log('[ChunkByOffset] 1MB % limit:', 1048576 % limit, '(should be 0 for non-precise)');
    
    if (!this.client) {
      throw new Error("Client not initialized");
    }

    // Get message
    console.log('[ChunkByOffset] Getting message from Telegram...');
    const messages = await this.client.getMessages("me", { ids: [messageId] });
    console.log('[ChunkByOffset] Got messages, count:', messages.length);
    
    const message = messages[0] as Api.Message;
    
    if (!message?.media) {
      throw new Error("Message has no media");
    }

    const media = message.media as any;
    let docId: bigint, accessHash: bigint, fileReference: Uint8Array | undefined;
    
    if (media?.className === 'MessageMediaDocument') {
      const doc = media.document;
      docId = doc.id;
      accessHash = doc.accessHash;
      fileReference = doc.fileReference;
      console.log('[ChunkByOffset] Document: id=', docId, 'size=', doc.size, 'mime=', doc.mimeType);
    } else {
      throw new Error('Unsupported media type: ' + media?.className);
    }

    console.log('[ChunkByOffset] Creating InputDocumentFileLocation...');
    const chunkLocation = new Api.InputDocumentFileLocation({
      id: docId,
      accessHash: accessHash,
      fileReference: fileReference,
      thumbSize: "",
    });

    console.log('[ChunkByOffset] Calling upload.getFile API...');
    console.log('[ChunkByOffset] API params: offset=', offset, 'limit=', limit, 'precise=true');
    
    let fileResult: any;
    try {
      fileResult = await this.client.invoke(
        new Api.upload.GetFile({
          location: chunkLocation,
          offset: BigInt(offset),
          limit: limit,
          precise: true,
          cdnSupported: true,
        })
      );
      console.log('[ChunkByOffset] API call SUCCESS, bytes length:', fileResult.bytes?.length);
    } catch (err: any) {
      console.error('[ChunkByOffset] API call FAILED!');
      console.error('[ChunkByOffset] Error:', err);
      console.error('[ChunkByOffset] Error code:', err.errorCode);
      console.error('[ChunkByOffset] Error message:', err.message);
      console.error('[ChunkByOffset] Error type:', err.type);
      throw err;
    }

    if (!fileResult.bytes) {
      throw new Error('No data returned');
    }

    console.log('[ChunkByOffset] ===== END =====');
    return new Blob([new Uint8Array(fileResult.bytes)], { type: 'video/mp4' });
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
