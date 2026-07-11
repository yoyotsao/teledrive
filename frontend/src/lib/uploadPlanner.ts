import { sha256File } from './hashFile';
import { api } from '../api/client';
import { Semaphore } from './semaphore';
import { HASH_CONCURRENCY } from '../config';
import { FileInfo } from '../types';

// Bounds concurrent 100MB-sample reads during the hash pre-pass, independent of
// the Telegram upload concurrency pool (fileSemaphore/uploadSemaphore).
const hashSemaphore = new Semaphore(HASH_CONCURRENCY);

/** Compute a file's dedup hash without blocking on upload concurrency slots. */
export async function hashFileBounded(file: File): Promise<string | null> {
  return hashSemaphore.withSlot(() => sha256File(file).catch(() => null));
}

export interface PlannedFile {
  file: File;
  hash: string | null;
  /** Other files in the same selection sharing this hash — registered as
   * duplicates once `file` finishes its real upload, instead of re-uploading. */
  dependents: File[];
}

export interface DuplicatePlan {
  file: File;
  hash: string;
  existing: FileInfo[];
}

export interface UploadPlan {
  duplicates: DuplicatePlan[];
  fresh: PlannedFile[];
}

/**
 * Hash every file (bounded concurrency) and batch-check against the backend
 * BEFORE any upload-concurrency slot is taken, so duplicates never occupy a
 * slot that a real upload needs. Files sharing a hash within the same
 * selection are deduped against each other too (see `dependents`).
 */
export async function planUploads(files: File[]): Promise<UploadPlan> {
  const hashes = await Promise.all(files.map((file) => hashFileBounded(file)));

  const uniqueHashes = Array.from(new Set(hashes.filter((h): h is string => h !== null)));
  const checkResults = uniqueHashes.length > 0
    ? await api.checkFileHashes(uniqueHashes).catch(() => ({} as Record<string, FileInfo[]>))
    : {};

  const duplicates: DuplicatePlan[] = [];
  const fresh: PlannedFile[] = [];
  const representativeByHash = new Map<string, PlannedFile>();

  files.forEach((file, i) => {
    const hash = hashes[i];
    if (hash) {
      const existing = checkResults[hash];
      if (existing && existing.length > 0) {
        duplicates.push({ file, hash, existing });
        return;
      }
      const rep = representativeByHash.get(hash);
      if (rep) {
        rep.dependents.push(file);
        return;
      }
      const planned: PlannedFile = { file, hash, dependents: [] };
      representativeByHash.set(hash, planned);
      fresh.push(planned);
      return;
    }
    fresh.push({ file, hash: null, dependents: [] });
  });

  return { duplicates, fresh };
}

export interface RegisterableExistingPart {
  filesize: number;
  mime_type?: string | null;
  telegram_message_id: number;
  access_hash?: string | null;
  part_index?: number | null;
  has_thumbnail?: boolean;
}

/**
 * Register a file as pointing to already-uploaded Telegram message(s) — either
 * pre-existing DB records or parts freshly uploaded by another file in the same
 * selection — without uploading anything to Telegram.
 */
export async function registerDuplicateParts(
  file: File,
  hash: string | null,
  parts: RegisterableExistingPart[],
  parentId: string | null,
): Promise<void> {
  if (parts.length === 0) return;
  const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  await Promise.all(parts.map((part, i) =>
    api.registerFile({
      filename: file.name,
      filesize: part.filesize,
      mimeType: part.mime_type ?? file.type ?? undefined,
      messageId: part.telegram_message_id,
      fileId: `${splitGroupId}-${i}`,
      accessHash: part.access_hash ?? undefined,
      parentId: parentId ?? undefined,
      hasThumbnail: (part.part_index ?? i) === 0 ? (part.has_thumbnail ?? false) : false,
      // Only genuinely multi-part duplicates are "split files" — a single-part
      // match must report false so the backend's same-name+parent replace
      // logic can fire (e.g. re-dropping the same file into the same folder).
      isSplitFile: parts.length > 1,
      splitGroupId,
      partIndex: part.part_index ?? i,
      totalParts: parts.length,
      originalName: file.name,
      fileHash: hash ?? undefined,
    })
  ));
}
