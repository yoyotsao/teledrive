import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const resolveFileLocation = vi.fn();
  const legacyDownload = vi.fn();
  const legacyThumbnails = vi.fn();
  const getClientFor = vi.fn(() => ({ downloadFile: legacyDownload, downloadThumbnails: legacyThumbnails }));
  const getPrimaryClient = vi.fn(() => ({ downloadFile: legacyDownload, downloadThumbnails: legacyThumbnails }));
  return { resolveFileLocation, legacyDownload, legacyThumbnails, getClientFor, getPrimaryClient };
});

vi.mock('./fileLocationResolver.ts', () => ({ resolveFileLocation: mocks.resolveFileLocation }));
vi.mock('./gramjs', () => ({
  getClientFor: mocks.getClientFor,
  getPrimaryClient: mocks.getPrimaryClient,
}));
vi.mock('../api/client', () => ({ api: { getSplitGroupFiles: vi.fn() } }));

import { fetchFileBlob, fetchFileThumbnail, thumbnailCacheKey } from './download.ts';

function channelFile(locationVersion = 1) {
  return {
    file_id: 'logical-1',
    filename: 'a.bin',
    filesize: 3,
    mime_type: 'application/octet-stream',
    telegram_user_id: 42,
    telegram_chat_id: '123',
    telegram_message_id: 7,
    telegram_media_kind: 'document',
    telegram_media_id: '999',
    telegram_media_size: 3,
    telegram_photo_variant: null,
    location_version: locationVersion,
    is_split_file: false,
  } as any;
}

describe('resolver-based downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not select a Telegram manager by telegram_user_id for a channel row', async () => {
    const downloadMedia = vi.fn(async () => new Uint8Array([1, 2, 3]));
    mocks.resolveFileLocation.mockResolvedValue({
      client: { downloadMedia },
      message: { id: 7 },
      media: { size: 3 },
      locationVersion: 1,
    });

    const blob = await fetchFileBlob(channelFile());

    expect(blob.size).toBe(3);
    expect(mocks.resolveFileLocation).toHaveBeenCalledWith(expect.objectContaining({
      telegram_chat_id: '123',
      location_version: 1,
    }), 'download');
    expect(mocks.getClientFor).not.toHaveBeenCalled();
    expect(mocks.getPrimaryClient).not.toHaveBeenCalled();
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });

  it('passes the current location version through the resolver after relocation', async () => {
    const downloadMedia = vi.fn(async () => new Uint8Array([1, 2, 3]));
    mocks.resolveFileLocation.mockResolvedValue({
      client: { downloadMedia },
      message: { id: 7 },
      media: { size: 3 },
      locationVersion: 8,
    });

    await fetchFileBlob(channelFile(8));

    expect(mocks.resolveFileLocation).toHaveBeenCalledWith(expect.objectContaining({
      location_version: 8,
    }), 'download');
  });

  it('keeps legacy Saved Messages rows readable through their original account', async () => {
    mocks.legacyDownload.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])]));
    const legacy = {
      file_id: 'legacy',
      filename: 'legacy.bin',
      filesize: 3,
      mime_type: 'application/octet-stream',
      telegram_user_id: 42,
      telegram_message_id: 7,
      is_split_file: false,
    } as any;

    await fetchFileBlob(legacy);

    expect(mocks.getClientFor).toHaveBeenCalledWith(42);
    expect(mocks.resolveFileLocation).not.toHaveBeenCalled();
  });

  it('downloads channel thumbnails through the same resolved peer/message', async () => {
    const downloadMedia = vi.fn(async () => new Uint8Array([9, 8]));
    mocks.resolveFileLocation.mockResolvedValue({
      client: { downloadMedia },
      message: { id: 7 },
      media: { previewThumbSize: 'm', size: 3 },
      locationVersion: 1,
    });

    const blob = await fetchFileThumbnail(channelFile());

    expect(blob?.size).toBe(2);
    expect(mocks.resolveFileLocation).toHaveBeenCalledWith(expect.objectContaining({ telegram_chat_id: '123' }), 'thumbnail');
    expect(downloadMedia).toHaveBeenCalledWith({ id: 7 }, expect.objectContaining({ thumb: 'm' }));
    expect(mocks.getClientFor).not.toHaveBeenCalled();
  });

  it('invalidates thumbnail cache identity when location_version changes', () => {
    expect(thumbnailCacheKey(channelFile(1))).not.toBe(thumbnailCacheKey(channelFile(2)));
  });
});
