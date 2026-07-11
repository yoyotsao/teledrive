/**
 * Upload concurrency configuration for TeleDrive.
 * These constants control parallel upload behavior for both file and chunk uploads.
 */

/**
 * Maximum number of files uploading at once (each file then splits into its own chunks).
 *
 * Safe range: 1-6 (recommended: 3)
 */
export const MAX_CONCURRENT_FILES = 3;

/**
 * Maximum number of 512KB chunk uploads in flight at once, across all files combined.
 * This is the real throughput knob for large-file upload speed — a single big file can
 * use up to this many concurrent chunk uploads.
 *
 * Safe range: 4-20 (recommended: 12). Telegram's floodSleepThreshold absorbs bursts that
 * go too high, but going too high also risks FLOOD_WAIT on constrained accounts.
 */
export const MAX_CONCURRENT_CHUNKS = 12;

/**
 * Number of retry attempts for failed chunk uploads.
 * Each chunk will be retried up to this many times before failing the entire upload.
 *
 * Safe range: 2-5 (recommended: 3)
 * - Too low: Insufficient resilience against transient failures
 * - Too high: Prolonged upload attempts for permanently failed chunks
 */
export const CHUNK_RETRY_COUNT = 3;

/**
 * Max Telegram messages (sendFile / SendMultiMedia) sent per second.
 * An album batch of up to 10 files counts as ONE message, so this throttles
 * small-file/album uploads without limiting large-file chunk throughput.
 * Paired with adaptive FLOOD backoff in gramjs.ts: on FLOOD_WAIT (explicit or
 * suspected via slow invoke) the limiter is penalized back toward the old pace.
 */
export const MESSAGE_SENDS_PER_SECOND = 3;

/**
 * Token-bucket burst for message sends. Allows a short initial burst before
 * the steady MESSAGE_SENDS_PER_SECOND rate applies.
 */
export const MESSAGE_SEND_BURST = 6;

/**
 * Concurrency for hash pre-pass (reading up to 100MB sample per file).
 * The pre-pass blocks all uploads, so for many-small-file drops higher
 * concurrency shortens the dead time before the first byte reaches Telegram.
 */
export const HASH_CONCURRENCY = 8;

/**
 * Max files grouped into a single Telegram album (messages.SendMultiMedia).
 * Telegram's own hard cap for grouped media is 10.
 */
export const ALBUM_BATCH = 10;

/**
 * How long to wait for messages.SendMultiMedia before giving up on the album
 * and falling back to sending each file as its own message.
 */
export const ALBUM_SEND_TIMEOUT_MS = 60_000;

/**
 * Adaptive rate control for SaveFilePart/SaveBigFilePart chunk uploads
 * (shared across small files, thumbnails, and large-file splits — they all
 * hit the same account-level Telegram flood limit). Starts conservative and
 * ramps up when clean, backs off multiplicatively on FLOOD_WAIT.
 */

/** Starting chunk send rate in parts/s (2MB/s at 512KB/part) before any ramp-up. */
export const CHUNK_RATE_INIT = 4;

/** Floor rate in parts/s — worst case still makes forward progress. */
export const CHUNK_RATE_MIN = 0.5;

/** Ceiling rate in parts/s — above this, MAX_CONCURRENT_CHUNKS is the real bottleneck. */
export const CHUNK_RATE_MAX = 12;

/** Multiplicative decrease factor applied to the rate on each FLOOD_WAIT. */
export const CHUNK_RATE_DECREASE_FACTOR = 0.5;

/** Additive increase step (parts/s) applied per ramp-up tick when clean. */
export const CHUNK_RATE_INCREASE_STEP = 0.5;

/** Minimum time between ramp-up ticks. */
export const CHUNK_RATE_INCREASE_INTERVAL_MS = 10_000;

/** How long to stay clean after a FLOOD_WAIT before ramp-up resumes. */
export const CHUNK_RATE_CLEAN_WINDOW_MS = 20_000;

/** Burst allowance (in slots) the chunk rate limiter absorbs before pacing kicks in. */
export const CHUNK_RATE_BURST = 2;