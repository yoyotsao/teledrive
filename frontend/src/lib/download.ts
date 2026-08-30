import { getClientFor, getPrimaryClient, TelegramClientManager, DownloadProgress } from './gramjs';
import { api } from '../api/client';
import { Semaphore } from './semaphore';
import { FileInfo } from '../types';

/**
 * The client that can actually read this file.
 *
 * access_hash is issued per (account, document): another account's client
 * either fails outright or — worse — resolves a same-numbered message in ITS
 * own Saved Messages and silently returns the wrong bytes. Files registered
 * before multi-account have telegram_user_id 0, which means "the primary".
 */
export function clientForFile(file: Pick<FileInfo, 'telegram_user_id'>): TelegramClientManager {
  return file.telegram_user_id ? getClientFor(file.telegram_user_id) : getPrimaryClient();
}

/**
 * Fail rather than hand back a blob that is not the whole file.
 *
 * The download path already refuses to assemble an incomplete set of chunks
 * against the size Telegram declares for the document. This second check is
 * against the size WE recorded at upload time, so a file whose Telegram
 * document is itself short — a truncated upload — is caught here instead of
 * being saved to disk as a plausible-looking file.
 */
function assertWholeFile(blob: Blob, expected: number, what: string): Blob {
  if (expected > 0 && blob.size !== expected) {
    throw new Error(`Incomplete download for ${what}: got ${blob.size} of ${expected} bytes`);
  }
  return blob;
}

// Fetch a file's full bytes from Telegram (handles split files).
export async function fetchFileBlob(file: FileInfo, onProgress?: DownloadProgress): Promise<Blob> {
  const mimeType = file.mime_type || 'application/octet-stream';
  if (file.is_split_file && file.split_group_id) {
    return downloadSplitMerged(file.split_group_id, mimeType, onProgress);
  }
  if (!file.telegram_message_id) throw new Error('No telegram_message_id for file');
  const blob = await clientForFile(file).downloadFile(file.telegram_message_id, mimeType, onProgress);
  return assertWholeFile(blob, file.filesize, file.filename);
}

/**
 * Download every part of a split file and concatenate them.
 *
 * Parts are ordered by part_index — which the upload path derives from the
 * segment index, NOT from message ids. Message ids only increase within one
 * account, and parts of a single file are deliberately spread over several,
 * so any id-based ordering here would corrupt the merged file.
 */
export async function downloadSplitMerged(
  splitGroupId: string,
  mimeType: string,
  onProgress?: DownloadProgress,
): Promise<Blob> {
  const { files } = await api.getSplitGroupFiles(splitGroupId);
  if (!files || files.length === 0) {
    throw new Error('No files found for split group: ' + splitGroupId);
  }

  const sorted = [...files].sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0));

  // Safety net: a genuine split never reuses a Telegram message across parts,
  // so collapse any duplicate telegram_message_id down to a single part. This
  // stops a corrupt split group (e.g. one accidentally registered with the
  // same message thousands of times) from downloading forever.
  const seen = new Set<number>();
  const uniqueParts = sorted.filter((p) => {
    const id = p.telegram_message_id;
    if (id == null || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (uniqueParts.length !== sorted.length) {
    console.warn('[DownloadMerge] Dropped', sorted.length - uniqueParts.length, 'duplicate-message parts');
  }

  // Parts download concurrently, so progress has to be summed across them
  // rather than reported per part — otherwise the number would jump backwards.
  const expectedTotal = uniqueParts.reduce((n, p) => n + (p.filesize || 0), 0);
  const receivedPerPart = new Array<number>(uniqueParts.length).fill(0);
  const reportPart = (index: number) => (received: number) => {
    receivedPerPart[index] = received;
    onProgress?.(receivedPerPart.reduce((a, b) => a + b, 0), expectedTotal);
  };

  const partSemaphore = new Semaphore(3);
  const blobs = await Promise.all(
    uniqueParts.map((part, i) => partSemaphore.withSlot(async () => {
      const messageId = part.telegram_message_id;
      if (!messageId) throw new Error(`Missing telegram_message_id for part: ${part.file_id}`);
      // Each part carries its own storage account.
      const blob = await clientForFile(part).downloadFile(messageId, mimeType, reportPart(i));
      console.log('[DownloadMerge] Part', i, 'downloaded, size:', blob.size);
      // A short part would merge into a corrupt file that still opens.
      return assertWholeFile(blob, part.filesize, `part ${i} of ${splitGroupId}`);
    }))
  );

  const merged = new Blob(blobs, { type: mimeType });
  return assertWholeFile(merged, expectedTotal, `split group ${splitGroupId}`);
}

// Download a file's bytes from Telegram and trigger a browser save.
export async function downloadFileToDisk(file: FileInfo): Promise<void> {
  const blob = await fetchFileBlob(file);
  saveBlob(blob, file.original_name || file.filename);
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // a.click() only STARTS the download; the browser reads the blob URL after
  // this task ends. Revoking it synchronously races that read, and the bigger
  // the file the more likely the race is lost — the download then fails or
  // lands truncated. Let the current task finish first.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
