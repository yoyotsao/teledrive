import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import { Api } from "telegram/tl";
import bigInt from "big-integer";
import { api } from "../api/client";
import { MAX_CONCURRENT_CHUNKS, CHUNK_RETRY_COUNT, MESSAGE_SENDS_PER_SECOND, MESSAGE_SEND_BURST } from "../config";
import { Semaphore } from "./semaphore";
import { RateLimiter } from "./rateLimiter";

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
const uploadSemaphore = new Semaphore(MAX_CONCURRENT_CHUNKS);

// Throttles Telegram message-creating RPCs (sendFile / SendMultiMedia) to avoid
// FLOOD_WAIT. Does NOT gate chunk uploads (SaveBigFilePart) — those stay bounded
// by uploadSemaphore only, so large-file throughput is unaffected.
const messageRateLimiter = new RateLimiter(MESSAGE_SENDS_PER_SECOND, MESSAGE_SEND_BURST);

// Adaptive FLOOD backoff: if a message send fails with FLOOD_WAIT (or looks
// like GramJS silently slept on one), penalize the shared limiter so all
// pending sends slow down instead of piling more requests onto the flood.
const FLOOD_SLEEP_SUSPECT_MS = 5000;
const FLOOD_PENALTY_MS = 10_000;

function isFloodError(err: unknown): boolean {
  const e = err as { errorMessage?: string; message?: string } | null;
  return `${e?.errorMessage ?? ''} ${e?.message ?? ''}`.includes('FLOOD');
}

function penalizeForFlood(label: string, err: unknown): void {
  const seconds = (err as { seconds?: number } | null)?.seconds;
  const waitMs = (typeof seconds === 'number' && seconds > 0 ? seconds : FLOOD_PENALTY_MS / 1000) * 1000;
  console.warn(`[GramJS] ${label} hit FLOOD_WAIT — pausing message sends for ${waitMs}ms`);
  messageRateLimiter.penalize(waitMs);
}

/**
 * floodSleepThreshold makes GramJS sleep through FLOOD_WAIT < 300s instead of
 * throwing, so a slow message-send invoke is the only visible symptom. Only
 * meaningful for pure message sends (SendMultiMedia) where the file bytes were
 * already uploaded — sendFile calls include byte transfer and would false-positive.
 */
