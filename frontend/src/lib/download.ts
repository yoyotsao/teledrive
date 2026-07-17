import { getTelegramClient } from './gramjs';
import { FileInfo } from '../types';

// Fetch a file's full bytes from Telegram (handles split files).
export async function fetchFileBlob(file: FileInfo): Promise<Blob> {
  const telegramClient = getTelegramClient();
  const mimeType = file.mime_type || 'application/octet-stream';
  if (file.is_split_file && file.split_group_id) {
    return telegramClient.downloadFileMerge(file.split_group_id, mimeType);
  }
  if (!file.telegram_message_id) throw new Error('No telegram_message_id for file');
  return telegramClient.downloadFile(file.telegram_message_id, mimeType);
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
