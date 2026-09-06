/**
 * Bounds that gramjs's raw sender does not provide.
 *
 * `MTProtoSender.send()` appends a RequestState to the send queue and returns
 * its promise — nothing more. When the connection breaks, `disconnect()` closes
 * the socket and drops `_pendingState` without rejecting any of it, and
 * `_cleanupExportedSender()` then removes that sender from the pool entirely.
 * The awaiting caller is never told. Since every part send happens inside
 * `uploadSemaphore.withSlot()`, whose `finally` only runs once the body
 * settles, one abandoned promise costs the account a concurrency slot
 * permanently. Enough DC blips and the queue stops moving without ever
 * reporting a failure.
 *
 * So: every part send gets a deadline, and a server-side fault is classified as
 * retryable instead of being thrown at the caller as if the file were bad.
 */

/** Thrown when a part send did not settle inside its deadline. */
export class ChunkSendTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not settle within ${timeoutMs}ms — abandoning the send`);
    this.name = 'ChunkSendTimeoutError';
  }
}

/**
 * Run one part send under a deadline.
 *
 * On timeout the underlying promise is abandoned, not cancelled — MTProto has
 * no cancel. Promise.race stays subscribed to it, so a late rejection is
 * absorbed rather than surfacing as an unhandled rejection; the accompanying
 * test pins that down. Re-sending the same part afterwards is safe:
 * SaveFilePart/SaveBigFilePart are idempotent in (fileId, filePart).
 */
export function sendWithDeadline<T>(
  send: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const inFlight = send();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ChunkSendTimeoutError(label, timeoutMs)), timeoutMs);
  });

  return Promise.race([inFlight, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

function errorCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

function errorText(err: unknown): string {
  const e = err as { errorMessage?: string; message?: string } | null;
  return `${e?.errorMessage ?? ''} ${e?.message ?? ''}`;
}

/**
 * True for faults that are Telegram's problem, not this file's: the DC is
 * briefly unable to serve (`-500 No workers running`, `500 INTERNAL`,
 * `-503 Timeout`), or our own send deadline expired. Re-sending the identical
 * part is the correct response to all of them.
 *
 * FLOOD_WAIT is deliberately excluded — that is a rate signal owned by the
 * chunk pacer, and retrying it here would bypass the backoff. So is anything in
 * the 4xx range, which fails identically however many times it is sent.
 */
export function isTransientServerError(err: unknown): boolean {
  if (err instanceof ChunkSendTimeoutError) return true;
  const code = errorCode(err);
  if (code !== undefined && Math.abs(code) >= 500) return true;
  return /No workers running|Timeout|INTERNAL/i.test(errorText(err));
}