function reportSuspectedFloodSleep(label: string, startedAt: number): void {
  const elapsed = Date.now() - startedAt;
  if (elapsed > FLOOD_SLEEP_SUSPECT_MS) {
    console.warn(`[GramJS] ${label} took ${elapsed}ms — suspected FLOOD sleep, penalizing sends for ${FLOOD_PENALTY_MS}ms`);
    messageRateLimiter.penalize(FLOOD_PENALTY_MS);
  }
}

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
  private readonly sendFileSemaphore = new Semaphore(3);
  // Tracks the in-flight/most recent initialize() call so operations issued while
  // the UI has already mounted (App no longer blocks on the MTProto handshake) can wait for it.
  private initPromise: Promise<void> | null = null;
  // Caches the resolved document location per message so SW chunk streaming doesn't
  // pay a getMessages round trip on every single chunk request.
  private fileLocationCache = new Map<number, { docId: bigint; accessHash: bigint; fileReference?: Uint8Array }>();

  /**
   * Resolve (and cache) the document location for a message. Pass forceRefresh=true
   * after a FILE_REFERENCE_EXPIRED error to re-fetch a fresh file reference.
   */
  private async getFileLocation(
    messageId: number,
    forceRefresh = false
  ): Promise<{ docId: bigint; accessHash: bigint; fileReference?: Uint8Array }> {
    if (!forceRefresh) {
      const cached = this.fileLocationCache.get(messageId);
      if (cached) return cached;
    }
    const messages = await this.client!.getMessages("me", { ids: [messageId] });
    const message = messages[0] as Api.Message;
    if (!message?.media) throw new Error("Message has no media");
    const media = message.media as any;
    if (media.className !== 'MessageMediaDocument') {
      throw new Error('Unsupported media type: ' + media?.className);
    }
    const doc = media.document;
    const location = { docId: doc.id as bigint, accessHash: doc.accessHash as bigint, fileReference: doc.fileReference as Uint8Array | undefined };
    this.fileLocationCache.set(messageId, location);
    return location;
  }

  /**
   * Initialize the Telegram client with API credentials and session.
   * @param apiId - Telegram API ID from my.telegram.org
   * @param apiHash - Telegram API Hash from my.telegram.org
   * @param sessionString - Saved session string for authentication
   */
  async initialize(apiId: number, apiHash: string, sessionString: string): Promise<void> {
    const promise = this.doInitialize(apiId, apiHash, sessionString);
    this.initPromise = promise;
    return promise;
  }

  /** Resolves once the most recent initialize() call has connected; rejects if it failed. */
  async waitUntilReady(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  private async doInitialize(apiId: number, apiHash: string, sessionString: string): Promise<void> {
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
      floodSleepThreshold: 300,
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
          await messageRateLimiter.wait();
          return await this.client!.sendFile("me", params);
        } catch (err: any) {
          const isEntityZero = err?.message?.includes('ID 0') || err?.message?.includes('Entity');
          if (isEntityZero && attempt < maxRetries - 1) {
            console.warn(`[GramJS] sendFile entity-0 error (attempt ${attempt + 1}), refreshing entity cache...`);
            try { await this.client!.getMe(); } catch { /* ignore */ }
            continue;
          }
          if (isFloodError(err) && attempt < maxRetries - 1) {
            penalizeForFlood('sendFile', err);
            continue;
          }
          throw err;
        }
      }
    });
  }

  /**
   * Upload thumbnail bytes and return an InputFile for embedding as a document
   * thumb. This is SaveFilePart traffic — NOT a message send — so it does not
   * go through messageRateLimiter. Returns undefined on any failure (non-fatal:
   * the file uploads without a thumbnail).
   */
  private async uploadThumbInputFile(thumb: Blob | null | undefined): Promise<Api.TypeInputFile | undefined> {
    if (!thumb || !this.client) return undefined;
    try {
      const arrayBuffer = await thumb.arrayBuffer();
      const buf = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));
      const customFile = new CustomFile('thumb.jpg', thumb.size, '', buf);
      return await (this.client as any).uploadFile({ file: customFile, workers: 1 });
    } catch (err) {
      console.warn('[Thumb] thumb bytes upload failed (non-fatal):', err);
      return undefined;
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
    await this.waitUntilReady();
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
    await this.waitUntilReady();
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    // Convert Blob to array buffer then to Buffer (polyfilled)
    const arrayBuffer = await file.arrayBuffer();
    const buffer = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));

    // Create CustomFile for thumbnail
    const customFile = new CustomFile(filename, file.size, "", buffer);

    // Send thumbnail to Saved Messages — this creates a message, so it must
    // share the rate limiter or thumbnails become the FLOOD_WAIT trigger.
    await messageRateLimiter.wait();
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
  async uploadFileSplit(file: File, onProgress?: (pct: number) => void, thumb?: Blob | null): Promise<{
    parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number }>;
    originalName: string;
    totalParts: number;
    hasThumbnail: boolean;
  }> {
    await this.waitUntilReady();
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

      const thumbInput = await this.uploadThumbInputFile(thumb);
      const message = await this.sendFileLocked({
        file: customFile,
        workers: 4,
        forceDocument: true,
        ...(thumbInput ? { thumb: thumbInput } : {}),
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
        hasThumbnail: !!thumbInput,
      };
    }

    const uploadedParts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number }> = [];
    let fileId = generateRandomBigInt();
    let segmentStartOffset = 0;
    let remainingSize = file.size;
    const totalChunks = Math.ceil(file.size / PART_SIZE);
    let completedChunks = 0;
    let thumbAttached = false;

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
                // Exponential backoff (1s/2s/4s...) — GramJS's own floodSleepThreshold
                // already handles FLOOD_WAIT errors, this covers other transient failures.
                await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, retry)));
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
        const thumbInput = segmentStartOffset === 0 ? await this.uploadThumbInputFile(thumb) : undefined;
        if (thumbInput) thumbAttached = true;
        const message = await this.sendFileLocked({
          file: inputFileBig,
          forceDocument: true,
          ...(thumbInput ? { thumb: thumbInput } : {}),
        });
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
      hasThumbnail: thumbAttached,
    };
  }

  async uploadAlbum(
    files: File[],
    onProgress?: (fileIdx: number, pct: number) => void,
    thumbs?: Array<Blob | null>,
  ): Promise<Array<{ message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean }>> {
    await this.waitUntilReady();
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    const inputFiles = await Promise.all(
      files.map(async (file, idx) => {
        const arrayBuffer = await file.arrayBuffer();
        const buf = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));
        const customFile = new CustomFile(file.name, file.size, "", buf);
        const inputFile = await (this.client as any).uploadFile({
          file: customFile,
          workers: 1,
          onProgress: (pct: number) => onProgress?.(idx, Math.round(pct * 100)),
        });
        const thumbInput = await this.uploadThumbInputFile(thumbs?.[idx]);
        return { inputFile, thumbInput, file };
      })
    );

    const multiMedia = inputFiles.map(({ inputFile, thumbInput, file }) =>
      new Api.InputSingleMedia({
        media: new Api.InputMediaUploadedDocument({
          file: inputFile,
          mimeType: file.type || 'application/octet-stream',
          attributes: [new Api.DocumentAttributeFilename({ fileName: file.name })],
          ...(thumbInput ? { thumb: thumbInput } : {}),
        }),
        message: '',
        randomId: generateRandomBigInt(),
      })
    );

    const peer = await this.client.getInputEntity('me');
    let updates: any;
    console.log('[Album] SendMultiMedia batch size:', files.length);
    for (let attempt = 0; ; attempt++) {
      await messageRateLimiter.wait();
      const startedAt = Date.now();
      try {
        updates = await this.client.invoke(
          new Api.messages.SendMultiMedia({ peer, multiMedia })
        ) as any;
        reportSuspectedFloodSleep('SendMultiMedia', startedAt);
        break;
      } catch (err) {
        if (isFloodError(err) && attempt < 1) {
          penalizeForFlood('SendMultiMedia', err);
          continue;
        }
        throw err;
      }
    }

    const messages: Api.Message[] = (updates.updates ?? [])
      .filter((u: any) => u.className === 'UpdateNewMessage' || u.className === 'UpdateNewChannelMessage')
      .map((u: any) => u.message as Api.Message)
      .filter((m: any) => m && m.media);

    return files.map((file, idx) => {
      const msg = messages[idx];
      if (!msg) return { message_id: 0, file_id: '', access_hash: undefined, size: file.size, has_thumbnail: false };
      const media = msg.media as any;
      let fileId = '';
      let accessHash: string | undefined;
      if (media?.className === 'MessageMediaDocument') {
        fileId = String(media.document.id);
        accessHash = media.document.accessHash ? String(media.document.accessHash) : undefined;
      } else if (media?.className === 'MessageMediaPhoto') {
        fileId = String(media.photo.id);
        accessHash = media.photo.accessHash ? String(media.photo.accessHash) : undefined;
      }
      return { message_id: msg.id, file_id: fileId, access_hash: accessHash, size: file.size, has_thumbnail: !!inputFiles[idx].thumbInput };
    });
  }

  /**
   * Download the embedded thumb PhotoSize of a file's own message by message_id.
   * Never downloads the document body (could be a 500MB video).
   * @param messageId - The Telegram message ID of the file (NOT a separate thumbnail message)
   * @returns Promise with Blob of the thumbnail image
   */
  async downloadThumbnail(messageId: number): Promise<Blob> {
    await this.waitUntilReady();
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    // Get the message from Saved Messages
    const messages = await this.client.getMessages("me", { ids: [messageId] });
    const message = messages[0] as Api.Message;

    if (!message || !message.media) {
      throw new Error("Message not found or has no media");
    }

    const media = message.media as any;
    const doc = media?.className === 'MessageMediaDocument' ? media.document : undefined;
    if (!doc?.thumbs?.length) {
      throw new Error("No embedded thumbnail");
    }

    // Download ONLY the embedded thumb PhotoSize — never the document itself
    const buffer = await this.client.downloadMedia(message.media, { thumb: doc.thumbs.length - 1 });

    if (!buffer) {
      throw new Error("Failed to download thumbnail");
    }

    // Convert Uint8Array to Blob
    return new Blob([buffer], { type: 'image/jpeg' });
  }

  /**
   * Download many embedded thumbnails at once — one getMessages round trip for
   * all message ids (each the file's OWN message, not a separate thumbnail
   * message), then bounded-parallel downloadMedia of just the thumb PhotoSize
   * per file. Used when opening a folder so N thumbnails don't cost N
   * sequential getMessages calls. Never downloads a document body.
   * @param messageIds - Telegram message IDs of the files themselves
   * @returns Map of messageId -> Blob (entries with no embedded thumb or a failed download are omitted)
   */
  async downloadThumbnails(messageIds: number[]): Promise<Map<number, Blob>> {
    await this.waitUntilReady();
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }

    const result = new Map<number, Blob>();
    if (messageIds.length === 0) return result;

    const messages = await this.client.getMessages("me", { ids: messageIds });
    const downloadSemaphore = new Semaphore(6);

    await Promise.all(
      messages.map((message) =>
        downloadSemaphore.withSlot(async () => {
          const msg = message as Api.Message | undefined;
          if (!msg || !msg.media) return;
          const media = msg.media as any;
          const doc = media?.className === 'MessageMediaDocument' ? media.document : undefined;
          if (!doc?.thumbs?.length) return; // no embedded thumb — nothing to show
          try {
            const buffer = await this.client!.downloadMedia(msg.media, { thumb: doc.thumbs.length - 1 });
            if (buffer) {
              result.set(msg.id, new Blob([buffer], { type: 'image/jpeg' }));
            }
          } catch (err) {
            console.warn('[Thumb] Batch download failed for message', msg.id, err);
          }
        })
      )
    );

    return result;
  }

  /**
   * Download file metadata (size and mime type) from Telegram by message_id.
   * @param messageId - The Telegram message ID of the file
   * @returns Promise with { size: number; mimeType: string }
   */
  async downloadFileMetadata(messageId: number): Promise<{ size: number; mimeType: string }> {
    console.log('[FileMetadata] Getting metadata for message:', messageId);
    
    await this.waitUntilReady();
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
    
    await this.waitUntilReady();
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

    const CHUNK_SIZE = 512 * 1024;
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    console.log('[Streaming] Total size:', fileSize, 'chunks:', totalChunks);

    // Chunks land in fixed slots (parallel downloads can finish out of order);
    // `readyPrefix` tracks how many LEADING slots are contiguously filled, since only a
    // contiguous prefix from byte 0 is a valid playable blob.
    const chunkSlots: (Uint8Array | undefined)[] = new Array(totalChunks);
    let readyPrefix = 0;
    let isDownloadComplete = false;
    let downloadError: Error | null = null;
    let onProgress: (() => void) | null = null;

    const location = new Api.InputDocumentFileLocation({
      id: docId as any,
      accessHash: accessHash as any,
      fileReference: fileReference,
      thumbSize: "",
    });

    const chunkSemaphore = new Semaphore(4);
    const client = this.client;

    const downloadChunk = async (chunkIndex: number) => {
      const offset = chunkIndex * CHUNK_SIZE;
      const limit = Math.min(CHUNK_SIZE, fileSize - offset);
      const fileResult = await client!.invoke(
        new Api.upload.GetFile({
          location,
          offset: BigInt(offset) as any,
          limit,
          precise: false,
          cdnSupported: true,
        })
      ) as any;

      if (fileResult?.bytes) {
        chunkSlots[chunkIndex] = new Uint8Array(fileResult.bytes);
        while (chunkSlots[readyPrefix] !== undefined) readyPrefix++;
        console.log(`[Streaming] Chunk ${chunkIndex + 1}/${totalChunks} ready (contiguous: ${readyPrefix}/${totalChunks})`);
      }
      onProgress?.();
    };

    // Start downloading in background immediately, 4 chunks in flight at a time
    const downloadInBackground = async () => {
      try {
        await Promise.all(
          Array.from({ length: totalChunks }, (_, i) => chunkSemaphore.withSlot(() => downloadChunk(i)))
        );
        isDownloadComplete = true;
        console.log('[Streaming] All chunks downloaded!');
      } catch (err: any) {
        console.error('[Streaming] GetFile error:', err.message);
        downloadError = err;
        isDownloadComplete = true;
      }
      onProgress?.();
    };
    downloadInBackground();

    const buildBlob = () => new Blob(chunkSlots.slice(0, readyPrefix) as BlobPart[], { type: mimeType });

    // Wait for enough contiguous bytes (10MB) for playback to start reliably (video needs keyframes),
    // or full completion, or a 60s safety timeout — whichever comes first. Event-driven, no polling.
    const MIN_READY_BYTES = 10 * 1024 * 1024;
    return new Promise<Blob>((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.log('[Streaming] Timeout, returning blob with size:', readyPrefix * CHUNK_SIZE);
        resolve(buildBlob());
      }, 60000);

      const check = () => {
        if (settled) return;
        if (downloadError && readyPrefix === 0) {
          settled = true;
          clearTimeout(timeoutId);
          reject(downloadError);
          return;
        }
        const readyBytes = Math.min(readyPrefix * CHUNK_SIZE, fileSize);
        if (readyBytes >= MIN_READY_BYTES || (isDownloadComplete && readyPrefix > 0)) {
          settled = true;
          clearTimeout(timeoutId);
          console.log('[Streaming] Ready, size:', readyBytes, 'complete:', isDownloadComplete);
          resolve(buildBlob());
        }
      };
      onProgress = check;
      check();
    });
  }

  async downloadFileChunkedByOffset(messageId: number, offset: number, limit: number, fileSize?: number): Promise<Blob> {
    await this.waitUntilReady();
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

    const toLocation = (loc: { docId: bigint; accessHash: bigint; fileReference?: Uint8Array }) =>
      new Api.InputDocumentFileLocation({
        id: loc.docId as any,
        accessHash: loc.accessHash as any,
        fileReference: loc.fileReference,
        thumbSize: "",
      });

    // Cached after the first chunk of a given message — subsequent chunks skip getMessages entirely.
    const invokeGetFile = async (off: number, lim: number): Promise<any> => {
      const loc = await this.getFileLocation(messageId);
      try {
        return await this.client!.invoke(
          new Api.upload.GetFile({ location: toLocation(loc), offset: BigInt(off) as any, limit: lim, precise: true, cdnSupported: true })
        );
      } catch (err: any) {
        if (/FILE_REFERENCE_EXPIRED/i.test(err?.message || '')) {
          console.warn('[ChunkByOffset] File reference expired, refreshing for message', messageId);
          const fresh = await this.getFileLocation(messageId, true);
          return await this.client!.invoke(
            new Api.upload.GetFile({ location: toLocation(fresh), offset: BigInt(off) as any, limit: lim, precise: true, cdnSupported: true })
          );
        }
        throw err;
      }
    };

    let fileResult: any;
    try {
      fileResult = await invokeGetFile(alignedOffset, downloadLimit);
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
        retryResult = await invokeGetFile(aligned512, retryLimit);
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

    // Download parts with bounded parallelism (order is restored below via the index)
    const partSemaphore = new Semaphore(3);
    const parts: Blob[] = await Promise.all(
      sortedParts.map((part, i) => partSemaphore.withSlot(async () => {
        const messageId = part.telegram_message_id;
        console.log('[DownloadMerge] Downloading part', i, 'messageId:', messageId);
        if (!messageId) {
          throw new Error(`Missing telegram_message_id for part: ${part.file_id}`);
        }
        const blob = await this.downloadFile(messageId, mimeType);
        console.log('[DownloadMerge] Part', i, 'downloaded, size:', blob.size);
        return blob;
      }))
    );

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
        qrCode: async (qr: { token: Uint8Array; expires: number }) => {
          // URL-safe base64: mobile Telegram URL-decodes query params, so
          // standard base64's '+' becomes space and corrupts the token bytes.
          const tokenBase64 = btoa(String.fromCharCode(...new Uint8Array(qr.token)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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
