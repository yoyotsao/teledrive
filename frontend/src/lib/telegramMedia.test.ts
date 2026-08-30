/**
 * Why this matters: a photo built as an InputDocumentFileLocation downloads
 * garbage or errors, and `photo.size` is undefined on Api.Photo (it only has
 * sizes[]). Both bugs are silent at the type level because gramjs hands us
 * `any`. These asserts are what "we read the right bytes" means.
 */
import { describe, expect, it } from 'vitest';
import {
  readMedia, photoSizeBytes, deriveFilename, sanitizeFilename, extFromMime,
  isOwnAccount, senderDcFor,
} from './telegramMedia.ts';

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

describe('readMedia — documents', () => {
  it('reads the fields a download needs', () => {
    const d = readMedia(doc)!;

    expect(d.kind).toBe('document');
    expect(d.id).toBe('111'); // a decimal string, not a BigInt reference
    expect(d.size).toBe(4096);
    expect(d.mimeType).toBe('video/mp4');
  });

  it('has no full-size thumb and previews with the largest real one', () => {
    const d = readMedia(doc)!;

    expect(d.fullThumbSize).toBe('');
    expect(d.previewThumbSize).toBe('x');
  });

  it('reports no preview when there is no usable thumb', () => {
    const noThumbs = { ...doc, document: { ...doc.document, thumbs: [] } };
    // A stripped thumb is a few bytes of palette, not an image.
    const strippedOnly = {
      ...doc,
      document: { ...doc.document, thumbs: [{ type: 'i', bytes: new Uint8Array([9]) }] },
    };

    expect(readMedia(noThumbs)!.previewThumbSize).toBeNull();
    expect(readMedia(strippedOnly)!.previewThumbSize).toBeNull();
  });

  it('falls back to octet-stream when the document has no mime', () => {
    const noMime = { ...doc, document: { ...doc.document, mimeType: undefined } };

    expect(readMedia(noMime)!.mimeType).toBe('application/octet-stream');
  });
});

describe('readMedia — photos', () => {
  it('reads a photo as a photo, not as a document', () => {
    const p = readMedia(photo)!;

    expect(p.kind).toBe('photo');
    expect(p.id).toBe('333');
    expect(p.mimeType).toBe('image/jpeg');
  });

  it('takes its size from the largest entry, progressive included', () => {
    const p = readMedia(photo)!;

    expect(p.size).toBe(50000);
    expect(p.fullThumbSize).toBe('y');
    expect(p.previewThumbSize).toBe('m'); // the smallest real size
  });

  it('reads a progressive size from the last entry of sizes[]', () => {
    expect(photoSizeBytes({ type: 'y', sizes: [1, 2, 3] })).toBe(3);
  });

  it('gives a stripped size no byte count', () => {
    expect(photoSizeBytes({ type: 'i', bytes: new Uint8Array([1]) })).toBeNull();
  });
});

describe('readMedia — anything else', () => {
  it.each([
    { label: 'unsupported media', media: { className: 'MessageMediaPoll' } },
    { label: 'null media', media: null },
    { label: 'document media without a document', media: { className: 'MessageMediaDocument' } },
  ])('returns null for $label', ({ media }) => {
    expect(readMedia(media)).toBeNull();
  });
});

describe('deriveFilename', () => {
  const DATE = 1755388800; // 2025-08-17T00:00:00Z

  const docMessage = (attributes: any[], mimeType = 'application/octet-stream') => ({
    id: 42,
    date: DATE,
    media: {
      className: 'MessageMediaDocument',
      document: { id: 1, accessHash: 2, size: 1, mimeType, attributes },
    },
  });

  it('prefers a real filename attribute', () => {
    expect(deriveFilename(docMessage([{ className: 'DocumentAttributeFilename', fileName: 'report.pdf' }])))
      .toBe('report.pdf');
  });

  it('prefers the filename attribute even for a video', () => {
    expect(deriveFilename(docMessage(
      [{ className: 'DocumentAttributeVideo' }, { className: 'DocumentAttributeFilename', fileName: 'clip.mkv' }],
      'video/mp4',
    ))).toBe('clip.mkv');
  });

  it.each([
    { label: 'video', attributes: [{ className: 'DocumentAttributeVideo' }], mime: 'video/mp4', expected: 'video_42.mp4' },
    { label: 'audio with title and performer', attributes: [{ className: 'DocumentAttributeAudio', title: 'Song', performer: 'Band' }], mime: 'audio/mpeg', expected: 'Band - Song.mp3' },
    { label: 'audio with title only', attributes: [{ className: 'DocumentAttributeAudio', title: 'Song' }], mime: 'audio/mpeg', expected: 'Song.mp3' },
    { label: 'audio without title', attributes: [{ className: 'DocumentAttributeAudio' }], mime: 'audio/ogg', expected: 'audio_42.ogg' },
    { label: 'animated gif', attributes: [{ className: 'DocumentAttributeAnimated' }], mime: 'video/mp4', expected: 'gif_42.mp4' },
    { label: 'sticker', attributes: [{ className: 'DocumentAttributeSticker' }], mime: 'image/webp', expected: 'sticker_42.webp' },
    { label: 'bare document', attributes: [], mime: 'application/zip', expected: 'file_42.zip' },
    { label: 'unknown mime falling back to its subtype', attributes: [], mime: 'application/x-weird', expected: 'file_42.x-weird' },
    { label: 'missing mime falling back to bin', attributes: [], mime: '', expected: 'file_42.bin' },
  ])('names a $label from the message id', ({ attributes, mime, expected }) => {
    expect(deriveFilename(docMessage(attributes, mime))).toBe(expected);
  });

  it('embeds the timestamp and message id in a photo name', () => {
    const photoMsg = {
      id: 77,
      date: DATE,
      media: {
        className: 'MessageMediaPhoto',
        photo: { id: 3, accessHash: 4, sizes: [{ type: 'x', size: 10 }] },
      },
    };

    expect(deriveFilename(photoMsg)).toBe('photo_20250817_000000_77.jpg');
  });
});

