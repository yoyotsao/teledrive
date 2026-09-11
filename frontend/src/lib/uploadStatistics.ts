/** Durable, cumulative metadata reports. Each tab owns a distinct stream. */
export type UploadReport = { stream_id: string; telegram_user_id: number; day: string; bytes: number };
/** The upload-statistics API confirmed this row cannot ever be accepted. */
export const RETIRE_PENDING_UPLOAD_STATISTIC = 'retire-pending-upload-statistic' as const;
export type UploadReportSendResult = void | typeof RETIRE_PENDING_UPLOAD_STATISTIC;
type Pending = UploadReport & { owner: number };
const PREFIX = 'td-upload-statistics-v1:';

export function taipeiDay(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export class UploadStatistics {
  private totals = new Map<string, number>();
  /** The latest pass; target passes wait here before taking their fresh snapshot. */
  private flushTail: Promise<void> | null = null;
  /** Concurrent periodic callers still share one all-account pass. */
  private allFlushing: Promise<void> | null = null;

  constructor(private storage: Storage, private stream: string) {}

  record(owner: number, account: number, bytes: number, now = new Date()): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    const day = taipeiDay(now);
    const key = `${PREFIX}${owner}:${this.stream}:${account}:${day}`;
    const total = (this.totals.get(key) ?? 0) + bytes;
    this.totals.set(key, total);
    const row: Pending = { owner, stream_id: this.stream, telegram_user_id: account, day, bytes: total };
    this.storage.setItem(key, JSON.stringify(row));
  }

  flush(owner: number, send: (row: UploadReport) => Promise<UploadReportSendResult>, account?: number): Promise<void> {
    if (account == null) return this.flushAll(owner, send);
    return this.flushAccount(owner, send, account);
  }

  private flushAll(owner: number, send: (row: UploadReport) => Promise<UploadReportSendResult>): Promise<void> {
    if (this.allFlushing) return this.allFlushing;
    const pass = this.runAfter(this.flushTail, owner, send);
    this.flushTail = pass;
    this.allFlushing = pass;
    this.releaseWhenSettled(pass, true);
    return pass;
  }

  private flushAccount(
    owner: number,
    send: (row: UploadReport) => Promise<UploadReportSendResult>,
    account: number,
  ): Promise<void> {
    // A target unlink flush must not inherit a previous pass's unrelated
    // error, and must snapshot storage only after that pass has settled.
    const pass = this.runAfter(this.flushTail, owner, send, account);
    this.flushTail = pass;
    this.releaseWhenSettled(pass, false);
    return pass;
  }

  private async runAfter(
    previous: Promise<void> | null,
    owner: number,
    send: (row: UploadReport) => Promise<UploadReportSendResult>,
    account?: number,
  ): Promise<void> {
    if (previous) {
      try { await previous; } catch { /* The new pass owns its own outcome. */ }
    }
    await this.sendPending(owner, send, account);
  }

  private releaseWhenSettled(pass: Promise<void>, all: boolean): void {
    void pass.then(
      () => this.release(pass, all),
      () => this.release(pass, all),
    );
  }

  private release(pass: Promise<void>, all: boolean): void {
    if (this.flushTail === pass) this.flushTail = null;
    if (all && this.allFlushing === pass) this.allFlushing = null;
  }

  private async sendPending(
    owner: number,
    send: (row: UploadReport) => Promise<UploadReportSendResult>,
    account?: number,
  ): Promise<void> {
    const keys = Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i))
      .filter((key): key is string => !!key && key.startsWith(`${PREFIX}${owner}:`));
    let firstError: unknown;
    for (const key of keys) {
      try {
        const snapshot = this.storage.getItem(key);
        if (!snapshot) continue;
        const { owner: savedOwner, ...row } = JSON.parse(snapshot) as Pending;
        if (savedOwner !== owner) continue;
        if (account != null && row.telegram_user_id !== account) continue;
        await send(row);
        // Another success (or another tab flushing an old stream) may have
        // arrived during the request. Never discard a newer cumulative value.
        if (this.storage.getItem(key) === snapshot) this.storage.removeItem(key);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }
}
