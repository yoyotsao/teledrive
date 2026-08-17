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
