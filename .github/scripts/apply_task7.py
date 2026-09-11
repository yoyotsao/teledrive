from pathlib import Path

path = Path('frontend/src/lib/gramjs.ts')
text = path.read_text()

old = "export type AlbumFileResult = { message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean };"
new = "export type AlbumFileResult = { message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean; mediaKind?: 'document' | 'photo'; mediaId?: string; photoVariant?: string };\nexport type TargetAwareSendResult = { messageId: number; mediaKind: 'document' | 'photo'; mediaId: string; size: number; accessHash?: string; photoVariant?: string; message: Api.Message };"
assert old in text
text = text.replace(old, new, 1)

old = '''  private async sendFileLocked(params: any, maxRetries = 3): Promise<unknown> {
    return this.sendFileSemaphore.withSlot(async () => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          await this.messageRateLimiter.wait();
          return await this.client!.sendFile("me", params);'''
new = '''  private async sendFileLocked(params: any, maxRetries = 3, targetPeer: any = "me"): Promise<unknown> {
    return this.sendFileSemaphore.withSlot(async () => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          await this.messageRateLimiter.wait();
          const normalizedParams = typeof params?.randomId === 'string'
            ? { ...params, randomId: bigInt(params.randomId) as any }
            : params;
          return await this.client!.sendFile(targetPeer, normalizedParams);'''
assert old in text
text = text.replace(old, new, 1)

old = '''  async sendAlbum(prepared: PreparedAlbumFile[]): Promise<AlbumFileResult[]> {
    await this.waitUntilReady();'''
new = '''  async sendAlbum(
    prepared: PreparedAlbumFile[],
    options?: { targetPeer?: any; randomIds?: string[] },
  ): Promise<AlbumFileResult[]> {
    await this.waitUntilReady();'''
assert old in text
text = text.replace(old, new, 1)

old = '''    const emptyResult = (): AlbumFileResult => ({ message_id: 0, file_id: '', access_hash: undefined, size: 0, has_thumbnail: false });
    const results: AlbumFileResult[] = prepared.map(emptyResult);

    if (prepared.length === 0) return results;'''
new = '''    const emptyResult = (): AlbumFileResult => ({ message_id: 0, file_id: '', access_hash: undefined, size: 0, has_thumbnail: false });
    const results: AlbumFileResult[] = prepared.map(emptyResult);

    if (prepared.length === 0) return results;
    if (options?.randomIds && options.randomIds.length !== prepared.length) {
      throw new Error('Album randomIds must match prepared file count');
    }
    const targetPeer = options?.targetPeer ?? new Api.InputPeerSelf();'''
assert old in text
text = text.replace(old, new, 1)

old = '''      const multiMedia = prepared.map((p) => new Api.InputSingleMedia({
        media: p.media,
        randomId: generateRandomBigInt() as any,
        message: '',
      }));
      const updates = await invokeWithTimeout(
        client.invoke(new Api.messages.SendMultiMedia({ peer: new Api.InputPeerSelf(), multiMedia })),'''
new = '''      const multiMedia = prepared.map((p, index) => new Api.InputSingleMedia({
        media: p.media,
        randomId: (options?.randomIds?.[index] ? bigInt(options.randomIds[index]) : generateRandomBigInt()) as any,
        message: '',
      }));
      const updates = await invokeWithTimeout(
        client.invoke(new Api.messages.SendMultiMedia({ peer: targetPeer as any, multiMedia })),'''
assert old in text
text = text.replace(old, new, 1)

old = '''      // Map back by document id (not array position) — Telegram doesn't guarantee order.
      const docIdToMessage = new Map<string, { id: number; accessHash?: unknown }>();
      for (const u of updates.updates ?? []) {
        const doc = u.message?.media?.document;
        if (u.message?.id && doc?.id) docIdToMessage.set(String(doc.id), { id: u.message.id, accessHash: doc.accessHash });
      }
      prepared.forEach((p, i) => {
        const found = docIdToMessage.get(String(p.docId));
        results[i] = found
          ? { message_id: found.id, file_id: String(p.docId), access_hash: found.accessHash ? String(found.accessHash) : undefined, size: p.file.size, has_thumbnail: p.hasThumbnail }
          : emptyResult();
      });'''
