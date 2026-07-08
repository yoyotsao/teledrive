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