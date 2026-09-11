import { Api } from 'telegram/tl';
import { parseCanonicalChannelId } from './storageLocation.ts';

export interface AccountChannelVerification {
  telegram_user_id: number;
  channel_title: string | null;
  channel_id: string;
  can_read: boolean;
  can_write: boolean;
  status: 'verified';
  checked_at: string;
  accounts_version: number;
}

export class ChannelStorageError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ChannelStorageError';
  }
}

type ChannelEntity = {
  id?: unknown;
  title?: string;
  broadcast?: boolean;
  megagroup?: boolean;
  username?: string | null;
  creator?: boolean;
  adminRights?: { postMessages?: boolean } | null;
};

export type ChannelManagerLike = {
  accountId: number;
  accountsVersion?: number;
  sessionGeneration?: number;
  client?: {
    iterDialogs: (...args: any[]) => AsyncIterable<{ entity?: ChannelEntity }>;
    invoke: (request: unknown) => Promise<any>;
  } | null;
};

type CacheEntry = {
  generation: number;
  byChannel: Map<string, AccountChannelVerification>;
  byPeer: Map<string, ChannelEntity>;
};

const verificationCache = new WeakMap<object, CacheEntry>();
const implicitGeneration = new WeakMap<object, number>();
const lastCheckedAtMs = new WeakMap<object, number>();

function managerGeneration(manager: ChannelManagerLike): number {
  return typeof manager.sessionGeneration === 'number'
    ? manager.sessionGeneration
    : (implicitGeneration.get(manager as object) ?? 0);
}

function cacheEntryFor(manager: ChannelManagerLike, generation: number): CacheEntry {
  const key = manager as object;
  const cached = verificationCache.get(key);
  if (cached?.generation === generation) return cached;
  const entry: CacheEntry = {
    generation,
    byChannel: new Map<string, AccountChannelVerification>(),
    byPeer: new Map<string, ChannelEntity>(),
  };
  verificationCache.set(key, entry);
  return entry;
}

function entityId(entity: ChannelEntity): string | null {
  if (entity.id == null) return null;
  try {
    return BigInt(String(entity.id)).toString();
  } catch {
    return null;
  }
}

function nextCheckedAt(manager: ChannelManagerLike): string {
  const key = manager as object;
  const previous = lastCheckedAtMs.get(key) ?? 0;
  const now = Math.max(Date.now(), previous + 1);
  lastCheckedAtMs.set(key, now);
  return new Date(now).toISOString();
}

function canWriteChannel(entity: ChannelEntity, participantResult: any): boolean {
  if (entity.creator === true) return true;
  if (entity.adminRights?.postMessages === true) return true;

  const participant = participantResult?.participant;
  const className = String(participant?.className ?? '');
  if (className.includes('Creator')) return true;
  if (participant?.adminRights?.postMessages === true) return true;
  return false;
}

/**
 * Invalidate account-local channel observations after relogin/session rotation.
 * The backend never receives this frontend-only generation token.
 */
export function invalidateChannelSessionGeneration(manager: ChannelManagerLike): void {
  if (typeof manager.sessionGeneration === 'number') {
    manager.sessionGeneration += 1;
  } else {
    const key = manager as object;
    implicitGeneration.set(key, (implicitGeneration.get(key) ?? 0) + 1);
  }
  verificationCache.delete(manager as object);
}

/** Resolve the live entity/peer from this browser-owned manager only. */
export async function resolveChannelPeerForAccount(
  manager: ChannelManagerLike,
  canonicalChannelId: string,
): Promise<ChannelEntity | null> {
  const channelId = parseCanonicalChannelId(canonicalChannelId);
  const generation = managerGeneration(manager);
  const cache = cacheEntryFor(manager, generation);
  const cachedPeer = cache.byPeer.get(channelId);
  if (cachedPeer) return cachedPeer;

  const client = manager.client;
  if (!client) {
    throw new ChannelStorageError('CLIENT_UNAVAILABLE', 'Telegram client is not available');
  }
  for await (const dialog of client.iterDialogs({})) {
    const candidate = dialog?.entity;
    if (candidate && entityId(candidate) === channelId) {
      cache.byPeer.set(channelId, candidate);
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve one private broadcast channel using only this account's Telegram
 * client and derive read/write capability without sending a probe message.
 */
export async function validateChannelForAccount(
  manager: ChannelManagerLike,
  canonicalChannelId: string,
): Promise<AccountChannelVerification> {
  const channelId = parseCanonicalChannelId(canonicalChannelId);
  const generation = managerGeneration(manager);
  const cache = cacheEntryFor(manager, generation);
  const existing = cache.byChannel.get(channelId);
  if (existing) return existing;

  const client = manager.client;
  if (!client) {
    throw new ChannelStorageError('CLIENT_UNAVAILABLE', 'Telegram client is not available');
  }

  const entity = await resolveChannelPeerForAccount(manager, channelId);
  if (!entity) {
    throw new ChannelStorageError('CHANNEL_NOT_FOUND', `Channel ${channelId} was not found for this account`);
  }
  if (entity.broadcast !== true || entity.megagroup === true) {
    throw new ChannelStorageError('CHANNEL_NOT_BROADCAST', 'Storage target must be a broadcast channel');
  }
  if (entity.username) {
    throw new ChannelStorageError('CHANNEL_NOT_PRIVATE', 'Storage target must be private');
  }

  let participantResult: any;
  try {
    participantResult = await client.invoke(new Api.channels.GetParticipant({
      channel: entity as any,
      participant: new Api.InputPeerSelf(),
    }));
  } catch (error) {
    throw new ChannelStorageError(
      'CHANNEL_READ_UNAVAILABLE',
      `Account cannot read channel ${channelId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const verification: AccountChannelVerification = {
    telegram_user_id: manager.accountId,
    channel_title: entity.title ?? null,
    channel_id: channelId,
    can_read: true,
    can_write: canWriteChannel(entity, participantResult),
    status: 'verified',
    checked_at: nextCheckedAt(manager),
    accounts_version: manager.accountsVersion ?? 0,
  };

  cache.byChannel.set(channelId, verification);
  return verification;
}
