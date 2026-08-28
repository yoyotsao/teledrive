/**
 * Whether the app should still serve video chunk requests from the Service
 * Worker.
 *
 * The Service Worker keeps preloading ahead of the playhead, so chunk requests
 * for a video the user just closed keep arriving for a while; serving them
 * wastes Telegram round trips on bytes nobody will watch. Closing the preview
 * therefore shuts the gate, and opening one reopens it.
 *
 * The state is driven ONLY by those two events, and `accepts()` is a pure
 * question. Both properties matter: the flag this replaces was reset as a side
 * effect of a chunk request being allowed through, which made closing a video
 * latch the gate shut forever — the reset lived behind the very check it had to
 * clear, so the next video's first chunk was rejected, the Service Worker
 * retried three times and answered 503 for every video until a page reload.
 */
export class StreamGate {
  private stopped = false;

  /** A video preview opened — chunk requests are welcome again. */
  opened(): void {
    this.stopped = false;
  }

  /** The video preview closed — drop preload chunks still on their way. */
  closed(): void {
    this.stopped = true;
  }

  /** May a chunk request be served? Never changes the gate's state. */
  accepts(): boolean {
    return !this.stopped;
  }
}
