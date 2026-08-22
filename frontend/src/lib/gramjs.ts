import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import { Api } from "telegram/tl";
import bigInt from "big-integer";
import {
  MAX_CONCURRENT_CHUNKS,
  CHUNK_RETRY_COUNT,
  MESSAGE_SENDS_PER_SECOND,
  MESSAGE_SEND_BURST,
  ALBUM_SEND_TIMEOUT_MS,
  CHUNK_RATE_INIT,
  CHUNK_RATE_MIN,
  CHUNK_RATE_MAX,
  CHUNK_RATE_DECREASE_FACTOR,
  CHUNK_RATE_INCREASE_STEP,
  CHUNK_RATE_INCREASE_INTERVAL_MS,
  CHUNK_RATE_CLEAN_WINDOW_MS,
  CHUNK_RATE_BURST,
  CHUNK_CEILING_BACKOFF,
  CHUNK_CEILING_SLOW_ZONE,
  CHUNK_CEILING_FLOOR,
  CHUNK_RATE_SLOW_STEP,
  CHUNK_RATE_SLOW_INTERVAL_MS,
  CHUNK_PROBE_COOLDOWN_MS,
  CHUNK_PROBE_COOLDOWN_MAX_MS,
  CHUNK_PROBE_STEP,
  CHUNK_PROBE_CONFIRM_MS,
  CHUNK_FLOOD_ESCALATION_COUNT,
  CHUNK_FLOOD_ESCALATION_WINDOW_MS,
  CHUNK_ESCALATED_DECREASE_FACTOR,
  CHUNK_ESCALATED_CEILING_FACTOR,
  CHUNK_ESCALATED_CLEAN_WINDOW_MS,
  CHUNK_ESCALATION_RESET_MS,
  CHUNK_SIZE as PART_SIZE,
} from "../config";
import { Semaphore } from "./semaphore";
import { RateLimiter } from "./rateLimiter";
import { AdaptiveRateLimiter } from "./adaptiveRateLimiter";
import { readMedia, isOwnAccount, senderDcFor, type MediaRef } from "./telegramMedia";
import { unwrapForwardedMessage } from "./forwardResult";

// Adaptive FLOOD backoff: if a message send fails with FLOOD_WAIT, penalize
// that account's limiter so its pending sends slow down instead of piling more
// requests onto the flood.
const FLOOD_PENALTY_MS = 10_000;

function floodText(err: unknown): string {
  const e = err as { errorMessage?: string; message?: string } | null;
  return `${e?.errorMessage ?? ''} ${e?.message ?? ''}`;
}

function isFloodError(err: unknown): boolean {
  return floodText(err).includes('FLOOD');
}

/**
 * FLOOD_PREMIUM_WAIT means "this account's upload tier is capped" — not
 * "you are sending too fast". Slowing down does not reduce it (verified: it
 * still fires thousands of times at the 0.5 parts/s floor, and the official
 * Telegram Desktop client hits the same wall), so it must not drive the
 * pacer's rate cut or ceiling memory — only a wait.
 */
function isPremiumFloodError(err: unknown): boolean {
  return floodText(err).includes('PREMIUM');
}

/**
 * Adaptive pacer for chunk uploads (SaveFilePart / SaveBigFilePart). Telegram
 * rate-limits upload parts PER ACCOUNT, and within one account this bucket is
 * shared by small files, thumbnails, and large-file splits alike.
 * Unsynchronized per-request retries (GramJS's built-in behavior) would keep
 * hammering the server during a FLOOD_WAIT penalty and make it escalate
 * (observed 5s → 15s on this account), so every part is paced through an AIMD
 * limiter: multiplicative rate cut on FLOOD_WAIT, additive ramp-up once clean.
 * Deliberately not cross-penalized with messageRateLimiter — Telegram tracks
 * SaveFilePart and message-send RPCs as separate buckets, so coupling them
 * would only slow down the healthy side.
 *
 * One pacer per account, and the learned ceiling is stored per account too: a
 * premium account's ceiling must not be dragged down by a free one's.
 */
function createChunkPacer(accountId: number): AdaptiveRateLimiter {
  return new AdaptiveRateLimiter({
  initialRate: CHUNK_RATE_INIT,
  minRate: CHUNK_RATE_MIN,
  maxRate: CHUNK_RATE_MAX,
  decreaseFactor: CHUNK_RATE_DECREASE_FACTOR,
  increaseStep: CHUNK_RATE_INCREASE_STEP,
  increaseIntervalMs: CHUNK_RATE_INCREASE_INTERVAL_MS,
  cleanWindowMs: CHUNK_RATE_CLEAN_WINDOW_MS,
  burst: CHUNK_RATE_BURST,
  storageKey: `teledrive_chunk_rate_v2_${accountId}`,
  label: `ChunkRate:${accountId}`,
  // Ceiling memory: remember the flood-triggering rate and converge just below
  // it, instead of re-probing past the account limit every cycle (the sawtooth
  // that made FLOOD_WAIT recur ~once a minute). See adaptiveRateLimiter.ts.
  ceiling: {
    backoff: CHUNK_CEILING_BACKOFF,
    slowZone: CHUNK_CEILING_SLOW_ZONE,
    floor: CHUNK_CEILING_FLOOR,
    slowStep: CHUNK_RATE_SLOW_STEP,
    slowIntervalMs: CHUNK_RATE_SLOW_INTERVAL_MS,
    probeCooldownMs: CHUNK_PROBE_COOLDOWN_MS,
    probeCooldownMaxMs: CHUNK_PROBE_COOLDOWN_MAX_MS,
    probeStep: CHUNK_PROBE_STEP,
    probeConfirmMs: CHUNK_PROBE_CONFIRM_MS,
    escalationCount: CHUNK_FLOOD_ESCALATION_COUNT,
    escalationWindowMs: CHUNK_FLOOD_ESCALATION_WINDOW_MS,
    escalatedDecreaseFactor: CHUNK_ESCALATED_DECREASE_FACTOR,
    escalatedCeilingFactor: CHUNK_ESCALATED_CEILING_FACTOR,
    escalatedCleanWindowMs: CHUNK_ESCALATED_CLEAN_WINDOW_MS,
    escalationResetMs: CHUNK_ESCALATION_RESET_MS,
  },
  });
}

