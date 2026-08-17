/**
 * Self-check for telegramMedia — the media-shape guesswork that used to be
 * scattered through gramjs.ts download paths. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/telegramMedia.selfcheck.ts | node --input-type=module
 *
 * Why this matters: a photo built as an InputDocumentFileLocation downloads
 * garbage or errors, and `photo.size` is undefined on Api.Photo (it only has
 * sizes[]). Both bugs are silent at the type level because gramjs hands us
 * `any`. These asserts are what "we read the right bytes" means.
 */
import { readMedia, photoSizeBytes } from './telegramMedia.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

// --- document ---------------------------------------------------------------
const doc = {
  className: 'MessageMediaDocument',
  document: {
    id: 111, accessHash: 222, fileReference: new Uint8Array([1, 2]),
    size: 4096, mimeType: 'video/mp4',
    thumbs: [
      { type: 'i', bytes: new Uint8Array([9]) },   // stripped —— 不可用
      { type: 'm', size: 800 },
      { type: 'x', size: 9000 },
    ],
    attributes: [],
  },
};
const d = readMedia(doc)!;
check('document: kind', d.kind === 'document');
check('document: id is a decimal string', d.id === '111');
check('document: size', d.size === 4096);
check('document: mime', d.mimeType === 'video/mp4');
check('document: fullThumbSize is empty', d.fullThumbSize === '');
check('document: preview picks largest real thumb', d.previewThumbSize === 'x');

const docNoThumb = { ...doc, document: { ...doc.document, thumbs: [] } };
check('document without thumbs has no preview', readMedia(docNoThumb)!.previewThumbSize === null);

const docStrippedOnly = {
  ...doc,
  document: { ...doc.document, thumbs: [{ type: 'i', bytes: new Uint8Array([9]) }] },
};
check('document with only a stripped thumb has no preview',
  readMedia(docStrippedOnly)!.previewThumbSize === null);

const docNoMime = { ...doc, document: { ...doc.document, mimeType: undefined } };
check('document without mime falls back to octet-stream',
  readMedia(docNoMime)!.mimeType === 'application/octet-stream');

// --- photo ------------------------------------------------------------------
const photo = {
  className: 'MessageMediaPhoto',
  photo: {
    id: 333, accessHash: 444, fileReference: new Uint8Array([3]),
    sizes: [
      { type: 'i', bytes: new Uint8Array([7]) },       // stripped
      { type: 'm', size: 1200 },
      { type: 'y', sizes: [100, 2000, 50000] },        // PhotoSizeProgressive
    ],
  },
};
const p = readMedia(photo)!;
check('photo: kind', p.kind === 'photo');
check('photo: id', p.id === '333');
check('photo: mime is jpeg', p.mimeType === 'image/jpeg');
check('photo: size comes from the largest size, progressive included',
  p.size === 50000);
check('photo: fullThumbSize is the largest size type', p.fullThumbSize === 'y');
check('photo: preview is the smallest real size', p.previewThumbSize === 'm');

check('progressive size uses the last entry of sizes[]',
  photoSizeBytes({ type: 'y', sizes: [1, 2, 3] }) === 3);
check('stripped size has no byte count',
  photoSizeBytes({ type: 'i', bytes: new Uint8Array([1]) }) === null);

// --- 其他 --------------------------------------------------------------------
check('unsupported media returns null',
  readMedia({ className: 'MessageMediaPoll' }) === null);
check('null media returns null', readMedia(null) === null);
check('document media without a document returns null',
  readMedia({ className: 'MessageMediaDocument' }) === null);

console.log('\nAll telegramMedia checks passed.');
