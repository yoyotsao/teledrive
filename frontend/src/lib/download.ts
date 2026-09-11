import { getClientFor, getPrimaryClient, type TelegramClientManager, type DownloadProgress } from './gramjs';
import { api } from '../api/client';
import { Semaphore } from './semaphore';
import { type FileInfo } from '../types';
import { fileInfoToLocation, locationKey } from './storageLocation';
import { resolveFileLocation } from './fileLocationResolver';

/**
 * Legacy Saved Messages reader. Canonical channel-backed locations must never
 * use this selector because telegram_user_id identifies the historical uploader,
 * not the account that should read a shared channel location at runtime.
 */
export function clientForFile(file: Pick<FileInfo, 'telegram_user_id'>): TelegramClientManager {
  return file.telegram_user_id ? getClientFor(file.telegram_user_id) : getPrimaryClient();
}

/** Stable thumbnail cache identity; canonical relocations invalidate old bytes. */
export function thumbnailCacheKey(file: FileInfo): string {
  const location = fileInfoToLocation(file);
  if (location) return `${file.file_id}:thumbnail:${locationKey(location)}`;
  return `${file.file_id}:thumbnail:legacy-saved:${file.telegram_user_id || 0}:${file.telegram_message_id || 0}`;
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

function toBlob(value: unknown, mimeType: string): Blob {
  if (value instanceof Blob) return value.type === mimeType ? value : new Blob([value], { type: mimeType });
  if (value instanceof ArrayBuffer) return new Blob([value], { type: mimeType });
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Blob([bytes.slice().buffer], { type: mimeType });
  }
  throw new Error('Telegram download returned no readable bytes');
}

function asProgressNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof (value as { toString?: () => string }).toString === 'function') {
    const parsed = Number((value as { toString: () => string }).toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Download an embedded Telegram thumbnail through the same canonical resolver
 * as full-file reads. Legacy rows retain original-account Saved Messages
 * compatibility; incomplete channel rows fail closed.
 */
export async function fetchFileThumbnail(file: FileInfo): Promise<Blob | null> {
  if (!file.telegram_message_id) return null;
  const location = fileInfoToLocation(file);
  if (location) {
    const resolved = await resolveFileLocation(location, 'thumbnail');
    if (resolved.locationVersion !== location.location_version) {
      throw new Error(
        `Stale resolved location: expected version ${location.location_version}, got ${resolved.locationVersion}`,
      );
    }
    const thumb = resolved.media.previewThumbSize;
    if (!thumb) return null;
    const data = await resolved.client.downloadMedia(resolved.message, { thumb });
    return toBlob(data, 'image/jpeg');
  }

  if (file.telegram_chat_id != null) {
    throw new Error(`Incomplete canonical Telegram location for file: ${file.file_id}`);
  }
  const blobs = await clientForFile(file).downloadThumbnails([file.telegram_message_id]);
  return blobs.get(file.telegram_message_id) ?? null;
}

/**
 * Read canonical locations through the shared resolver. Rows that predate the
 * additive location schema remain readable through their original Saved
 * Messages account, but an incomplete channel row fails closed rather than
 * silently falling back to @me.
 */
async function downloadFileRow(
  file: FileInfo,
  mimeType: string,
  onProgress?: DownloadProgress,
): Promise<Blob> {
  const location = fileInfoToLocation(file);
  if (location) {
    const resolved = await resolveFileLocation(location, 'download');
    if (resolved.locationVersion !== location.location_version) {
      throw new Error(
        `Stale resolved location: expected version ${location.location_version}, got ${resolved.locationVersion}`,
      );
    }
    const data = await resolved.client.downloadMedia(resolved.message, {
      progressCallback: (received: unknown, total: unknown) => {
        onProgress?.(asProgressNumber(received), asProgressNumber(total) || file.filesize);
      },
    });
    return toBlob(data, mimeType);
  }

  if (file.telegram_chat_id != null) {
    throw new Error(`Incomplete canonical Telegram location for file: ${file.file_id}`);
  }
  if (!file.telegram_message_id) throw new Error('No telegram_message_id for file');
  return clientForFile(file).downloadFile(file.telegram_message_id, mimeType, onProgress);
}

// Fetch a file's full bytes from Telegram (handles split files).
export async function fetchFileBlob(file: FileInfo, onProgress?: DownloadProgress): Promise<Blob> {
  const mimeType = file.mime_type || 'application/octet-stream';
  if (file.is_split_file && file.split_group_id) {
    return downloadSplitMerged(file.split_group_id, mimeType, onProgress);
  }
  const blob = await downloadFileRow(file, mimeType, onProgress);
  return assertWholeFile(blob, file.filesize, file.filename);
}

function partLocationIdentity(part: FileInfo): string | null {
  const location = fileInfoToLocation(part);
  if (location) return locationKey(location);
  if (!part.telegram_message_id) return null;
  return `legacy-saved:${part.telegram_user_id || 0}:${part.telegram_message_id}`;
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

  // A message number is only unique inside its chat. Deduplicate by the full
  // canonical location key (including location_version); legacy Saved Messages
  // rows include their original account so same-numbered messages stay distinct.
  const seen = new Set<string>();
  const uniqueParts = sorted.filter((part) => {
    const key = partLocationIdentity(part);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueParts.length !== sorted.length) {
    console.warn('[DownloadMerge] Dropped', sorted.length - uniqueParts.length, 'duplicate-location parts');
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
      const blob = await downloadFileRow(part, mimeType, reportPart(i));
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
