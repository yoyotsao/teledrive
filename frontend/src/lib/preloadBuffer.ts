/**
 * The Service Worker's rolling lookahead for video playback.
 *
 * The media element asks for one byte range at a time and waits for it, so the
 * only parallelism playback ever gets is this buffer running ahead of the play
 * head. That makes one property load-bearing: an offset must be requested at
 * most ONCE. The buffer this replaced stored `{ data, inProgress }` and
 * answered a still-downloading offset with null, so the player's request for
 * that offset fired a second upload.GetFile for bytes already in flight.
 *
 * The duplication only kicked in once the lookahead had fallen behind — that
 * is, only when the connection was ALREADY too slow — and then doubled the
 * load: every chunk the player actually waited for was fetched twice, the
 * lookahead never caught up, and playback stuttered for the rest of the video.
 * Holding the promise instead of the bytes is what makes "already on its way"
 * a hit rather than a miss.
 *
 * Deliberately imports nothing: it is unit-tested under node, and the Service
 * Worker supplies the actual chunk fetcher.
 */

export type ChunkFetcher = (offset: number, limit: number) => Promise<ArrayBuffer>;

export class PreloadBuffer {
  /** offset → the one request for it, finished or still in flight. */
  private readonly inflight = new Map<number, Promise<ArrayBuffer>>();

  /**
   * @param lookahead how many chunks past the play head to keep on their way
   * @param fetchChunk issues one real chunk request
   */
  constructor(
    private readonly lookahead: number,
    private readonly fetchChunk: ChunkFetcher,
  ) {}

  /** Offsets currently held (in flight or finished). */
  get size(): number {
    return this.inflight.size;
  }

  /**
   * The bytes at `offset` — joining the preload already running for it when
   * there is one, and only issuing a request when there is not.
   *
   * The entry is consumed either way: the play head has passed it, so nothing
   * will ask for it again and holding the bytes would just grow the buffer.
   */
  async take(offset: number, limit: number): Promise<ArrayBuffer> {
    const running = this.inflight.get(offset);
    if (running) {
      try {
        return await running;
      } catch {
        // A failed preload must not poison the offset — fall through and ask
        // again, since this is the request the player is actually waiting on.
      } finally {
        this.forget(offset, running);
      }
    }
    const fresh = this.request(offset, limit);
    try {
      return await fresh;
    } finally {
      this.forget(offset, fresh);
    }
  }

  /**
   * Put the next `lookahead` chunks after `offset` on their way, and drop
   * whatever the play head has moved past — without the eviction a long video
   * would accumulate every chunk it ever played.
   */
  schedule(offset: number, chunkSize: number, fileSize: number): void {
    const windowEnd = offset + (this.lookahead + 1) * chunkSize;
    for (const held of this.inflight.keys()) {
      if (held < offset || held > windowEnd) this.inflight.delete(held);
    }

    for (let i = 1; i <= this.lookahead; i++) {
      const next = offset + i * chunkSize;
      if (next >= fileSize) break;
      this.request(next, chunkSize);
    }
  }

  /** Forget everything — a different video, or the page told us to clean up. */
  clear(): void {
    this.inflight.clear();
  }

  /**
   * The single request for `offset`: the one already running, or a new one.
   *
   * Its rejection is marked as observed here because a preload nobody ends up
   * taking (the user seeks away) would otherwise be a rejected promise with no
   * handler, which a Service Worker reports as an unhandled rejection. That
   * catch does not change what the promise settles to, so `take()` re-awaiting
   * it still sees the failure and can retry.
   */
  private request(offset: number, limit: number): Promise<ArrayBuffer> {
    const existing = this.inflight.get(offset);
    if (existing) return existing;

    const started = this.fetchChunk(offset, limit);
    this.inflight.set(offset, started);
    started.catch(() => this.forget(offset, started));
    return started;
  }

  /** Drop `offset`, but only if it still holds the request we are done with. */
  private forget(offset: number, request: Promise<ArrayBuffer>): void {
    if (this.inflight.get(offset) === request) this.inflight.delete(offset);
  }
}
