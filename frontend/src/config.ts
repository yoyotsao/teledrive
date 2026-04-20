/**
 * Upload concurrency configuration for TeleDrive.
 * These constants control parallel upload behavior for both file and chunk uploads.
 */

/**
 * Maximum number of concurrent upload operations allowed.
 * This limit applies to both chunk uploads and file uploads in the shared pool.
 *
 * Safe range: 1-10 (recommended: 3-7)
 * - Too low: Slow upload speeds
 * - Too high: May trigger rate limits or memory issues
 */
export const MAX_UPLOAD_CONCURRENCY = 5;

/**
 * Number of retry attempts for failed chunk uploads.
 * Each chunk will be retried up to this many times before failing the entire upload.
 *
 * Safe range: 2-5 (recommended: 3)
 * - Too low: Insufficient resilience against transient failures
 * - Too high: Prolonged upload attempts for permanently failed chunks
 */
export const CHUNK_RETRY_COUNT = 3;