import {
  UploadOperationError,
  type FrozenUploadTarget,
  type FrozenUploadWriter,
  type UploadManagerLike,
  type WriterVerification,
} from './uploadOperations.ts';

/**
 * Resolve every currently usable writer for one immutable upload target.
 * Saved Messages is account-scoped and therefore stays pinned to the primary;
 * a shared channel can safely fan out because every writer targets the same peer.
 */
export async function resolveFrozenUploadWriters<M extends UploadManagerLike>(
  target: FrozenUploadTarget,
  managers: readonly M[],
  verifyChannelWriter: (manager: M, channelId: string) => Promise<WriterVerification>,
): Promise<FrozenUploadWriter<M>[]> {
  const eligible = managers.filter((manager) =>
    !manager.offline && target.accountIds.includes(manager.accountId),
  );

  if (target.storageMode === 'saved_messages') {
    const manager = eligible.find((candidate) => candidate.accountId === target.primaryAccountId);
    if (!manager) {
      throw new UploadOperationError(
        'UPLOAD_UNAVAILABLE',
        `Saved Messages account ${target.primaryAccountId} is unavailable`,
      );
    }
    return [{ manager, peer: 'me' }];
  }

  const channelId = target.channelId!;
  const writers: FrozenUploadWriter<M>[] = [];
  for (const manager of eligible) {
    try {
      const verification = await verifyChannelWriter(manager, channelId);
      if (verification.can_write && verification.peer != null) {
        writers.push({ manager, peer: verification.peer });
      }
    } catch {
      // A failure local to one account must not prevent another linked account
      // from taking its share of the shared-channel upload workload.
    }
  }

  if (writers.length === 0) {
    throw new UploadOperationError(
      'UPLOAD_UNAVAILABLE',
      `No live linked account can write channel ${channelId}`,
    );
  }
  return writers;
}

/** Prefer the account-pool choice, with a deterministic verified fallback. */
export function choosePreferredFrozenWriter<M extends UploadManagerLike>(
  writers: readonly FrozenUploadWriter<M>[],
  preferredAccountId: number | null | undefined,
): FrozenUploadWriter<M> {
  if (writers.length === 0) {
    throw new UploadOperationError('UPLOAD_UNAVAILABLE', 'No frozen upload writer is available');
  }
  return writers.find((writer) => writer.manager.accountId === preferredAccountId) ?? writers[0];
}
