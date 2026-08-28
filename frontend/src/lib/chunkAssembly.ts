/**
 * The chunks of one file being downloaded from Telegram, and the single
 * question that matters about them: is the whole file here?
 *
 * Chunks are requested in parallel and land out of order, so completeness
 * cannot be judged from how many have arrived. Two conditions must both hold
 * before the bytes may be used: every slot is filled, and the bytes add up to
 * the size Telegram declared for the document. The second condition is what
 * turns a silent truncation into a loud failure — `parts()` throws rather than
 * hand back a short file that would be saved to disk looking complete.
 *
 * Each chunk is wrapped in a Blob the moment it arrives, which hands it to the
 * browser's blob storage (free to spill to disk) instead of pinning the whole
 * file in the JS heap. A multi-GB download would otherwise run the tab out of
 * memory long before the last chunk.
 */
export class ChunkAssembly {
  private readonly slots: (Blob | undefined)[];
  private bytes = 0;

  /**
   * @param totalChunks how many chunk requests cover the file
   * @param fileSize the document size Telegram reported; the assembled bytes
   *   must match it exactly (the final chunk is short — Telegram returns only
   *   the bytes that exist up to EOF).
   */
  constructor(private readonly totalChunks: number, private readonly fileSize: number) {
    this.slots = new Array(totalChunks);
  }

  /** Record one chunk's bytes. Re-delivering a chunk replaces it, not adds to it. */
  put(index: number, bytes: Uint8Array): void {
    const previous = this.slots[index];
    if (previous) this.bytes -= previous.size;
    const held = new Blob([bytes as BlobPart]);
    this.slots[index] = held;
    this.bytes += held.size;
  }

  /** Bytes held so far — for progress reporting only, never for completeness. */
  get receivedBytes(): number {
    return this.bytes;
  }

  /** Chunk indexes still outstanding, for error messages worth reading. */
  missing(): number[] {
    const gaps: number[] = [];
    for (let i = 0; i < this.totalChunks; i++) if (!this.slots[i]) gaps.push(i);
    return gaps;
  }

  /** Every chunk present AND the byte total matching the declared file size. */
  isComplete(): boolean {
    return this.missing().length === 0 && this.bytes === this.fileSize;
  }

  /**
   * The chunks in file order, ready to concatenate.
   * @throws if the file is not complete — a partial download must never reach
   *   a Blob that something else will treat as the finished file.
   */
  parts(): Blob[] {
    if (!this.isComplete()) {
      const gaps = this.missing();
      throw new Error(
        `Incomplete download: ${this.bytes}/${this.fileSize} bytes, ` +
        `${gaps.length} of ${this.totalChunks} chunks missing` +
        (gaps.length ? ` (first missing chunk: ${gaps[0]})` : ''),
      );
    }
    return this.slots as Blob[];
  }
}
