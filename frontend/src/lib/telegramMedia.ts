/**
 * Pure media-shape helpers, shared by the download paths in gramjs.ts and by
 * chat import. Deliberately imports nothing — not even `telegram` — so it can
 * be bundled and run under node by telegramMedia.selfcheck.ts. Everything is
 * duck-typed because gramjs hands the download paths `any`.
 */

export type MediaRef = {
  kind: 'document' | 'photo';
  /** Decimal string form of the media id — this is the drive's file_id and the import dedupe key. */
  id: string;
  /** Passed straight back into Api.Input*FileLocation; a bigint in production. */
  rawId: unknown;
  accessHash: unknown;
  fileReference?: Uint8Array;
  size: number;
  mimeType: string;
  /** thumbSize for fetching the FULL media: '' for documents, the largest PhotoSize type for photos. */
  fullThumbSize: string;
  /** thumbSize for fetching a preview, or null when there is nothing usable. */
  previewThumbSize: string | null;
};

/**
 * Byte count of one PhotoSize variant, or null when it carries no separate
 * file (stripped/cached sizes hold inline `bytes` that aren't a standalone
 * JPEG). PhotoSizeProgressive has no `size` — its byte count is the last
 * entry of `sizes[]`.
 */
export function photoSizeBytes(size: any): number | null {
  if (!size || size.bytes) return null;
  if (typeof size.size === 'number') return size.size;
  if (Array.isArray(size.sizes) && size.sizes.length > 0) {
    return Number(size.sizes[size.sizes.length - 1]);
  }
  return null;
}

/** Real (separately downloadable) sizes, ascending by byte count. */
function realSizesAscending(sizes: any[] | undefined): { type: string; bytes: number }[] {
  return (sizes ?? [])
    .map((s) => ({ type: s?.type, bytes: photoSizeBytes(s) }))
    .filter((s): s is { type: string; bytes: number } =>
      typeof s.type === 'string' && s.bytes !== null)
    .sort((a, b) => a.bytes - b.bytes);
}

export function readMedia(media: unknown): MediaRef | null {
  const m = media as any;
  if (!m) return null;

  if (m.className === 'MessageMediaDocument') {
    const doc = m.document;
    if (!doc) return null;
    const thumbs = realSizesAscending(doc.thumbs);
    return {
      kind: 'document',
      id: String(doc.id),
      rawId: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      size: Number(doc.size ?? 0),
      mimeType: doc.mimeType || 'application/octet-stream',
      fullThumbSize: '',
      previewThumbSize: thumbs.length ? thumbs[thumbs.length - 1].type : null,
    };
  }

  if (m.className === 'MessageMediaPhoto') {
    const photo = m.photo;
    if (!photo) return null;
    const sizes = realSizesAscending(photo.sizes);
    if (!sizes.length) return null;
    const largest = sizes[sizes.length - 1];
    return {
      kind: 'photo',
      id: String(photo.id),
      rawId: photo.id,
      accessHash: photo.accessHash,
      fileReference: photo.fileReference,
      size: largest.bytes,
      mimeType: 'image/jpeg',
      // A photo has no "whole file" — you download one of its sizes. The
      // largest size IS the file as far as the drive is concerned.
      fullThumbSize: largest.type,
      previewThumbSize: sizes[0].type,
    };
  }

  return null;
}

/**
 * True when a resolved chat entity IS the account's own user — i.e. Saved
 * Messages, chat import's destination. Checked two ways because either input
 * shape alone can miss it: `self` is the flag Telegram sets on the entity
 * `getEntity('me')` returns, but the SAME account resolved via its own
 * username or numeric id comes back without `self` set, only a matching id.
 *
 * Used to block importing Saved Messages as a chat-import SOURCE: forwarding
 * it into itself re-registers every file already in the drive under the
 * import folder with a new message id, and insert_file's INSERT OR REPLACE
 * wipes split_group_id/part_index/is_split_file on the way — permanently
 * breaking every split (>512MB) file in the drive. Do not remove this as a
 * "redundant" check.
 */
export function isOwnAccount(entity: { self?: boolean; id?: unknown } | null | undefined, accountId: number): boolean {
  if (!entity) return false;
  if (entity.self === true) return true;
  return entity.id != null && String(entity.id) === String(accountId);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/flac': 'flac',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt',
};

export function extFromMime(mime: string | undefined): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  if (!base) return 'bin';
  if (MIME_EXT[base]) return MIME_EXT[base];
  const subtype = base.split('/')[1];
  return subtype || 'bin';
}

/** UTC yyyymmdd_hhmmss from a Telegram unix timestamp (seconds). */
function stamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * Strip anything that would break a path or a UI row, and cap the length so a
 * pathological caption-as-filename can't blow past filesystem limits on
 * download. The extension is preserved across truncation.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(CONTROL_CHARS, '')  // control chars, e.g. newlines in captions
    .replace(/[/\\]/g, '_')
    .trim();
  if (!cleaned) return 'unnamed';
  const MAX = 200;
  if (cleaned.length <= MAX) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX - ext.length) + ext;
}

function attr(attributes: any[] | undefined, className: string): any {
  return (attributes ?? []).find((a) => a?.className === className);
}

/**
 * Best available name for a message's media. Captions are deliberately NOT
 * used: they are frequently long prose with newlines and emoji, and when a
 * real DocumentAttributeFilename exists it is always the better name anyway.
 * Every synthesized name embeds the message id, so names never collide.
 */
export function deriveFilename(message: any): string {
  const msgId = message?.id;
  const media = message?.media;

  if (media?.className === 'MessageMediaPhoto') {
    return `photo_${stamp(Number(message?.date ?? 0))}_${msgId}.jpg`;
  }

  const doc = media?.document;
  const attributes = doc?.attributes as any[] | undefined;
  const mime = doc?.mimeType as string | undefined;
  const ext = extFromMime(mime);

  const named = attr(attributes, 'DocumentAttributeFilename');
  if (named?.fileName) return sanitizeFilename(String(named.fileName));

  if (attr(attributes, 'DocumentAttributeAnimated')) return `gif_${msgId}.${ext}`;
  if (attr(attributes, 'DocumentAttributeSticker')) return `sticker_${msgId}.${ext}`;

  const audio = attr(attributes, 'DocumentAttributeAudio');
  if (audio) {
    if (audio.title) {
      const label = audio.performer ? `${audio.performer} - ${audio.title}` : String(audio.title);
      return sanitizeFilename(`${label}.${ext}`);
    }
    return `audio_${msgId}.${ext}`;
  }

  if (attr(attributes, 'DocumentAttributeVideo')) return `video_${msgId}.${ext}`;

  return `file_${msgId}.${ext}`;
}
