import type { FileLocation } from './storageLocation.ts';
import { validateChannelForAccount } from './channelStorage.ts';
import { getAllClients } from './gramjs.ts';
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

function rawClient(manager: ManagerLike): any | null {
  return (manager as any).client ?? null;
}

function entityId(entity: any): string | null {
  if (entity?.id == null) return null;
  try {
    return BigInt(String(entity.id)).toString();
  } catch {
    return null;
  }
}

async function findChannelPeer(client: any, channelId: string): Promise<any | null> {
  for await (const dialog of client.iterDialogs({})) {
    if (entityId(dialog?.entity) === channelId) return dialog.entity;
  }
  return null;
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
 * Build a resolver over a live manager registry. Tests inject a registry;
 * production uses getAllClients so reload/relogin state is observed lazily.
 */
export function createFileLocationResolver(
  managers: () => readonly ManagerLike[],
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

    let attempts = 0;
    for (const manager of liveManagers) {
      attempts += 1;
      const client = rawClient(manager)!;
      try {
        const verification = await validateChannelForAccount(manager as any, location.telegram_chat_id);
        if (!verification.can_read) continue;
        const peer = await findChannelPeer(client, location.telegram_chat_id);
        if (!peer) continue;
        return await fetchAndValidate(manager, peer, location, attempts);
      } catch (error) {
        if (error instanceof FileLocationResolutionError && error.code === 'STALE_LOCATION') throw error;
        // Account-local resolution/read failures are recoverable: try the next
        // currently linked manager instead of falling back to Saved Messages.
      }
    }

    throw new FileLocationResolutionError(
      'READ_UNAVAILABLE',
      `No live linked account can read channel ${location.telegram_chat_id}`,
      attempts,
    );
  };
}

const productionResolver = createFileLocationResolver(() => getAllClients() as unknown as readonly ManagerLike[]);

export function resolveFileLocation(
  location: FileLocation,
  purpose: FileReadPurpose,
): Promise<ResolvedFileLocation> {
  return productionResolver(location, purpose);
}
