import { api } from '../api/client';
import { loadJwt } from './gramjs';
import { UploadStatistics } from './uploadStatistics';

let statistics: UploadStatistics | null = null;
let recordingError = '';

function ownerId(): number | null {
  try {
    const token = loadJwt();
    if (!token) return null;
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const owner = Number(JSON.parse(atob(payload)).user_id);
    return Number.isSafeInteger(owner) && owner > 0 ? owner : null;
  } catch { return null; }
}

function collector(): UploadStatistics {
  return statistics ??= new UploadStatistics(localStorage, crypto.randomUUID());
}

/** A telemetry/storage error must never retry an already successful upload. */
export function recordUploadedBytes(account: number, bytes: number): void {
  try {
    const owner = ownerId();
    if (!owner) return;
    collector().record(owner, account, bytes);
  } catch (error) {
    recordingError = '瀏覽器無法保存部分上傳統計，數字可能不完整。';
    console.warn('[UploadStatistics] Could not persist upload count:', error);
  }
}

/** Flush all reports, or only those belonging to one account before unlinking it. */
export async function flushUploadStatistics(account?: number): Promise<void> {
  const owner = ownerId();
  if (!owner) return;
  await collector().flush(owner, async row => {
    // Do not submit another drive's buffered records after a sign-out/sign-in.
    if (ownerId() !== owner) throw new Error('登入帳號已變更');
    return api.reportUploadStatistics(row);
  }, account);
  if (recordingError) throw new Error(recordingError);
}

export function startUploadStatisticsSync(): () => void {
  const sync = () => { void flushUploadStatistics().catch(error => {
    console.warn('[UploadStatistics] Sync pending:', error);
  }); };
  sync();
  const timer = window.setInterval(sync, 10_000);
  window.addEventListener('online', sync);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('online', sync);
  };
}
