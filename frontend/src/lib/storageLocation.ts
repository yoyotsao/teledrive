import type { FileInfo } from '../types/index.ts';

/** A raw positive Telegram channel ID, represented as a decimal string. */
export type CanonicalChannelId = string;

export type MediaKind = 'document' | 'photo';

export type StorageTarget =
  | {
      storage_mode: 'saved_messages';
      telegram_user_id: number;
    }
  | {
      storage_mode: 'channel';
      telegram_channel_id: CanonicalChannelId;
    };

/** The Telegram media identity needed to recreate an Input*FileLocation. */
export interface MediaIdentity {
  media_kind: MediaKind;
  /** Telegram 64-bit IDs stay decimal strings so requests remain JSON-safe. */
  media_id: string;
  media_size: number;
  photo_variant?: string;
}

interface LocationBase extends MediaIdentity {
  telegram_message_id: number;
  location_version: number;
}

/** Immutable physical channel location for one logical file version. */
export interface ChannelFileLocation extends LocationBase {
  telegram_chat_id: CanonicalChannelId;
}

/** Immutable Saved Messages location, bound to its original storage account. */
export interface SavedMessagesFileLocation extends LocationBase {
  telegram_chat_id: null;
  telegram_user_id: number;
}

export type FileLocation = ChannelFileLocation | SavedMessagesFileLocation;

/** JSON-only descriptor used by direct-stream readers to resolve a location. */
export interface StreamLocationRequest {
  request_id: string;
  file_id: string;
  part_id?: string;
  location_version: number;
  offset: number;
  length: number;
}

const MIN_CHANNEL_ID = 1n;
const MAX_CHANNEL_ID = 997852516352n;
const MARKED_CHANNEL_OFFSET = 1000000000000n;

function isChannelIdInRange(value: bigint): boolean {
  return value >= MIN_CHANNEL_ID && value <= MAX_CHANNEL_ID;
}

function invalidChannelId(input: string): Error {
  return new Error(`Invalid Telegram channel ID: ${input}`);
}

/**
 * Parses editable UI syntax. It accepts a raw channel ID or Telegram's marked
 * -100… display form, then returns the canonical raw decimal API value.
 */
export function parseChannelInput(input: string): CanonicalChannelId {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const value = BigInt(trimmed);
    if (isChannelIdInRange(value)) return value.toString();
    throw invalidChannelId(input);
  }

  if (/^-\d+$/.test(trimmed)) {
    const marked = BigInt(trimmed);
    const raw = -marked - MARKED_CHANNEL_OFFSET;
    if (isChannelIdInRange(raw)) return raw.toString();
  }

  throw invalidChannelId(input);
}

/** Parses only a raw API value that has already been canonicalized. */
export function parseCanonicalChannelId(raw: string): CanonicalChannelId {
  if (!/^[1-9]\d*$/.test(raw)) throw invalidChannelId(raw);
  const value = BigInt(raw);
  if (!isChannelIdInRange(value)) throw invalidChannelId(raw);
  return raw;
}

/** Stable cache key for a physical location, including its replacement version. */
export function locationKey(location: FileLocation): string {
  return JSON.stringify([
    location.telegram_chat_id === null
      ? `saved_messages:${location.telegram_user_id}`
      : `channel:${location.telegram_chat_id}`,
    location.telegram_message_id,
    location.media_kind,
    location.media_id,
    location.media_size,
    location.photo_variant ?? null,
    location.location_version,
  ]);
}

type FileInfoLocationFields = Pick<
  FileInfo,
  | 'telegram_chat_id'
  | 'telegram_user_id'
  | 'telegram_message_id'
  | 'telegram_media_kind'
  | 'telegram_media_id'
  | 'telegram_media_size'
  | 'telegram_photo_variant'
  | 'location_version'
>;

/** Converts optional wire fields into the internal storage-location contract. */
export function fileInfoToLocation(file: FileInfoLocationFields): FileLocation | null {
  if (
    file.telegram_chat_id === undefined
    || file.telegram_message_id == null
    || file.telegram_media_kind == null
    || file.telegram_media_id == null
    || file.telegram_media_size == null
    || file.location_version == null
  ) return null;

  if (file.telegram_chat_id === null && file.telegram_user_id == null) return null;

  const media = {
    telegram_message_id: file.telegram_message_id,
    media_kind: file.telegram_media_kind,
    media_id: file.telegram_media_id,
    media_size: file.telegram_media_size,
    ...(file.telegram_photo_variant == null ? {} : { photo_variant: file.telegram_photo_variant }),
    location_version: file.location_version,
  };
  return file.telegram_chat_id === null
    ? { ...media, telegram_chat_id: null, telegram_user_id: file.telegram_user_id! }
    : { ...media, telegram_chat_id: file.telegram_chat_id };
}

/** Converts the internal contract to the API field names without touching legacy metadata. */
export function locationToFileInfoFields(location: FileLocation): Pick<
  FileInfo,
  | 'telegram_chat_id'
  | 'telegram_user_id'
  | 'telegram_message_id'
  | 'telegram_media_kind'
  | 'telegram_media_id'
  | 'telegram_media_size'
  | 'telegram_photo_variant'
  | 'location_version'
> {
  const media = {
    telegram_chat_id: location.telegram_chat_id,
    telegram_message_id: location.telegram_message_id,
    telegram_media_kind: location.media_kind,
    telegram_media_id: location.media_id,
    telegram_media_size: location.media_size,
    telegram_photo_variant: location.photo_variant ?? null,
    location_version: location.location_version,
  };
  return location.telegram_chat_id === null
    ? { ...media, telegram_user_id: location.telegram_user_id }
    : media;
}
