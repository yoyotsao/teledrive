from pathlib import Path

path = Path('frontend/src/lib/gramjs.ts')
text = path.read_bytes().decode('utf-8')
newline = '\r\n' if '\r\n' in text else '\n'

old_import = 'import { unwrapForwardedMessage } from "./forwardResult";'
new_import = 'import { unwrapForwardedMessages } from "./forwardResult";'
if old_import not in text:
    raise SystemExit('forwardResult import marker not found')
text = text.replace(old_import, new_import, 1)

start_marker = '  /** Forward one message to an explicit frozen target using the persisted random id. */'
end_marker = '  /** Legacy Saved Messages wrapper retained for existing pre-channel call sites. */'
start = text.index(start_marker)
end = text.index(end_marker, start)

replacement = '''  /** Forward up to 100 messages to one frozen target with one persisted random id per source item. */
  async forwardBatchToTarget(
    entity: any,
    entries: readonly { messageId: number; randomId: string }[],
    targetPeer: any,
  ): Promise<TargetAwareSendResult[]> {
    if (entries.length < 1 || entries.length > 100) {
      throw new Error(`Forward batch size must be between 1 and 100 messages (got ${entries.length})`);
    }
    await this.waitUntilReady();
    if (!this.client) throw new Error('Client not initialized');

    const sourceMessageIds = entries.map((entry) => entry.messageId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.messageRateLimiter.wait();
        const result = await this.client.forwardMessages(targetPeer, {
          messages: sourceMessageIds,
          fromPeer: entity,
          randomId: entries.map((entry) => bigInt(entry.randomId) as any),
        } as any);
        const messages = unwrapForwardedMessages(result, sourceMessageIds) as Api.Message[];
        return messages.map((message, index) => {
          const ref = message.media ? readMedia(message.media) : null;
          if (!ref) {
            throw new Error(
              `Forwarded message ${message.id} has no readable media (source message ${sourceMessageIds[index]})`,
            );
          }
          return {
            messageId: message.id,
            mediaKind: ref.kind,
            mediaId: ref.id,
            size: ref.size,
            accessHash: ref.accessHash ? String(ref.accessHash) : undefined,
            photoVariant: ref.kind === 'photo' ? ref.fullThumbSize : undefined,
            message,
          };
        });
      } catch (err: any) {
        if (isFloodError(err) && attempt < 2) {
          this.penalizeForFlood('forwardMessages', err);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Forward batch failed after retries (${entries.length} messages)`);
  }

  /** Forward one message using the batch primitive while preserving the existing API. */
  async forwardToTarget(
    entity: any,
    messageId: number,
    targetPeer: any,
    randomId: string,
  ): Promise<TargetAwareSendResult> {
    return (await this.forwardBatchToTarget(
      entity,
      [{ messageId, randomId }],
      targetPeer,
    ))[0];
  }

'''.replace('\n', newline)

text = text[:start] + replacement + text[end:]
path.write_bytes(text.encode('utf-8'))
