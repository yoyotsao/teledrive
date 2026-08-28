/**
 * Same-file detection and collision renaming for chat import.
 *
 * Chat import forwards messages instead of downloading them, so an imported
 * file has no file_hash — the content is never in the browser to hash. The
 * only signals available for "have I already got this?" are the Telegram media
 * id and the (name, size, mime) triple Telegram reports, and the only signals
 * for "what do I call this?" are the names already taken in the target folder.
 *
 * Deliberately imports nothing so importNaming.selfcheck.ts can bundle it for
 * node. Scope is one import folder: an index is built from that folder's rows
 * and updated in place as the run registers files, so a name taken mid-run
 * counts exactly like a name that was already in the drive.
 */

export type FolderEntry = {
  /** Telegram media id, decimal string — the drive's file_id. */
  fileId: string;
  filename: string;
  filesize: number;
  mimeType: string | null;
};

export type FolderIndex = {
  ids: Set<string>;
  /** identityKey() of every row — the "same file" test. */
  identities: Set<string>;
  /** normalizeName() of every row — the "name is taken" test. */
  takenNames: Set<string>;
};

export type ImportDecision =
  | { action: 'skip' }
  | { action: 'import'; filename: string };

/**
 * Names are compared case-insensitively: the drive stores metadata, not real
 * files, but `A.JPG` and `a.jpg` collide the moment two rows land in the same
 * download folder on Windows or macOS.
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Drops mime parameters (`; codecs=...`) and case, which vary by sending client. */
function normalizeMime(mime: string | null | undefined): string {
  return (mime || '').split(';')[0].trim().toLowerCase();
}

/**
 * The "same file" key. Null-separated because a filename may contain anything
 * else, and NUL is the one byte sanitizeFilename() strips.
 */
function identityKey(entry: FolderEntry): string {
  return `${normalizeName(entry.filename)}\u0000${entry.filesize}\u0000${normalizeMime(entry.mimeType)}`;
}

/** Matches sanitizeFilename()'s cap in telegramMedia.ts. */
const MAX_FILENAME = 200;
/** Same rule sanitizeFilename() uses: a long tail after the last dot isn't an extension. */
const MAX_EXT = 12;

function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= MAX_EXT) return [name.slice(0, dot), name.slice(dot)];
  return [name, ''];
}

/**
 * `name` if free, else `name (1)`, `name (2)`, … — counter before the
 * extension. The base is trimmed to make room rather than the result being
 * truncated afterwards, so the counter and extension always survive the
 * MAX_FILENAME cap.
 */
export function uniqueName(taken: Set<string>, name: string): string {
  if (!taken.has(normalizeName(name))) return name;
  const [base, ext] = splitExtension(name);
  for (let n = 1; ; n++) {
    const suffix = ` (${n})`;
    const room = MAX_FILENAME - suffix.length - ext.length;
    const trimmed = room > 0 && base.length > room ? base.slice(0, room) : base;
    const candidate = `${trimmed}${suffix}${ext}`;
    if (!taken.has(normalizeName(candidate))) return candidate;
  }
}

export function buildFolderIndex(entries: FolderEntry[]): FolderIndex {
  const index: FolderIndex = { ids: new Set(), identities: new Set(), takenNames: new Set() };
  for (const entry of entries) rememberImported(index, entry);
  return index;
}

/**
 * Record a file as present in the folder. Call it with the values actually
 * written to the drive — the stored media id and the final, possibly renamed
 * filename — so the in-run index matches what a later re-run reads back.
 */
export function rememberImported(index: FolderIndex, entry: FolderEntry): void {
  index.ids.add(entry.fileId);
  index.identities.add(identityKey(entry));
  index.takenNames.add(normalizeName(entry.filename));
}

export function resolveImport(index: FolderIndex, candidate: FolderEntry): ImportDecision {
  if (index.ids.has(candidate.fileId)) return { action: 'skip' };
  if (index.identities.has(identityKey(candidate))) return { action: 'skip' };
  return { action: 'import', filename: uniqueName(index.takenNames, candidate.filename) };
}
