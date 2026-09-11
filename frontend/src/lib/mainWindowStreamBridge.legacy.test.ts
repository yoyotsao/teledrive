import { describe, expect, it, vi } from 'vitest';
import { MainWindowStreamBridge } from './mainWindowStreamBridge.ts';

const legacyRow = () => ({
  file_id: 'legacy-video',
  filename: 'legacy.mp4',
  filesize: 8,
  mime_type: 'video/mp4',
  telegram_user_id: 42,
  telegram_chat_id: null,
  telegram_message_id: 77,
  telegram_media_kind: null,
  telegram_media_id: null,
  telegram_media_size: null,
  telegram_photo_variant: null,
  location_version: 0,
});

describe('legacy Saved Messages streaming', () => {
  it('serves metadata without requiring canonical media identity', async () => {
    const resolve = vi.fn();
    const bridge = new MainWindowStreamBridge({
      getFile: async () => legacyRow() as any,
      resolve,
      readChunk: vi.fn(),
      readLegacyChunk: vi.fn(),
    } as any);

    const result = await bridge.metadata({
      request_id: 'legacy-metadata',
      file_id: 'legacy-video',
      location_version: 0,
    });

    expect(result).toEqual({
      request_id: 'legacy-metadata',
      metadata: { size: 8, mimeType: 'video/mp4' },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reads a range through the original Saved Messages account fallback', async () => {
    const readLegacyChunk = vi.fn(async () => new Uint8Array([4, 5, 6]).buffer);
    const resolve = vi.fn();
    const bridge = new MainWindowStreamBridge({
      getFile: async () => legacyRow() as any,
      resolve,
      readChunk: vi.fn(),
      readLegacyChunk,
    } as any);

    const result = await bridge.handle({
      request_id: 'legacy-range',
      file_id: 'legacy-video',
      location_version: 0,
      offset: 2,
      length: 3,
    });

    expect(result.error).toBeUndefined();
    expect(Array.from(new Uint8Array(result.chunk!))).toEqual([4, 5, 6]);
    expect(readLegacyChunk).toHaveBeenCalledWith(expect.objectContaining({
      telegram_user_id: 42,
      telegram_message_id: 77,
    }), 2, 3);
    expect(resolve).not.toHaveBeenCalled();
  });
});
