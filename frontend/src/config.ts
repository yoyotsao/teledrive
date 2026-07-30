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
 * Max concurrent in-flight /files/check-hash requests during folder uploads.
 * The folder traversal fans out unbounded, so without this cap hundreds of
 * dedup GETs fire at once and exhaust the browser's connection pool
 * (net::ERR_INSUFFICIENT_RESOURCES).
 */
export const HASH_CHECK_CONCURRENCY = 8;

/**
 * Max concurrent in-flight /files/register requests. Folder uploads register
 * one record per file (or per duplicate); without this cap a duplicate-heavy
 * folder fires hundreds of register POSTs at once and exhausts the browser's
 * connection pool (net::ERR_INSUFFICIENT_RESOURCES), same as check-hash.
 */
export const REGISTER_CONCURRENCY = 8;

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

/**
 * Ceiling memory — remembers the rate that last triggered FLOOD_WAIT so the
 * pacer converges just below the account's sustainable limit instead of
 * re-probing past it every ~40-60s (the classic AIMD sawtooth that guarantees
 * periodic floods). Below 0.8×ceiling it ramps at full speed; between there and
 * the ceiling it creeps; at the ceiling it holds; only after a long clean period
 * does it deliberately probe past it.
 */

/** On FLOOD_WAIT, the learned ceiling is set to at most this fraction of the rate that triggered it. */
export const CHUNK_CEILING_BACKOFF = 0.95;

/** Fraction of the ceiling above which the fast ramp gives way to the slow creep. */
export const CHUNK_CEILING_SLOW_ZONE = 0.8;

/** The learned ceiling is never recorded below this (parts/s) — bounds damage from a transient hiccup. */
export const CHUNK_CEILING_FLOOR = 1.0;

/** Additive increase step (parts/s) inside the slow zone (between 0.8×ceiling and the ceiling). */
export const CHUNK_RATE_SLOW_STEP = 0.1;

/** Minimum time between slow-zone ramp ticks. */
export const CHUNK_RATE_SLOW_INTERVAL_MS = 30_000;

/** Clean time required at the ceiling before a probe past it is attempted. */
export const CHUNK_PROBE_COOLDOWN_MS = 300_000;

/** Failed probes double the cooldown, capped here. */
export const CHUNK_PROBE_COOLDOWN_MAX_MS = 1_800_000;

/** Rate bump (parts/s) applied when probing past the ceiling. */
export const CHUNK_PROBE_STEP = 0.2;

/** Clean time the probe rate must be sustained before the ceiling is raised to it. */
export const CHUNK_PROBE_CONFIRM_MS = 60_000;

/** Number of distinct floods within the escalation window that triggers escalated handling. */
export const CHUNK_FLOOD_ESCALATION_COUNT = 3;

/** Sliding window for counting distinct floods toward escalation. */
export const CHUNK_FLOOD_ESCALATION_WINDOW_MS = 120_000;

/** Harder multiplicative cut applied while escalated (vs the normal 0.5). */
export const CHUNK_ESCALATED_DECREASE_FACTOR = 0.3;

/** While escalated, the ceiling is additionally dropped by this factor. */
export const CHUNK_ESCALATED_CEILING_FACTOR = 0.9;

/** Clean window enforced while escalated (vs the normal 20s). */
export const CHUNK_ESCALATED_CLEAN_WINDOW_MS = 60_000;

/** Flood-free time required to de-escalate back to normal handling. */
export const CHUNK_ESCALATION_RESET_MS = 600_000;