new = '''      // Map back by destination media identity, not array position. The persisted
      // registration must use the destination object Telegram actually created,
      // never the uploaded InputFile handle or source media identity.
      const mediaIdToMessage = new Map<string, { id: number; ref: MediaRef }>();
      for (const u of updates.updates ?? []) {
        const message = u.message as Api.Message | undefined;
        const ref = message?.media ? readMedia(message.media) : null;
        if (message?.id && ref) mediaIdToMessage.set(ref.id, { id: message.id, ref });
      }
      prepared.forEach((p, i) => {
        const found = mediaIdToMessage.get(String(p.docId));
        results[i] = found
          ? {
              message_id: found.id,
              file_id: found.ref.id,
              access_hash: found.ref.accessHash ? String(found.ref.accessHash) : undefined,
              size: found.ref.size || p.file.size,
              has_thumbnail: p.hasThumbnail,
              mediaKind: found.ref.kind,
              mediaId: found.ref.id,
              photoVariant: found.ref.kind === 'photo' ? found.ref.fullThumbSize : undefined,
            }
          : emptyResult();
      });'''
assert old in text
text = text.replace(old, new, 1)

old = '''          const message = await this.sendFileLocked({ file: customFile, workers: 1, forceDocument: true }) as Api.Message;
          recordUploadedBytes(this.accountId, p.file.size);
          const media = message.media as any;
          const doc = media?.className === 'MessageMediaDocument' ? media.document : undefined;
          results[i] = doc
            ? { message_id: message.id, file_id: String(doc.id), access_hash: doc.accessHash ? String(doc.accessHash) : undefined, size: p.file.size, has_thumbnail: false }
            : emptyResult();'''
new = '''          const message = await this.sendFileLocked({
            file: customFile,
            workers: 1,
            forceDocument: true,
            ...(options?.randomIds?.[i] ? { randomId: options.randomIds[i] } : {}),
          }, 3, options?.targetPeer ?? 'me') as Api.Message;
          recordUploadedBytes(this.accountId, p.file.size);
          const ref = message.media ? readMedia(message.media) : null;
          results[i] = ref
            ? {
                message_id: message.id,
                file_id: ref.id,
                access_hash: ref.accessHash ? String(ref.accessHash) : undefined,
                size: ref.size || p.file.size,
                has_thumbnail: false,
                mediaKind: ref.kind,
                mediaId: ref.id,
                photoVariant: ref.kind === 'photo' ? ref.fullThumbSize : undefined,
              }
            : emptyResult();'''
assert old in text
text = text.replace(old, new, 1)

start = text.index('  /**\n   * Forward one message into Saved Messages and return the new message.')
end = text.index('\n  /**\n   * DM a login nonce to our bot.', start)
replacement = '''  /** Forward one message to an explicit frozen target using the persisted random id. */
  async forwardToTarget(
    entity: any,
    messageId: number,
    targetPeer: any,
    randomId: string,
  ): Promise<TargetAwareSendResult> {
    await this.waitUntilReady();
    if (!this.client) throw new Error('Client not initialized');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.messageRateLimiter.wait();
        const result = await this.client.forwardMessages(targetPeer, {
          messages: [messageId],
          fromPeer: entity,
          randomId: [bigInt(randomId) as any],
        } as any);
        const message = unwrapForwardedMessage(result, messageId) as Api.Message;
        const ref = message.media ? readMedia(message.media) : null;
        if (!ref) throw new Error(`Forwarded message ${message.id} has no readable media (source message ${messageId})`);
        return {
          messageId: message.id,
          mediaKind: ref.kind,
          mediaId: ref.id,
          size: ref.size,
          accessHash: ref.accessHash ? String(ref.accessHash) : undefined,
          photoVariant: ref.kind === 'photo' ? ref.fullThumbSize : undefined,
          message,
        };
      } catch (err: any) {
        if (isFloodError(err) && attempt < 2) {
          this.penalizeForFlood('forwardMessages', err);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Forward of message ${messageId} failed after retries`);
  }

  /** Legacy Saved Messages wrapper retained for existing pre-channel call sites. */
  async forwardToSaved(entity: any, messageId: number): Promise<Api.Message> {
    const forwarded = await this.forwardToTarget(
      entity,
      messageId,
      'me',
      String(generateRandomBigInt()),
    );
    return forwarded.message;
  }
'''
text = text[:start] + replacement + text[end:]

path.write_text(text)
