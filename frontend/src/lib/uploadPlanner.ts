import { sha256File } from './hashFile';
import { api } from '../api/client';
import { Semaphore } from './semaphore';
import { HASH_CONCURRENCY, HASH_CHECK_CONCURRENCY, REGISTER_CONCURRENCY } from '../config';
import { FileInfo } from '../types';

// Bounds concurrent 100MB-sample reads during the hash pre-pass, independent of
// the Telegram upload concurrency pool (fileSemaphore/uploadSemaphore).
const hashSemaphore = new Semaphore(HASH_CONCURRENCY);

// Bounds concurrent /files/check-hash GETs so streaming folder uploads (which
// fan out unbounded) don't exhaust the browser's connection pool.
const hashCheckSemaphore = new Semaphore(HASH_CHECK_CONCURRENCY);

// Bounds concurrent /files/register POSTs for the same reason — a duplicate-heavy
// folder would otherwise fire one register per file all at once.
const registerSemaphore = new Semaphore(REGISTER_CONCURRENCY);

/** POST /files/register with a bounded number of in-flight requests. */
export function registerFileBounded(
  params: Parameters<typeof api.registerFile>[0],
): Promise<FileInfo> {
  return registerSemaphore.withSlot(() => api.registerFile(params));
}

/** Compute a file's dedup hash without blocking on upload concurrency slots. */
export async function hashFileBounded(file: File): Promise<string | null> {
  return hashSemaphore.withSlot(() => sha256File(file).catch(() => null));
}

/** Query the backend dedup index with a bounded number of in-flight requests. */
export async function checkFileHashBounded(
  hash: string,
): Promise<{ found: boolean; files: FileInfo[] }> {
  return hashCheckSemaphore.withSlot(() =>
    api.checkFileHash(hash).catch(() => ({ found: false, files: [] as FileInfo[] })),
  );
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
  /** Canonical parts covering the whole file — register these, not `existing`. */
  parts: RegisterableExistingPart[];
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
        // Only a stored copy covering the whole file can stand in for an
        // upload — a truncated one would be cloned, not repaired. Anything
        // short falls through to the fresh path and uploads for real.
        const parts = canonicalExistingParts(existing, file.size);
        if (parts.length > 0) {
          duplicates.push({ file, hash, existing, parts });
          return;
        }
        console.warn('[Upload] Hash matched but stored copy is incomplete, re-uploading:', file.name);
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
  /** Account storing the message. A dedup row MUST inherit it — access_hash is
   *  only valid against that account, so defaulting to the primary breaks the
   *  download of anything uploaded via a secondary one. */
  telegram_user_id?: number;
}

/**
 * Collapse the raw set of same-hash DB rows returned by /check-hash down to the
 * canonical parts of a SINGLE upload — one representative row per part_index —
 * or return nothing if no complete copy of the file exists yet.
 *
 * Why the collapse: /check-hash returns EVERY row sharing the hash, including
 * rows created by prior dedup registrations. Registering one new row per
 * returned row makes the record count for a hash double on every re-upload
 * (N existing → N new → 2N), producing split groups with thousands of bogus
 * "parts" that never finish downloading. Collapsing to the real part set keeps
 * a duplicate registration at exactly `total_parts` rows, no matter how badly
 * the existing rows have been multiplied.
 *
 * Why the size gate: matching hashes only prove the *source* files were
 * identical, never that the stored copy is whole. An upload that died partway
 * leaves rows covering a fraction of the file, and reusing them registers a new
 * record that is equally truncated — while uploading nothing, so the loss is
 * silent and self-propagating. 38 multi-GB files in the live DB were the third
 * generation of one such stub. Parts are reusable only when their bytes add up
 * to `originalSize`; otherwise the caller must upload the file for real.
 */
export function canonicalExistingParts(
  files: FileInfo[],
  /** Size of the local file being registered — `file.size`. */
  originalSize: number,
): RegisterableExistingPart[] {
  if (files.length === 0) return [];

  const toPart = (f: FileInfo, index: number): RegisterableExistingPart => ({
    filesize: f.filesize,
    mime_type: f.mime_type,
    telegram_message_id: f.telegram_message_id!,
    access_hash: f.access_hash,
    part_index: index,
    has_thumbnail: f.has_thumbnail,
    telegram_user_id: f.telegram_user_id,
  });
  const covers = (parts: RegisterableExistingPart[]): boolean =>
    parts.reduce((n, p) => n + p.filesize, 0) === originalSize;

  // A non-split origin means the file is a single Telegram message — exactly one
  // part, regardless of how many duplicate rows the hash has accumulated. Any
  // candidate whose single message is short of the file is a stub, so keep
  // looking rather than trusting the is_split_file flag alone.
  for (const f of files) {
    if (f.is_split_file || f.telegram_message_id == null) continue;
    const parts = [toPart(f, 0)];
    if (covers(parts)) return parts;
  }

  // Genuinely multi-part: pick the most complete existing split group (most
  // distinct part_index values), then take one representative row per index.
  const groups = new Map<string, FileInfo[]>();
  for (const f of files) {
    const key = f.split_group_id ?? f.file_id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }
  const collapse = (group: FileInfo[]): RegisterableExistingPart[] => {
    const byIndex = new Map<number, FileInfo>();
    for (const f of group) {
      const idx = f.part_index ?? 0;
      if (f.telegram_message_id != null && !byIndex.has(idx)) byIndex.set(idx, f);
    }
    return [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, f]) => toPart(f, idx));
  };

  // Most complete first: a group that survives the size gate is the answer, and
  // trying the rest guards against one truncated group masking an intact one.
  const candidates = [...groups.values()]
    .map(collapse)
    .sort((a, b) => b.length - a.length);
  return candidates.find(covers) ?? [];
}

/**
 * Refuse to register parts that don't account for every byte of the file.
 *
 * The dedup index is keyed by content hash, so one truncated record poisons
 * every later upload of the same file: the next upload matches the hash, reuses
 * the short part set, and registers another truncated record. Failing loudly at
 * registration keeps a half-finished upload from ever entering the index —
 * an errored row is recoverable, a plausible-looking short one is not.
 */
export function assertPartsCoverFile(file: File, parts: Array<{ size: number }>): void {
  const covered = parts.reduce((n, p) => n + p.size, 0);
  if (covered !== file.size) {
    throw new Error(
      `${file.name}: uploaded parts cover ${covered} of ${file.size} bytes`
      + ' — refusing to register an incomplete file',
    );
  }
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
    registerFileBounded({
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
      telegramUserId: part.telegram_user_id,
    })
  ));
}
