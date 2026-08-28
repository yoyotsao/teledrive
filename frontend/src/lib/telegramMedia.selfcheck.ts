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
import { readMedia, photoSizeBytes, deriveFilename, sanitizeFilename, extFromMime, isOwnAccount, senderDcFor } from './telegramMedia.ts';

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

// --- 檔名推導 ---------------------------------------------------------------
const DATE = 1755388800; // 2025-08-17T00:00:00Z

function docMessage(attributes: any[], mimeType = 'application/octet-stream') {
  return {
    id: 42,
    date: DATE,
    media: { className: 'MessageMediaDocument', document: { id: 1, accessHash: 2, size: 1, mimeType, attributes } },
  };
}

check('real filename wins',
  deriveFilename(docMessage([{ className: 'DocumentAttributeFilename', fileName: 'report.pdf' }])) === 'report.pdf');

check('video without a filename is named from the message id',
  deriveFilename(docMessage([{ className: 'DocumentAttributeVideo' }], 'video/mp4')) === 'video_42.mp4');

check('audio with title and performer',
  deriveFilename(docMessage([{ className: 'DocumentAttributeAudio', title: 'Song', performer: 'Band' }], 'audio/mpeg'))
    === 'Band - Song.mp3');

check('audio with title only',
  deriveFilename(docMessage([{ className: 'DocumentAttributeAudio', title: 'Song' }], 'audio/mpeg'))
    === 'Song.mp3');

check('audio without title',
  deriveFilename(docMessage([{ className: 'DocumentAttributeAudio' }], 'audio/ogg')) === 'audio_42.ogg');

check('animated gif',
  deriveFilename(docMessage([{ className: 'DocumentAttributeAnimated' }], 'video/mp4')) === 'gif_42.mp4');

check('sticker',
  deriveFilename(docMessage([{ className: 'DocumentAttributeSticker' }], 'image/webp')) === 'sticker_42.webp');

check('bare document falls back to file_ with a mime-derived extension',
  deriveFilename(docMessage([], 'application/zip')) === 'file_42.zip');

check('unknown mime falls back to its subtype',
  deriveFilename(docMessage([], 'application/x-weird')) === 'file_42.x-weird');

check('missing mime falls back to bin',
  deriveFilename(docMessage([], '')) === 'file_42.bin');

check('filename attribute wins even for a video',
  deriveFilename(docMessage(
    [{ className: 'DocumentAttributeVideo' }, { className: 'DocumentAttributeFilename', fileName: 'clip.mkv' }],
    'video/mp4')) === 'clip.mkv');

const photoMsg = {
  id: 77,
  date: DATE,
  media: { className: 'MessageMediaPhoto', photo: { id: 3, accessHash: 4, sizes: [{ type: 'x', size: 10 }] } },
};
check('photo name embeds its timestamp and message id',
  deriveFilename(photoMsg) === 'photo_20250817_000000_77.jpg');

// sanitize
check('path separators are stripped',
  sanitizeFilename('a/b\\c.txt') === 'a_b_c.txt');
check('control characters are stripped but spaces survive',
  sanitizeFilename('a b\nc.txt') === 'a bc.txt');
check('an empty name becomes a placeholder',
  sanitizeFilename('   ') === 'unnamed');
const long = 'x'.repeat(300) + '.mp4';
check('long names are truncated to 200 chars', sanitizeFilename(long).length === 200);
check('truncation keeps the extension', sanitizeFilename(long).endsWith('.mp4'));

check('extFromMime maps known types', extFromMime('image/jpeg') === 'jpg');
check('extFromMime handles parameters', extFromMime('image/jpeg; charset=binary') === 'jpg');

// --- isOwnAccount: guards chat import from resolving Saved Messages as a SOURCE ----
// (getEntity('me') / own username / own numeric id must all be caught — see gramjs.ts resolveChat)
check('self flag alone marks the entity as the account itself',
  isOwnAccount({ self: true, id: 999 }, 42) === true);
check('a matching numeric id alone marks the entity as the account itself (no self flag, e.g. resolved by username)',
  isOwnAccount({ id: 42 }, 42) === true);
check('both self flag and matching id still marks the entity as the account itself',
  isOwnAccount({ self: true, id: 42 }, 42) === true);
check('neither self flag nor matching id means it is a genuinely different chat',
  isOwnAccount({ self: false, id: 999 }, 42) === false);
check('a bigint-ish id compares by decimal string, not reference',
  isOwnAccount({ id: '42' }, 42) === true);
check('null entity is never the own account', isOwnAccount(null, 42) === false);

// --- 媒體所在的 DC ------------------------------------------------------------
// 自己上傳的檔案永遠落在帳號的 home DC，所以這個欄位一直沒人要。轉發進來的
// 檔案保留來源的 DC，對主連線發 upload.GetFile 會換來 FILE_MIGRATE。
check('document: dcId is carried through', readMedia({
  ...doc, document: { ...doc.document, dcId: 1 },
})!.dcId === 1);
check('photo: dcId is carried through', readMedia({
  className: 'MessageMediaPhoto',
  photo: { id: 1, accessHash: 2, fileReference: new Uint8Array([1]), dcId: 4, sizes: [{ type: 'x', size: 10 }] },
})!.dcId === 4);
check('media with no dcId reports it as undefined, not 0',
  readMedia(doc)!.dcId === undefined);

// --- 該用哪一條連線發 GetFile --------------------------------------------------
// getSender(dcId) 只要 dcId 有值就一定新建一條 exported sender，即使那就是
// home DC —— 那條多餘的連線正是先前縮圖批次下載 reconnect 迴圈的成因
// (813dc42)。所以同 DC 必須回 undefined，代表「用主連線」。
check('media on the home DC uses the main sender', senderDcFor(2, 2) === undefined);
check('media on a foreign DC names that DC', senderDcFor(1, 2) === 1);
check('unknown media DC falls back to the main sender', senderDcFor(undefined, 2) === undefined);
check('unknown session DC falls back to the main sender', senderDcFor(1, undefined) === undefined);
check('a non-numeric DC falls back to the main sender', senderDcFor('x', 2) === undefined);
check('dcId 0 is treated as unknown, not as a real DC', senderDcFor(0, 2) === undefined);

console.log('\nAll telegramMedia checks passed.');
