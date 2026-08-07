import { getClientFor, getPrimaryClient, TelegramClientManager } from './gramjs';
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

// Fetch a file's full bytes from Telegram (handles split files).
export async function fetchFileBlob(file: FileInfo): Promise<Blob> {
  const mimeType = file.mime_type || 'application/octet-stream';
  if (file.is_split_file && file.split_group_id) {
    return downloadSplitMerged(file.split_group_id, mimeType);
  }
  if (!file.telegram_message_id) throw new Error('No telegram_message_id for file');
  return clientForFile(file).downloadFile(file.telegram_message_id, mimeType);
}

/**
 * Download every part of a split file and concatenate them.
 *
 * Parts are ordered by part_index — which the upload path derives from the
 * segment index, NOT from message ids. Message ids only increase within one
 * account, and parts of a single file are deliberately spread over several,
 * so any id-based ordering here would corrupt the merged file.
 */
export async function downloadSplitMerged(splitGroupId: string, mimeType: string): Promise<Blob> {
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

  const partSemaphore = new Semaphore(3);
  const blobs = await Promise.all(
    uniqueParts.map((part, i) => partSemaphore.withSlot(async () => {
      const messageId = part.telegram_message_id;
      if (!messageId) throw new Error(`Missing telegram_message_id for part: ${part.file_id}`);
      // Each part carries its own storage account.
      const blob = await clientForFile(part).downloadFile(messageId, mimeType);
      console.log('[DownloadMerge] Part', i, 'downloaded, size:', blob.size);
      return blob;
    }))
  );

  return new Blob(blobs, { type: mimeType });
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
  URL.revokeObjectURL(url);
}
