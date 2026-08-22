/**
 * Serialising, newest-first queue for per-page thumbnail batches.
 *
 * Thumbnails are fetched one page at a time. Before this queue each loaded page
 * started its own download fan-out immediately, so a fast scroll (which appends
 * a page every time the infinite-scroll sentinel is hit) stacked dozens of
 * concurrent upload.GetFile calls onto the same MTProto connection until it
 * dropped with "Error: Not connected" and reconnect-looped — thumbnails then
 * stopped arriving for the rest of the session.
 *
 * Two properties keep that from happening:
 *  - `maxConcurrent` batches run at once (1 by default), so the load on the
 *    connection stays at exactly one page's worth no matter how fast the user
 *    scrolls; the backlog just takes longer instead of killing the connection.
 *  - waiting batches are taken LIFO. A fling queues pages 2..N in order, but the
 *    page worth decoding is the LAST one — that's where the viewport ended up.
 *
 * A batch whose AbortSignal fired while it waited (folder changed, search
 * cleared) is dropped without running. Batches never reject: the caller gets
 * 'done' | 'dropped' | 'failed' so it can release its own pending-id bookkeeping.
 */

export type ThumbBatchOutcome = 'done' | 'dropped' | 'failed';

interface QueuedBatch {
  run: () => Promise<void>;
  signal?: AbortSignal;
  settle: (outcome: ThumbBatchOutcome) => void;
}

export class ThumbBatchQueue {
  private readonly waiting: QueuedBatch[] = [];
  private running = 0;

  constructor(private readonly maxConcurrent: number = 1) {}

  /** Queue one page's worth of thumbnail work. Resolves once it ran (or didn't). */
  enqueue(run: () => Promise<void>, signal?: AbortSignal): Promise<ThumbBatchOutcome> {
    return new Promise<ThumbBatchOutcome>((resolve) => {
      this.waiting.push({ run, signal, settle: resolve });
      this.pump();
    });
  }

  /** Batches waiting for a slot right now (running ones excluded). */
  get pending(): number {
    return this.waiting.length;
  }

  private pump(): void {
    while (this.running < this.maxConcurrent) {
      const next = this.waiting.pop(); // LIFO: newest page first
      if (!next) return;
      if (next.signal?.aborted) {
        next.settle('dropped');
        continue;
      }
      this.running++;
      next.run().then(
        () => next.settle('done'),
        (err) => {
          console.warn('[Thumb] Batch rejected:', (err as Error | null)?.message ?? err);
          next.settle('failed');
        },
      ).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
}