describe('sanitizeFilename', () => {
  it('strips path separators', () => {
    expect(sanitizeFilename('a/b\\c.txt')).toBe('a_b_c.txt');
  });

  it('strips control characters but keeps spaces', () => {
    expect(sanitizeFilename('a b\nc.txt')).toBe('a bc.txt');
  });

  it('turns an empty name into a placeholder', () => {
    expect(sanitizeFilename('   ')).toBe('unnamed');
  });

  it('truncates to 200 chars while keeping the extension', () => {
    const long = 'x'.repeat(300) + '.mp4';

    expect(sanitizeFilename(long)).toHaveLength(200);
    expect(sanitizeFilename(long).endsWith('.mp4')).toBe(true);
  });
});

describe('extFromMime', () => {
  it('maps known types and ignores parameters', () => {
    expect(extFromMime('image/jpeg')).toBe('jpg');
    expect(extFromMime('image/jpeg; charset=binary')).toBe('jpg');
  });
});

describe('isOwnAccount', () => {
  // Guards chat import from resolving Saved Messages as a SOURCE:
  // getEntity('me') / own username / own numeric id must all be caught.
  it.each([
    { label: 'the self flag alone', entity: { self: true, id: 999 }, expected: true },
    { label: 'a matching numeric id alone (e.g. resolved by username)', entity: { id: 42 }, expected: true },
    { label: 'both the self flag and a matching id', entity: { self: true, id: 42 }, expected: true },
    { label: 'a bigint-ish id, compared by decimal string', entity: { id: '42' }, expected: true },
    { label: 'neither flag nor matching id', entity: { self: false, id: 999 }, expected: false },
    { label: 'a null entity', entity: null, expected: false },
  ])('$label → $expected', ({ entity, expected }) => {
    expect(isOwnAccount(entity, 42)).toBe(expected);
  });
});

describe('senderDcFor', () => {
  // Own uploads always land on the account's home DC, so this field went
  // unused for a long time. Forwarded files keep the source's DC, and firing
  // upload.GetFile at the main connection for one earns a FILE_MIGRATE.
  it('carries a document dcId through readMedia', () => {
    expect(readMedia({ ...doc, document: { ...doc.document, dcId: 1 } })!.dcId).toBe(1);
  });

  it('carries a photo dcId through readMedia', () => {
    const withDc = {
      className: 'MessageMediaPhoto',
      photo: { id: 1, accessHash: 2, fileReference: new Uint8Array([1]), dcId: 4, sizes: [{ type: 'x', size: 10 }] },
    };

    expect(readMedia(withDc)!.dcId).toBe(4);
  });

  it('reports a missing dcId as undefined, not 0', () => {
    expect(readMedia(doc)!.dcId).toBeUndefined();
  });

  // getSender(dcId) always builds a fresh exported sender when dcId has a
  // value — even when that value IS the home DC. That redundant connection is
  // what drove the thumbnail-batch reconnect loop (813dc42), so "same DC" has
  // to answer undefined, meaning "use the main connection".
  it.each([
    { label: 'media on the home DC', mediaDc: 2, sessionDc: 2, expected: undefined },
    { label: 'media on a foreign DC', mediaDc: 1, sessionDc: 2, expected: 1 },
    { label: 'an unknown media DC', mediaDc: undefined, sessionDc: 2, expected: undefined },
    { label: 'an unknown session DC', mediaDc: 1, sessionDc: undefined, expected: undefined },
    { label: 'a non-numeric DC', mediaDc: 'x', sessionDc: 2, expected: undefined },
    { label: 'dcId 0, which is unknown rather than a real DC', mediaDc: 0, sessionDc: 2, expected: undefined },
  ])('$label → $expected', ({ mediaDc, sessionDc, expected }) => {
    expect(senderDcFor(mediaDc as never, sessionDc as never)).toBe(expected);
  });
});
