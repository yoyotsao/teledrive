import type { FileLocation } from './storageLocation.ts';
import { resolveChannelPeerForAccount, validateChannelForAccount } from './channelStorage.ts';
import { getAllClients, loadJwt } from './gramjs.ts';
import { readMedia, type MediaRef } from './telegramMedia.ts';

export type FileReadPurpose = 'download' | 'thumbnail' | 'preview' | 'stream';

export interface ResolvedFileLocation {
  manager: any;
  client: any;
  peer: any;
  message: any;
  media: MediaRef;
  locationVersion: number;
}

export class FileLocationResolutionError extends Error {
  constructor(
    public readonly code: 'READ_UNAVAILABLE' | 'STALE_LOCATION' | 'MESSAGE_NOT_FOUND' | 'CLIENT_UNAVAILABLE',
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = 'FileLocationResolutionError';
  }
}

type ManagerLike = {
  accountId: number;
  offline?: boolean;
  client?: any;
};

/** JWT user_id is the drive owner, which is the immutable primary Telegram account. */
export function primaryAccountIdFromJwt(token: string | null): number | null {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const userId = Number(JSON.parse(atob(padded))?.user_id);
    return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}

function rawClient(manager: ManagerLike): any | null {
  return (manager as any).client ?? null;
}

function validateIdentity(location: FileLocation, media: MediaRef, attempts: number): void {
  const photoVariant = media.kind === 'photo' ? media.fullThumbSize : undefined;
  if (
    media.kind !== location.media_kind
    || media.id !== location.media_id
    || media.size !== location.media_size
    || (location.photo_variant != null && photoVariant !== location.photo_variant)
  ) {
    throw new FileLocationResolutionError(
      'STALE_LOCATION',
      `Stored Telegram media identity no longer matches location version ${location.location_version}`,
      attempts,
    );
  }
}

async function fetchAndValidate(
  manager: ManagerLike,
  peer: any,
  location: FileLocation,
  attempts: number,
): Promise<ResolvedFileLocation> {
  const client = rawClient(manager);
  if (!client) {
    throw new FileLocationResolutionError('CLIENT_UNAVAILABLE', 'Telegram client is unavailable', attempts);
  }
  const messages = await client.getMessages(peer, { ids: [location.telegram_message_id] });
  const message = messages?.[0];
  if (!message?.media) {
    throw new FileLocationResolutionError(
      'MESSAGE_NOT_FOUND',
      `Telegram message ${location.telegram_message_id} has no readable media`,
      attempts,
    );
  }
  const media = readMedia(message.media);
  if (!media) {
    throw new FileLocationResolutionError('STALE_LOCATION', 'Telegram media type is unsupported', attempts);
  }
  validateIdentity(location, media, attempts);
  return { manager, client, peer, message, media, locationVersion: location.location_version };
}

/**
 * Build a resolver over a live manager registry. Tests inject a registry and
 * primary selector; production derives the primary account from the drive JWT.
 */
export function createFileLocationResolver(
  managers: () => readonly ManagerLike[],
  primaryAccountId: () => number | null,
): (location: FileLocation, purpose: FileReadPurpose) => Promise<ResolvedFileLocation> {
  return async (location: FileLocation, _purpose: FileReadPurpose): Promise<ResolvedFileLocation> => {
    const liveManagers = managers().filter((manager) => !manager.offline && rawClient(manager));

    if (location.telegram_chat_id === null) {
      const original = liveManagers.find((manager) => manager.accountId === location.telegram_user_id);
      if (!original) {
        throw new FileLocationResolutionError(
          'READ_UNAVAILABLE',
          `Saved Messages account ${location.telegram_user_id} is not locally available`,
          0,
        );
      }
      return fetchAndValidate(original, 'me', location, 1);
    }

    const primaryId = primaryAccountId();
    const primary = primaryId == null
      ? undefined
      : liveManagers.find((manager) => manager.accountId === primaryId);
    if (!primary) {
      throw new FileLocationResolutionError(
        'READ_UNAVAILABLE',
        `Primary account ${primaryId ?? 'unknown'} is not locally available`,
        0,
      );
    }

    try {
      const verification = await validateChannelForAccount(primary as any, location.telegram_chat_id);
      if (!verification.can_read) throw new Error('Primary account cannot read channel');
      const peer = await resolveChannelPeerForAccount(primary as any, location.telegram_chat_id);
      if (!peer) throw new Error('Primary account cannot resolve channel');
      return await fetchAndValidate(primary, peer, location, 1);
    } catch (error) {
      if (error instanceof FileLocationResolutionError && error.code === 'STALE_LOCATION') throw error;
      throw new FileLocationResolutionError(
        'READ_UNAVAILABLE',
        `Primary account ${primaryId} cannot read channel ${location.telegram_chat_id}`,
        1,
      );
    }
  };
}

const productionResolver = createFileLocationResolver(
  () => getAllClients() as unknown as readonly ManagerLike[],
  () => primaryAccountIdFromJwt(loadJwt()),
);

export function resolveFileLocation(
  location: FileLocation,
  purpose: FileReadPurpose,
): Promise<ResolvedFileLocation> {
  return productionResolver(location, purpose);
}
