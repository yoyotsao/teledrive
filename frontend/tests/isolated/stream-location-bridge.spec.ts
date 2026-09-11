import { expect, test } from '@playwright/test';
import { MainWindowStreamBridge, streamPreviewUrl } from '../../src/lib/mainWindowStreamBridge';

const row = (locationVersion = 3) => ({
  file_id: 'video-1', filename: 'video.mp4', filesize: 8, mime_type: 'video/mp4',
  telegram_user_id: 42, telegram_chat_id: '123', telegram_message_id: 77,
  telegram_media_kind: 'document' as const, telegram_media_id: '999', telegram_media_size: 8,
  telegram_photo_variant: null, location_version: locationVersion,
});

test('preview URL contains logical file/version, not Telegram message or account identity', () => {
  expect(streamPreviewUrl(row())).toBe('/preview-video/video-1/3');
});

test('metadata lookup is version-bound and returns no Telegram identity', async () => {
  const bridge = new MainWindowStreamBridge({
    getFile: async () => row(),
    resolve: async () => ({ locationVersion: 3, media: { size: 8 } } as any),
    readChunk: async () => new ArrayBuffer(0),
  });

  const result = await bridge.metadata({ request_id: 'm1', file_id: 'video-1', location_version: 3 });
  expect(result).toEqual({ request_id: 'm1', metadata: { size: 8, mimeType: 'video/mp4' } });
  expect(JSON.stringify(result)).not.toContain('telegram_');
});

test('range request returns only browser-owned bytes through the bridge', async () => {
  const reads: Array<[number, number]> = [];
  const bridge = new MainWindowStreamBridge({
    getFile: async () => row(),
    resolve: async () => ({ locationVersion: 3, manager: {}, client: {}, peer: {}, message: {}, media: {} } as any),
    readChunk: async (_resolved, offset, length) => {
      reads.push([offset, length]);
      return new Uint8Array([2, 3, 4]).buffer;
    },
  });

  const result = await bridge.handle({ request_id: 'r1', file_id: 'video-1', location_version: 3, offset: 2, length: 3 });

  expect(result.error).toBeUndefined();
  expect(Array.from(new Uint8Array(result.chunk!))).toEqual([2, 3, 4]);
  expect(reads).toEqual([[2, 3]]);
});

test('stale location_version is rejected before Telegram bytes are read', async () => {
  let reads = 0;
  const bridge = new MainWindowStreamBridge({
    getFile: async () => row(4),
    resolve: async () => ({}) as any,
    readChunk: async () => { reads += 1; return new ArrayBuffer(1); },
  });

  const result = await bridge.handle({ request_id: 'r2', file_id: 'video-1', location_version: 3, offset: 0, length: 1 });
  expect(result.error).toBe('STALE_LOCATION');
  expect(reads).toBe(0);
});

test('location switch during a read discards the stale bytes', async () => {
  let version = 3;
  const bridge = new MainWindowStreamBridge({
    getFile: async () => row(version),
    resolve: async () => ({ locationVersion: 3 } as any),
    readChunk: async () => { version = 4; return new Uint8Array([1, 2]).buffer; },
  });

  const result = await bridge.handle({ request_id: 'r3', file_id: 'video-1', location_version: 3, offset: 0, length: 2 });
  expect(result.error).toBe('STALE_LOCATION');
  expect(result.chunk).toBeUndefined();
});

test('unavailable main-window reader returns CLIENT_UNAVAILABLE deterministically', async () => {
  const bridge = new MainWindowStreamBridge({
    getFile: async () => row(),
    resolve: async () => { throw Object.assign(new Error('closed'), { code: 'CLIENT_UNAVAILABLE' }); },
    readChunk: async () => new ArrayBuffer(0),
  });

  const result = await bridge.handle({ request_id: 'r4', file_id: 'video-1', location_version: 3, offset: 0, length: 2 });
  expect(result.error).toBe('CLIENT_UNAVAILABLE');
});
