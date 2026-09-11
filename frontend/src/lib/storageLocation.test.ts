import { describe, expect, it } from 'vitest';
import {
  fileInfoToLocation,
  locationToFileInfoFields,
  locationKey,
  parseCanonicalChannelId,
  parseChannelInput,
  type FileLocation,
  type StorageTarget,
  type StreamLocationRequest,
} from './storageLocation.ts';

describe('parseChannelInput', () => {
  it.each([
    { input: '1234567890', expected: '1234567890' },
    { input: '  0000000000001  ', expected: '1' },
    { input: '-1001234567890', expected: '1234567890' },
    { input: '-1000000000001', expected: '1' },
    { input: '-1997852516352', expected: '997852516352' },
  ])('normalizes $input to the canonical raw channel ID', ({ input, expected }) => {
    expect(parseChannelInput(input)).toBe(expected);
  });

  it.each([
    'https://t.me/example',
    '@example',
    '0',
    '-1',
    '-1000000000000',
    '-1997852516353',
    '997852516353',
    '123abc',
  ])('rejects display input that is not a supported channel ID: %s', (input) => {
    expect(() => parseChannelInput(input)).toThrow();
  });
});

describe('parseCanonicalChannelId', () => {
  it.each(['1', '1234567890', '997852516352'])('accepts raw API channel ID %s', (input) => {
    expect(parseCanonicalChannelId(input)).toBe(input);
  });

  it.each([
    '-1001234567890',
    ' 1234567890',
    '1234567890 ',
    '0001',
    '0',
    '997852516353',
  ])('rejects non-canonical API input %s', (input) => {
    expect(() => parseCanonicalChannelId(input)).toThrow();
  });
});

describe('locationKey', () => {
  const location: FileLocation = {
    telegram_chat_id: '1234567890',
    telegram_message_id: 81,
    media_kind: 'document',
    media_id: '9876543210',
    media_size: 4096,
    location_version: 3,
  };

  it('changes when a location is replaced at the same chat and message', () => {
    expect(locationKey({ ...location, location_version: 4 })).not.toBe(locationKey(location));
  });

  it('keys Saved Messages locations by the original uploader', () => {
    const savedByFirstAccount = {
      ...location,
      telegram_chat_id: null,
      telegram_user_id: 42,
    } as const;
    const savedBySecondAccount = {
      ...savedByFirstAccount,
      telegram_user_id: 43,
    } as const;

    expect(locationKey(savedByFirstAccount)).toContain('saved_messages:42');
    expect(locationKey(savedBySecondAccount)).toContain('saved_messages:43');
    expect(locationKey(savedByFirstAccount)).not.toBe(locationKey(savedBySecondAccount));
  });

  it('keeps storage contract IDs JSON-serializable', () => {
    const target: StorageTarget = {
      storage_mode: 'channel',
      telegram_channel_id: '1234567890',
    };
    const request: StreamLocationRequest = {
      request_id: 'read-1',
      file_id: 'logical-file-1',
      part_id: 'part-0',
      location_version: 3,
      offset: 1024,
      length: 4096,
    };

    expect(JSON.parse(JSON.stringify({ target, request }))).toEqual({ target, request });
  });

  it('maps a Saved Messages FileInfo row when its original uploader is known', () => {
    const savedMessagesWire = {
      telegram_chat_id: null,
      telegram_message_id: 81,
      telegram_media_kind: 'document' as const,
      telegram_media_id: '9876543210',
      telegram_media_size: 4096,
      telegram_photo_variant: null,
      location_version: 3,
      telegram_user_id: 42,
    };

    expect(fileInfoToLocation(savedMessagesWire)).toEqual({
      ...location,
      telegram_chat_id: null,
      telegram_user_id: 42,
    });
  });

  it('writes the original uploader for a Saved Messages location', () => {
    const savedLocation: FileLocation = {
      ...location,
      telegram_chat_id: null,
      telegram_user_id: 42,
    };

    expect(locationToFileInfoFields(savedLocation)).toEqual({
      telegram_chat_id: null,
      telegram_message_id: 81,
      telegram_media_kind: 'document',
      telegram_media_id: '9876543210',
      telegram_media_size: 4096,
      telegram_photo_variant: null,
      location_version: 3,
      telegram_user_id: 42,
    });
  });

  it('converts between wire FileInfo fields and an internal location without replacing legacy fields', () => {
    const wire = {
      telegram_chat_id: '1234567890',
      telegram_message_id: 81,
      telegram_media_kind: 'document' as const,
      telegram_media_id: '9876543210',
      telegram_media_size: 4096,
      telegram_photo_variant: null,
      location_version: 3,
      telegram_user_id: 42,
      access_hash: 'legacy-access-hash',
    };

    expect(fileInfoToLocation(wire)).toEqual(location);
    expect(locationToFileInfoFields(location)).toEqual({
      telegram_chat_id: '1234567890',
      telegram_message_id: 81,
      telegram_media_kind: 'document',
      telegram_media_id: '9876543210',
      telegram_media_size: 4096,
      telegram_photo_variant: null,
      location_version: 3,
    });
  });
});
