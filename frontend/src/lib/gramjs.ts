import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import { Api } from "telegram/tl";
import bigInt from "big-integer";
import { api } from "../api/client";

// Constants for split upload
const MAX_PARTS = 3900;
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

    // Process file in chunks
    for (let offset = 0; offset < file.size; offset += PART_SIZE) {
      const chunk = file.slice(offset, offset + PART_SIZE);
      const arrayBuffer = await chunk.arrayBuffer();
      // Use globalThis.Buffer (provided by vite-plugin-node-polyfills)
      const bytes = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));

      // Save this part using SaveBigFilePart API
      await this.client.invoke(
        new Api.upload.SaveBigFilePart({
          fileId: fileId,
          filePart: partIndex,
          fileTotalParts: partsForCurrentFile,
          bytes: bytes,
        })
      );

      partIndex++;
      remainingForCurrentFile -= PART_SIZE;

      // If we've reached max parts, finalize this file and start a new one
      if (partIndex >= MAX_PARTS) {
        const inputFileBig = new Api.InputFileBig({
          id: fileId,
          parts: partIndex,
          name: file.name,
        });

        const message = await this.client.sendFile("me", { file: inputFileBig });
        
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

        uploadedParts.push({
          message_id: msg.id,
          file_id: String(fileId),
          access_hash: accessHash,
          size: partIndex * PART_SIZE,
        });

        // Start new file with updated remaining parts
        fileId = generateRandomBigInt();
        partIndex = 0;
        partsForCurrentFile = Math.min(MAX_PARTS, Math.ceil(remainingForCurrentFile / PART_SIZE));
      }
    }

    // Upload final file if there are remaining parts
    if (partIndex > 0) {
      const inputFileBig = new Api.InputFileBig({
        id: fileId,
        parts: partIndex, // This is the actual number of parts for this final file
        name: file.name,
      });

      const message = await this.client.sendFile("me", { file: inputFileBig });
      
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

      uploadedParts.push({
        message_id: msg.id,
        file_id: String(fileId),
        access_hash: accessHash,
        size: file.size,
      });
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
   * Download a file from Telegram by message_id.
   * @param messageId - The Telegram message ID of the file
   * @param mimeType - The MIME type of the file (for Blob type)
   * @returns Promise with Blob of the file
   */
  async downloadFile(messageId: number, mimeType: string = 'application/octet-stream'): Promise<Blob> {
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
      throw new Error("Failed to download file");
    }

    // Convert Uint8Array to Blob
    return new Blob([buffer], { type: mimeType });
  }

  /**
   * Download and merge split file parts from Telegram.
   * @param splitGroupId - The split group ID to identify all parts
   * @param mimeType - The MIME type of the merged file (for Blob type)
   * @returns Promise with merged Blob of the complete file
   */
  async downloadFileMerge(splitGroupId: string, mimeType: string = 'application/octet-stream'): Promise<Blob> {
    // Query backend for all parts in this split group
    const filePartsResponse = await api.getSplitGroupFiles(splitGroupId);
    const fileParts = filePartsResponse.files;

    if (!fileParts || fileParts.length === 0) {
      throw new Error("No files found for split group: " + splitGroupId);
    }

    // Sort by part_index and download sequentially
    const sortedParts = fileParts.sort((a, b) => {
      const aIndex = (a as unknown as { part_index?: number }).part_index ?? 0;
      const bIndex = (b as unknown as { part_index?: number }).part_index ?? 0;
      return aIndex - bIndex;
    });

    // Download each part sequentially
    const parts: Blob[] = [];
    for (const part of sortedParts) {
      const messageId = part.telegram_message_id;
      if (!messageId) {
        throw new Error(`Missing telegram_message_id for part: ${part.file_id}`);
      }
      
      const blob = await this.downloadFile(messageId, mimeType);
      parts.push(blob);
    }

    // Merge all parts using Blob
    const merged = new Blob(parts, { type: mimeType });
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