/** Rejects with a timeout error if `promise` doesn't settle within `ms`. */
function invokeWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Generate a random BigInteger for fileId in SaveBigFilePart operations.
 * Uses big-integer library for compatibility with GramJS API.
 */
/** One Telegram message's worth of a (possibly split) file. `index` is the segment order. */
export type SegmentResult = {
  index: number;
  message_id: number;
  file_id: string;
  access_hash?: string;
  size: number;
  /** Account holding this message — access_hash is only valid against it. */
  account_id: number;
};

export type PreparedAlbumFile = { file: File; media: Api.InputMediaDocument; docId: unknown; hasThumbnail: boolean };
export type AlbumFileResult = { message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean };

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
 * Build the right file location for a media ref. Photos need
 * InputPhotoFileLocation with a size type — an InputDocumentFileLocation with
 * a photo id downloads nothing useful, which is the bug this replaces.
 */
function fileLocationFor(ref: MediaRef, thumbSize: string): Api.TypeInputFileLocation {
  if (ref.kind === 'photo') {
    return new Api.InputPhotoFileLocation({
      id: ref.rawId as any,
      accessHash: ref.accessHash as any,
      fileReference: ref.fileReference,
      thumbSize,
    });
  }
  return new Api.InputDocumentFileLocation({
    id: ref.rawId as any,
    accessHash: ref.accessHash as any,
    fileReference: ref.fileReference,
    thumbSize,
  });
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

  // Every rate limit Telegram enforces is per account, so each account gets its
  // own full budget: one account's FLOOD_WAIT must only slow that account down.
  private readonly uploadSemaphore = new Semaphore(MAX_CONCURRENT_CHUNKS);
  // Throttles message-creating RPCs (sendFile / SendMultiMedia / UploadMedia).
  // Does NOT gate chunk uploads — those are bounded by uploadSemaphore + chunkPacer.
  private readonly messageRateLimiter = new RateLimiter(MESSAGE_SENDS_PER_SECOND, MESSAGE_SEND_BURST);
  // Lazy: the pacer reads its learned ceiling from a localStorage key that
  // includes accountId, which isn't known until initialize() resolves getMe().
  private _chunkPacer: AdaptiveRateLimiter | null = null;

  /** Telegram account this client acts as. 0 until initialize()/login identifies it. */
  accountId: number;
  /** Set when the MTProto handshake failed — the pool skips it for uploads. */
  offline = false;

  constructor(accountId = 0) {
    this.accountId = accountId;
  }

  private get chunkPacer(): AdaptiveRateLimiter {
    if (!this._chunkPacer) this._chunkPacer = createChunkPacer(this.accountId);
    return this._chunkPacer;
  }

  /** Current rate, flood count, and learned ceiling — for batch-summary logging. */
  getChunkRateStats(): { rate: number; floods: number; ceiling: number | null } {
    return this.chunkPacer.stats();
  }

  private penalizeForFlood(label: string, err: unknown): void {
    const seconds = (err as { seconds?: number } | null)?.seconds;
    const waitMs = (typeof seconds === 'number' && seconds > 0 ? seconds : FLOOD_PENALTY_MS / 1000) * 1000;
    console.warn(`[GramJS:${this.accountId}] ${label} hit FLOOD_WAIT — pausing message sends for ${waitMs}ms`);
    this.messageRateLimiter.penalize(waitMs);
  }

  /**
   * Run one upload.GetFile on whichever connection can actually serve it.
   *
   * Media this account uploaded lives on its home DC, so the main sender
   * answers and we stay on it — deliberately, because gramjs's getSender()
   * opens a fresh exported sender for ANY dcId it is handed, and that
   * redundant same-DC connection is what made batch thumbnail downloads
   * reconnect-loop through the ws proxy (813dc42).
   *
   * A forwarded file (chat import) keeps the SOURCE chat's DC, and the main
   * sender answers those with FILE_MIGRATE_x instead of bytes. gramjs's own
   * download path has always read the dcId off the media for exactly this
   * reason (client/downloads.js: iterDownload → getSender(info.dcId)); our
   * wrapper just never carried the field through. senderDcFor() decides.
   */
  private async getFileFrom(request: InstanceType<typeof Api.upload.GetFile>, ref: MediaRef): Promise<any> {
    const client = this.client!;
    const dcId = senderDcFor(ref.dcId, (client.session as any)?.dcId);
    if (dcId === undefined) return await client.invoke(request);
    const sender = await (client as any).getSender(dcId);
    return await sender.send(request);
  }

  /**
   * Send one SaveFilePart/SaveBigFilePart directly on the upload sender, paced
   * through this account's chunkPacer. Bypasses client.invoke on purpose:
   * invoke's floodSleepThreshold auto-sleep is per-request and silent, so
   * concurrent parts each sleep and retry on their own schedule — exactly the
   * herd behavior the pacer's virtual-time scheduling avoids.
   * Non-flood errors are thrown to the caller (which has its own retry loop).
   */
  private async sendFilePartGated(
    request: InstanceType<typeof Api.upload.SaveFilePart> | InstanceType<typeof Api.upload.SaveBigFilePart>,
    label: string,
  ): Promise<void> {
    const client = this.client!;
    let floodRetries = 0;
    for (;;) {
      await this.chunkPacer.wait();
      let sender: { send: (req: unknown) => Promise<unknown>; isConnected?: () => boolean } | undefined;
      try {
        sender = await (client as any).getSender((client.session as any).dcId);
        await sender!.send(request);
        this.chunkPacer.reportSuccess();
        return;
      } catch (err) {
        if (isFloodError(err)) {
          if (++floodRetries > 10) throw err;
          const seconds = (err as { seconds?: number } | null)?.seconds;
          console.warn(`[GramJS:${this.accountId}] ${label} flood: ${floodText(err).trim()} (seconds=${seconds})`);
          if (isPremiumFloodError(err)) {
            // Account-tier cap — wait it out at full rate, don't self-throttle.
            this.chunkPacer.pause(seconds);
          } else {
            this.chunkPacer.reportFlood(seconds);
          }
          continue;
        }
        if (sender && sender.isConnected && !sender.isConnected()) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
  }
  // Tracks the in-flight/most recent initialize() call so operations issued while
  // the UI has already mounted (App no longer blocks on the MTProto handshake) can wait for it.
  private initPromise: Promise<void> | null = null;
  // Caches the resolved document location per message so SW chunk streaming doesn't
  // pay a getMessages round trip on every single chunk request.
  private fileLocationCache = new Map<number, MediaRef>();

  /**
   * Resolve (and cache) the document location for a message. Pass forceRefresh=true
   * after a FILE_REFERENCE_EXPIRED error to re-fetch a fresh file reference.
   */
  private async getFileLocation(
    messageId: number,
    forceRefresh = false,
    expectedFileId?: string,
  ): Promise<MediaRef> {
    if (!forceRefresh) {
      const cached = this.fileLocationCache.get(messageId);
      if (cached) return cached;
    }
    const messages = await this.client!.getMessages("me", { ids: [messageId] });
    const message = messages[0] as Api.Message;
    if (!message?.media) throw new Error("Message has no media");
    const ref = readMedia(message.media);
    if (!ref) throw new Error('Unsupported media type: ' + (message.media as any)?.className);
    if (expectedFileId && ref.id !== expectedFileId) {
      // Message ids are only unique within one account. If we ever ask the
      // wrong client, this is what turns "silently downloaded someone else's
      // file" into a loud failure.
      throw new Error(
        `Message ${messageId} on account ${this.accountId} holds document ${ref.id}, expected ${expectedFileId}`
      );
    }
    this.fileLocationCache.set(messageId, ref);
    return ref;
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
    this.session = new StringSession(sessionString || "");

    this.client = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
      // Telegram's plain-ws endpoint (port 80) now answers 302, so wss:443 is the
      // only working transport - regardless of whether this page is http or https.
      useWSS: true,
      deviceModel: "TeleDrive Browser",
      appVersion: "1.0.0",
      floodSleepThreshold: 300,
    });

    // Connect to Telegram
    await this.client.connect();

    // Check if session is valid by trying to get the current user
    try {
      const myself = await this.client.getMe() as { id?: unknown; username?: string; firstName?: string };
      // Self-identify: sessions migrated from the single-account era arrive with
      // accountId 0, and the pool is keyed by it.
      if (myself.id != null) this.accountId = Number(myself.id);
      console.log(`[GramJS:${this.accountId}] Connected as:`, myself.username || myself.firstName);
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
          await this.messageRateLimiter.wait();
          return await this.client!.sendFile("me", params);
        } catch (err: any) {
          const isEntityZero = err?.message?.includes('ID 0') || err?.message?.includes('Entity');
          if (isEntityZero && attempt < maxRetries - 1) {
            console.warn(`[GramJS] sendFile entity-0 error (attempt ${attempt + 1}), refreshing entity cache...`);
            try { await this.client!.getMe(); } catch { /* ignore */ }
            continue;
          }
          if (isFloodError(err) && attempt < maxRetries - 1) {
            this.penalizeForFlood('sendFile', err);
            continue;
          }
          throw err;
        }
      }
    });
  }

  /**
   * Call sendFileLocked with an optional thumbnail attached. GramJS's own
   * sendFile() `thumb` option expects a RAW file (native File/Buffer/path) —
   * it uploads the thumb itself internally — unlike InputMediaUploadedDocument
   * (used by uploadAlbum) which needs an already-uploaded InputFile. Passing a
   * CustomFile or pre-uploaded InputFile here throws "Could not create file
   * from [object Object]" inside GramJS.
   *
   * If attaching the thumb fails, retries once without it so a thumbnail
   * problem never blocks the file upload itself.
   */
  private async sendFileWithOptionalThumb(
    params: Record<string, unknown>,
    thumb?: Blob | null,
  ): Promise<{ message: unknown; hasThumbnail: boolean }> {
    if (!thumb) {
      return { message: await this.sendFileLocked(params), hasThumbnail: false };
    }
    const thumbFile = new File([thumb], 'thumb.jpg', { type: thumb.type || 'image/jpeg' });
    // No silent retry-without-thumb: a media file must not land in the drive
    // without its thumbnail. When a thumb was provided, sending with it MUST
    // succeed or the whole upload fails (the caller marks the file as errored).
    const message = await this.sendFileLocked({ ...params, thumb: thumbFile });
    return { message, hasThumbnail: true };
  }

  /**
   * Upload a whole file that fits in one Telegram message via GramJS's own
   * sendFile (≤10MB path — CustomFile, not SaveBigFilePart).
   */
  async uploadSmallFile(file: File, thumb?: Blob | null): Promise<SegmentResult & { hasThumbnail: boolean }> {
    await this.waitUntilReady();
    if (!this.client) throw new Error("Client not initialized. Call initialize() first.");

    const arrayBuffer = await file.arrayBuffer();
    const buffer = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));
    const customFile = new CustomFile(file.name, file.size, "", buffer);

    const { message, hasThumbnail } = await this.sendFileWithOptionalThumb({
      file: customFile,
      workers: 4,
      forceDocument: true,
    }, thumb);

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
    return { index: 0, message_id: msg.id, file_id: fileId, access_hash: accessHash, size: file.size, account_id: this.accountId, hasThumbnail };
  }

  /**
   * Upload ONE segment of a large file (up to MAX_PARTS 512KB parts) and turn it
   * into a single Telegram message. Everything here — the chunk semaphore, the
   * pacer, the resulting access_hash — belongs to this account alone, which is
   * what lets sibling segments run on other accounts concurrently.
   *
   * The returned index is the caller's segment index: message ids are only
   * monotonic WITHIN an account, so they cannot order parts that were spread
   * across accounts. See splitUpload.ts.
   */
  async uploadSegment(
    file: File,
    segment: { index: number; offset: number; parts: number; size: number },
    thumb?: Blob | null,
    onChunkDone?: () => void,
  ): Promise<SegmentResult & { hasThumbnail: boolean }> {
    await this.waitUntilReady();
    if (!this.client) throw new Error("Client not initialized. Call initialize() first.");

    const fileId = generateRandomBigInt();
    console.log(`[SplitUpload:${this.accountId}] segment ${segment.index}: ${segment.parts} parts at offset ${segment.offset}`);

    await Promise.all(Array.from({ length: segment.parts }, (_, partIdx) =>
      this.uploadSemaphore.withSlot(async () => {
        const offset = segment.offset + partIdx * PART_SIZE;
        const chunk = file.slice(offset, Math.min(offset + PART_SIZE, file.size));
        const bytes = (globalThis as any).Buffer.from(new Uint8Array(await chunk.arrayBuffer()));

        for (let retry = 0; retry < CHUNK_RETRY_COUNT; retry++) {
          try {
            await this.sendFilePartGated(new Api.upload.SaveBigFilePart({
              fileId,
              filePart: partIdx,
              fileTotalParts: segment.parts,
              bytes,
            }), 'SaveBigFilePart');
            onChunkDone?.();
            return;
          } catch (err: any) {
            console.error(`[SplitUpload:${this.accountId}] part ${partIdx} attempt ${retry + 1} FAILED:`, err?.message || err);
            if (retry === CHUNK_RETRY_COUNT - 1) throw err;
            // Exponential backoff (1s/2s/4s...) — FLOOD_WAIT is handled inside
            // sendFilePartGated (rate cut + wait), this covers other transient failures.
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, retry)));
          }
        }
      })
    ));

    const { message, hasThumbnail } = await this.sendFileWithOptionalThumb({
      file: new Api.InputFileBig({ id: fileId, parts: segment.parts, name: file.name }),
      forceDocument: true,
    }, thumb);

    const msg = message as Api.Message;
    const media = msg.media as { className?: string } | undefined;
    let accessHash: string | undefined;
    if (media?.className === "MessageMediaDocument") {
      const doc = media as unknown as { document: { accessHash?: bigint } };
      accessHash = doc.document.accessHash ? String(doc.document.accessHash) : undefined;
    }

    console.log(`[SplitUpload:${this.accountId}] segment ${segment.index} sent, message_id:`, msg.id);
    return {
      index: segment.index,
      message_id: msg.id,
      file_id: String(fileId),
      access_hash: accessHash,
      size: segment.size,
      account_id: this.accountId,
      hasThumbnail,
    };
  }

  /**
   * Upload a small file's (≤10MB) raw bytes as 512KB upload.SaveFilePart
   * chunks and return the InputFile handle. Replaces GramJS's client.uploadFile
   * for the album path because that helper (a) hardcodes 128KB parts for files
   * under 100MB (Utils.getAppropriatedPartSize) — 4× the RPC count per MB,
   * which trips Telegram's per-account part-rate limit much sooner — and
   * (b) swallows FLOOD_WAIT with a silent per-request sleep, invisible to our
   * global backoff. Chunks are bounded by this account's uploadSemaphore and
   * every part send goes through its chunk pacer.
   */
  private async uploadFilePartsPaced(buf: { length: number; subarray(start: number, end: number): unknown }, fileName: string): Promise<Api.InputFile> {
    const fileId = generateRandomBigInt();
    const partCount = Math.max(1, Math.ceil(buf.length / PART_SIZE));

    await Promise.all(Array.from({ length: partCount }, (_, partIdx) =>
      this.uploadSemaphore.withSlot(async () => {
        const bytes = (buf as any).subarray(partIdx * PART_SIZE, Math.min((partIdx + 1) * PART_SIZE, buf.length));
        for (let retry = 0; retry < CHUNK_RETRY_COUNT; retry++) {
          try {
            await this.sendFilePartGated(new Api.upload.SaveFilePart({
              fileId: fileId as any,
              filePart: partIdx,
              bytes,
            }), `SaveFilePart(${fileName})`);
            return;
          } catch (err: any) {
            console.error('[SmallUpload] Part', partIdx, 'of', fileName, 'attempt', retry + 1, 'FAILED:', err?.message || err);
            if (retry === CHUNK_RETRY_COUNT - 1) throw err;
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, retry)));
          }
        }
      })
    ));

    return new Api.InputFile({
      id: fileId as any,
      parts: partCount,
      name: fileName,
      md5Checksum: "",
    });
  }

  /**
   * Prepare a single file for album inclusion: upload raw bytes (+ optional
   * thumb) as paced 512KB parts, attach the thumb at the messages.UploadMedia stage
   * (this is what avoids the 400 MEDIA_INVALID seen when a thumb is put
   * directly on the InputMediaUploadedDocument passed to SendMultiMedia
   * itself). Mirrors GramJS's own `_sendAlbum` internals (client/uploads.js)
   * for this half of the flow.
   *
   * Split out from the old combined uploadAlbum() so callers can run this
   * step under a per-file concurrency slot and release that slot the instant
   * bytes are on Telegram's servers — group assembly (sendAlbum) then runs
   * unbounded, so the upload queue never idles waiting on message sends or
   * metadata registration.
   *
   * Returns null (and logs) on failure — caller should treat that file as
   * failed without blocking the rest of the batch.
   */
  async prepareAlbumFile(file: File, thumb?: Blob | null): Promise<PreparedAlbumFile | null> {
    await this.waitUntilReady();
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }
    const client = this.client;

    try {
      const t0 = performance.now();
      const arrayBuffer = await file.arrayBuffer();
      const buf = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));
      const tRead = performance.now();
      const fileHandle = await this.uploadFilePartsPaced(buf, file.name);
      const tBytes = performance.now();

      let uploadedThumb: unknown;
      if (thumb) {
        const thumbBuf = (globalThis as any).Buffer.from(new Uint8Array(await thumb.arrayBuffer()));
        uploadedThumb = await this.uploadFilePartsPaced(thumbBuf, 'thumb.jpg');
      }
      const tThumb = performance.now();

      const uploadMediaReq = new Api.messages.UploadMedia({
        peer: new Api.InputPeerSelf(),
        media: new Api.InputMediaUploadedDocument({
          file: fileHandle,
          mimeType: file.type || 'application/octet-stream',
          attributes: [new Api.DocumentAttributeFilename({ fileName: file.name })],
          thumb: uploadedThumb as any,
          forceFile: true,
        }),
      });
      // UploadMedia is a message-class RPC and shares Telegram's message flood
      // bucket, so pace it through messageRateLimiter (10 per batch would
      // otherwise fire unthrottled). Retry a few times on FLOOD_WAIT, matching
      // the SendMultiMedia path.
      let uploadedMedia: any;
      for (let attempt = 0; ; attempt++) {
        await this.messageRateLimiter.wait();
        try {
          uploadedMedia = await client.invoke(uploadMediaReq) as any;
          break;
        } catch (err) {
          if (isFloodError(err) && attempt < CHUNK_RETRY_COUNT - 1) {
            this.penalizeForFlood(`UploadMedia(${file.name})`, err);
            continue;
          }
          throw err;
        }
      }
      const tMedia = performance.now();
      console.log(`[Perf] prepare ${file.name} (${Math.round(file.size / 1024)}KB): read=${Math.round(tRead - t0)}ms bytes=${Math.round(tBytes - tRead)}ms thumbUp=${Math.round(tThumb - tBytes)}ms uploadMedia=${Math.round(tMedia - tThumb)}ms total=${Math.round(tMedia - t0)}ms`);

      const doc = uploadedMedia.document;
      if (!doc) throw new Error('UploadMedia returned no document');

      return {
        file,
        media: new Api.InputMediaDocument({
          id: new Api.InputDocument({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference }),
        }),
        docId: doc.id,
        hasThumbnail: !!thumb,
      };
    } catch (err) {
      console.error('[Album] Prepare failed for', file.name, err);
      return null;
    }
  }

  /**
   * Group already-prepared files (see prepareAlbumFile) into one Telegram
   * album — confirmed working against this account/GramJS version via an
   * isolated Node.js probe (2026-07-10; see
   * docs/superpowers/specs/2026-07-10-embedded-thumb-album-upload-design.md).
   * The earlier "SendMultiMedia hangs forever" conclusion was wrong; it was
   * an artifact of a separate browser/proxy test harness, not a library or
   * protocol limitation.
   *
   * Falls back to sending each prepared file individually (sendFileLocked)
   * if SendMultiMedia errors or exceeds ALBUM_SEND_TIMEOUT_MS. Does not touch
   * any per-file concurrency slot — safe to call after those have been
   * released, so it never blocks the next file's bytes from starting.
   */
  async sendAlbum(prepared: PreparedAlbumFile[]): Promise<AlbumFileResult[]> {
    await this.waitUntilReady();
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }
    const client = this.client;

    const emptyResult = (): AlbumFileResult => ({ message_id: 0, file_id: '', access_hash: undefined, size: 0, has_thumbnail: false });
    const results: AlbumFileResult[] = prepared.map(emptyResult);

    if (prepared.length === 0) return results;

    let sendSucceeded = false;
    try {
      const t0 = performance.now();
      await this.messageRateLimiter.wait();
      const tLimiter = performance.now();
      const multiMedia = prepared.map((p) => new Api.InputSingleMedia({
        media: p.media,
        randomId: generateRandomBigInt() as any,
        message: '',
      }));
      const updates = await invokeWithTimeout(
        client.invoke(new Api.messages.SendMultiMedia({ peer: new Api.InputPeerSelf(), multiMedia })),
        ALBUM_SEND_TIMEOUT_MS,
      ) as { updates?: Array<{ message?: { id: number; media?: { document?: { id: unknown; accessHash?: unknown } } } }> };
      console.log(`[Perf] sendAlbum x${prepared.length}: limiterWait=${Math.round(tLimiter - t0)}ms sendMultiMedia=${Math.round(performance.now() - tLimiter)}ms`);

      // Map back by document id (not array position) — Telegram doesn't guarantee order.
      const docIdToMessage = new Map<string, { id: number; accessHash?: unknown }>();
      for (const u of updates.updates ?? []) {
        const doc = u.message?.media?.document;
        if (u.message?.id && doc?.id) docIdToMessage.set(String(doc.id), { id: u.message.id, accessHash: doc.accessHash });
      }
      prepared.forEach((p, i) => {
        const found = docIdToMessage.get(String(p.docId));
        results[i] = found
          ? { message_id: found.id, file_id: String(p.docId), access_hash: found.accessHash ? String(found.accessHash) : undefined, size: p.file.size, has_thumbnail: p.hasThumbnail }
          : emptyResult();
      });
      sendSucceeded = true;
    } catch (err) {
      if (isFloodError(err)) this.penalizeForFlood('SendMultiMedia', err);
      console.warn('[Album] SendMultiMedia failed/timed out, falling back to per-file sendFile:', err);
    }

    if (!sendSucceeded) {
      await Promise.all(prepared.map(async (p, i) => {
        try {
          const arrayBuffer = await p.file.arrayBuffer();
          const buf = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));
          const customFile = new CustomFile(p.file.name, p.file.size, "", buf);
          const message = await this.sendFileLocked({ file: customFile, workers: 1, forceDocument: true }) as Api.Message;
          const media = message.media as any;
          const doc = media?.className === 'MessageMediaDocument' ? media.document : undefined;
          results[i] = doc
            ? { message_id: message.id, file_id: String(doc.id), access_hash: doc.accessHash ? String(doc.accessHash) : undefined, size: p.file.size, has_thumbnail: false }
            : emptyResult();
        } catch (err) {
          console.error('[Album] Fallback sendFile failed:', p.file.name, err);
        }
      }));
    }

    return results;
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
          const ref = readMedia(msg.media);
          if (!ref?.previewThumbSize) return; // no usable preview — nothing to show
          try {
            // Fetch the thumb via GetFile on the MAIN connection with cdnSupported
            // OFF, instead of downloadMedia — downloadMedia borrows an exported
            // sender to the file's media DC, and that extra ws-proxied connection
            // reconnect-loops ("Connection closed while receiving data"). Keeping
            // thumbnails on the main sender (like the parallel preview path) avoids it.
            const location = fileLocationFor(ref, ref.previewThumbSize);
            const fileResult = await this.getFileFrom(
              new Api.upload.GetFile({
                location,
                offset: BigInt(0) as any,
                limit: 512 * 1024, // aligned; thumbs are far smaller, EOF truncates
                precise: false,
                cdnSupported: false,
              }),
              ref,
            );
            if (fileResult?.bytes?.length) {
              result.set(msg.id, new Blob([new Uint8Array(fileResult.bytes)], { type: 'image/jpeg' }));
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

    const ref = readMedia(message.media);
    if (!ref) throw new Error("Unsupported media type: " + (message.media as any)?.className);
    console.log('[FileMetadata] Got metadata - size:', ref.size, 'mimeType:', ref.mimeType);
    return { size: ref.size, mimeType: ref.mimeType };
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

    // Images: download all 512KB chunks in parallel (waitForComplete) instead of
    // GramJS's sequential 128KB-per-round-trip downloadMedia. Every byte is
    // fetched over one MTProto connection, so hiding round-trips with pipelined GetFile
    // requests is the single biggest win for multi-MB previews. Fall back to the
    // sequential path if the parallel one fails.
    if (mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType.startsWith('image/')) {
      console.log('[Download] Image file, using parallel chunked download...');
      try {
        return await this.downloadFileChunked(message, mimeType, true);
      } catch (err: any) {
        console.warn('[Download] Parallel image download failed, falling back to downloadMedia:', err?.message);
        const buffer = await this.client.downloadMedia(message.media);
        if (!buffer || buffer.length === 0) {
          throw new Error("Failed to download file - empty buffer");
        }
        return new Blob([buffer], { type: mimeType });
      }
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
  async downloadFileChunked(message: Api.Message, mimeType: string = 'application/octet-stream', waitForComplete: boolean = false): Promise<Blob> {
    console.log('[Streaming] Starting streaming download...');

    // Extract file location from message media
    const ref = readMedia(message.media);
    if (!ref) throw new Error('Unsupported media type: ' + (message.media as any)?.className);
    const fileSize = ref.size;

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

    const location = fileLocationFor(ref, ref.fullThumbSize);

    const chunkSemaphore = new Semaphore(6);

    const downloadChunk = async (chunkIndex: number) => {
      const offset = chunkIndex * CHUNK_SIZE;
      // upload.GetFile requires `limit` to be 4096-aligned and to divide 1MB, so
      // the final chunk must NOT be shortened to the exact remaining byte count
      // (that produced 400 LIMIT_INVALID). Always request a full aligned 512KB —
      // Telegram returns only the bytes that exist up to EOF.
      const limit = CHUNK_SIZE;
      const fileResult = await this.getFileFrom(
        new Api.upload.GetFile({
          location,
          offset: BigInt(offset) as any,
          limit,
          precise: false,
          cdnSupported: true,
        }),
        ref,
      );

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
        // waitForComplete callers (image previews / full downloads) need the
        // ENTIRE file — returning a partial prefix would be a truncated image,
        // so surface a timeout error instead and let the caller fall back.
        if (waitForComplete && !isDownloadComplete) {
          reject(new Error('Download timeout before completion'));
          return;
        }
        console.log('[Streaming] Timeout, returning blob with size:', readyPrefix * CHUNK_SIZE);
        resolve(buildBlob());
      }, waitForComplete ? 180000 : 60000);

      const check = () => {
        if (settled) return;
        // For full downloads any chunk error is fatal (the blob would have a
        // hole); for streaming we only bail when nothing at all arrived.
        if (downloadError && (waitForComplete || readyPrefix === 0)) {
          settled = true;
          clearTimeout(timeoutId);
          reject(downloadError);
          return;
        }
        const readyBytes = Math.min(readyPrefix * CHUNK_SIZE, fileSize);
        const ready = waitForComplete
          ? isDownloadComplete
          : (readyBytes >= MIN_READY_BYTES || (isDownloadComplete && readyPrefix > 0));
        if (ready) {
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

  /**
   * @param expectedFileId - the document id this message is supposed to hold.
   *   Checked against what Telegram returns so a wrong-account lookup fails
   *   loudly instead of streaming a same-numbered message's contents.
   */
  async downloadFileChunkedByOffset(messageId: number, offset: number, limit: number, fileSize?: number, expectedFileId?: string): Promise<Blob> {
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

    const toLocation = (ref: MediaRef) => fileLocationFor(ref, ref.fullThumbSize);

    // Cached after the first chunk of a given message — subsequent chunks skip getMessages entirely.
    const invokeGetFile = async (off: number, lim: number): Promise<any> => {
      const ref = await this.getFileLocation(messageId, false, expectedFileId);
      try {
        return await this.getFileFrom(
          new Api.upload.GetFile({ location: toLocation(ref), offset: BigInt(off) as any, limit: lim, precise: true, cdnSupported: true }),
          ref,
        );
      } catch (err: any) {
        if (/FILE_REFERENCE_EXPIRED/i.test(err?.message || '')) {
          console.warn('[ChunkByOffset] File reference expired, refreshing for message', messageId);
          const fresh = await this.getFileLocation(messageId, true, expectedFileId);
          return await this.getFileFrom(
            new Api.upload.GetFile({ location: toLocation(fresh), offset: BigInt(off) as any, limit: lim, precise: true, cdnSupported: true }),
            fresh,
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
   * Resolve a channel/group from a username, t.me link, or numeric id.
   *
   * A numeric id alone is not enough for a private channel — MTProto needs the
   * peer's access_hash, which only lives in the session's entity cache. So on
   * failure we pull the dialog list once (which populates that cache) and try
   * again before giving up.
   */
  async resolveChat(input: string): Promise<{ entity: any; title: string; noForwards: boolean }> {
    await this.waitUntilReady();
    if (!this.client) throw new Error('Client not initialized');

    const raw = input.trim().replace(/^(https?:\/\/)?t\.me\//i, '').replace(/^@/, '');
    const asNumber = /^-?\d+$/.test(raw) ? Number(raw) : null;
    const target: string | number = asNumber ?? raw;

    let entity: any;
    try {
      entity = await this.client.getEntity(target as any);
    } catch (err) {
      console.warn('[ChatImport] getEntity failed, refreshing dialogs and retrying', err);
      await this.client.getDialogs({ limit: 200 });
      try {
        entity = await this.client.getEntity(target as any);
      } catch {
        throw new Error(`此帳號無法存取 chat「${input}」。請先用同一個 Telegram 帳號開啟過該對話。`);
      }
    }

    // CRITICAL — do not remove: Saved Messages is chat import's DESTINATION.
    // 'me', the account's own username, and the account's own numeric id all
    // resolve to this same entity, and none of them error out — getEntity('me')
    // just returns the self User. Importing it forwards every message of Saved
    // Messages back into Saved Messages and re-registers each with the SAME
    // file_id the drive already holds; insert_file is INSERT OR REPLACE on
    // file_id, so every existing row gets rewritten with a new message id, the
    // import folder as parent, and split_group_id/part_index/is_split_file
    // reset — permanently breaking every split (>512MB) file in this drive.
    if (isOwnAccount(entity, this.accountId)) {
      throw new Error('Saved Messages 是匯入的目的地，不能同時作為來源匯入 —— 這麼做會覆蓋並毀損雲端硬碟中已有的檔案紀錄（尤其是大檔案的分割片段）。');
    }

    const title = entity.title
      || [entity.firstName, entity.lastName].filter(Boolean).join(' ')
      || entity.username
      || String(input);
    return { entity, title, noForwards: Boolean(entity.noforwards) };
  }

  /**
   * Yield every message in the chat, oldest-first — media and non-media alike.
   *
   * The media filter itself lives in runImport (chatImport.ts, via readMedia),
   * not here: a chat can have thousands of text messages before its first
   * media one, and runImport needs to see (report scan progress for, and be
   * able to stop within) that whole stretch. An iterator that silently
   * skipped non-media messages would hide it from the loop entirely, leaving
   * onProgress uncalled and shouldStop() unchecked for as long as the
   * stretch lasts.
   */
  async *iterChatMedia(entity: any): AsyncGenerator<Api.Message> {
    await this.waitUntilReady();
    if (!this.client) throw new Error('Client not initialized');
    for await (const message of this.client.iterMessages(entity, { reverse: true })) {
      yield message as Api.Message;
    }
  }

  /**
   * Forward one message into Saved Messages and return the new message.
   *
   * ponytail: one message per call, paced by messageRateLimiter (~3/s). Telegram
   * accepts up to 100 ids per forwardMessages call, which would be ~100x faster;
   * the upgrade path is batching and matching the returned messages back to
   * their sources by media id, since the API gives no explicit mapping.
   */
  async forwardToSaved(entity: any, messageId: number): Promise<Api.Message> {
    await this.waitUntilReady();
    if (!this.client) throw new Error('Client not initialized');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.messageRateLimiter.wait();
        const result = await this.client.forwardMessages('me', {
          messages: [messageId],
          fromPeer: entity,
        });
        return unwrapForwardedMessage(result, messageId) as Api.Message;
      } catch (err: any) {
        if (isFloodError(err) && attempt < 2) {
          this.penalizeForFlood('forwardMessages', err);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Forward of message ${messageId} failed after retries`);
  }

  /**
   * DM a login nonce to our bot. Telegram tells the backend who sent it, which
   * is the whole point: the session string never leaves the browser.
   * @returns the sent message's id, so the caller can tidy it up afterwards
   */
  async sendAuthChallenge(botUsername: string, nonce: string): Promise<number> {
    await this.waitUntilReady();
    if (!this.client) throw new Error('Client not initialized.');
    const msg = await this.client.sendMessage(botUsername, { message: nonce });
    return msg.id;
  }

  /** Remove the nonce message once it's been redeemed — cosmetic, never fatal. */
  async deleteAuthChallenge(botUsername: string, messageId: number): Promise<void> {
    try {
      await this.client?.deleteMessages(botUsername, [messageId], { revoke: true });
    } catch (err) {
      console.warn('[GramJS] Could not delete challenge message:', err);
    }
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
    this.session = new StringSession('');
    this.client = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
      // Telegram's plain-ws endpoint (port 80) now answers 302, so wss:443 is the
      // only working transport - regardless of whether this page is http or https.
      useWSS: true,
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
    this.session = new StringSession('');
    this.client = new TelegramClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
      // Telegram's plain-ws endpoint (port 80) now answers 302, so wss:443 is the
      // only working transport - regardless of whether this page is http or https.
      useWSS: true,
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

// ── Client pool ────────────────────────────────────────────────────────────
// One drive can hold several Telegram accounts. Each gets its own manager (and
// with it its own concurrency budget, pacer, and file-location cache), because
// every limit Telegram enforces — and every access_hash it issues — is scoped
// to one account.

const clients = new Map<number, TelegramClientManager>();

/** The manager for a specific account, created on demand. */
export function getClientFor(accountId: number): TelegramClientManager {
  let c = clients.get(accountId);
  if (!c) {
    c = new TelegramClientManager(accountId);
    clients.set(accountId, c);
  }
  return c;
}

/** Register a manager built outside the pool (the login flow, which only learns its account id afterwards). */
export function adoptClient(accountId: number, manager: TelegramClientManager): void {
  manager.accountId = accountId;
  clients.set(accountId, manager);
}

/** Primary account's client — login and every non-upload path that doesn't care which account. */
export function getPrimaryClient(): TelegramClientManager {
  const accounts = loadAccounts();
  return getClientFor(accounts[0]?.id ?? 0);
}

/** Every account currently usable for uploads (handshake succeeded). */
export function getAllClients(): TelegramClientManager[] {
  return [...clients.values()].filter((c) => !c.offline);
}

/** Disconnect and forget every client (logout). */
export function resetAllClients(): void {
  for (const c of clients.values()) c.disconnect();
  clients.clear();
}

// ── Account credential storage ─────────────────────────────────────────────
// 'tg_accounts': the sessions, one per linked account. 'tg_jwt': one per drive.

export type StoredAccount = { id: number; label: string; session: string };

export function loadAccounts(): StoredAccount[] {
  const raw = localStorage.getItem('tg_accounts');
  if (raw) {
    try {
      return JSON.parse(raw) as StoredAccount[];
    } catch {
      return [];
    }
  }
  // Migrate the single-account era in place. id 0 is a placeholder — the real
  // one is filled in by initialize()'s getMe() and re-saved.
  const legacy = localStorage.getItem('tg_session');
  if (!legacy) return [];
  const migrated: StoredAccount[] = [{ id: 0, label: '', session: legacy }];
  localStorage.setItem('tg_accounts', JSON.stringify(migrated));
  localStorage.removeItem('tg_session');
  return migrated;
}

/** Insert or update one account, keyed by id. */
export function saveAccount(account: StoredAccount): void {
  const accounts = loadAccounts().filter((a) => a.id !== account.id);
  accounts.push(account);
  localStorage.setItem('tg_accounts', JSON.stringify(accounts));
}

export function removeAccount(id: number): void {
  localStorage.setItem('tg_accounts', JSON.stringify(loadAccounts().filter((a) => a.id !== id)));
  clients.get(id)?.disconnect();
  clients.delete(id);
}

export function saveJwt(jwt: string): void {
  localStorage.setItem('tg_jwt', jwt);
}

export function loadJwt(): string | null {
  return localStorage.getItem('tg_jwt');
}

export function clearCredentialsFromStorage(): void {
  localStorage.removeItem('tg_accounts');
  localStorage.removeItem('tg_session');
  localStorage.removeItem('tg_jwt');
}
