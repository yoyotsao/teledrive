/**
 * Pure helpers for reading gramjs's forwardMessages result. Deliberately import
 * nothing — not even `telegram` — so they can be bundled and run under node by
 * forwardResult.test.ts.
 */

/**
 * Normalize what `client.forwardMessages` returns for one source chat.
 *
 * GramJS declares `Promise<Api.Message[]>`, but its implementation currently
 * returns one array per source chat, so forwarding multiple messages from one
 * chat yields `[[msg1, msg2, ...]]`. We accept both that observed nested shape
 * and the declared flat shape, then require an exact one-to-one mapping with
 * the supplied source ids. Missing slots are rejected instead of shifting a
 * later result onto the wrong migration item.
 */
export function unwrapForwardedMessages(result: unknown, sourceMessageIds: readonly number[]): any[] {
  const first = Array.isArray(result) ? result[0] : undefined;
  const forwarded = Array.isArray(first) ? first : (Array.isArray(result) ? result : []);
  if (forwarded.length !== sourceMessageIds.length) {
    throw new Error(
      `Forward result count mismatch: expected ${sourceMessageIds.length}, got ${forwarded.length}`,
    );
  }
  return forwarded.map((message, index) => {
    if (!message?.id) {
      throw new Error(`Forward of message ${sourceMessageIds[index]} returned no message`);
    }
    return message;
  });
}

/** Pull one forwarded message while retaining the legacy single-message API. */
export function unwrapForwardedMessage(result: unknown, messageId: number): any {
  try {
    return unwrapForwardedMessages(result, [messageId])[0];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Forward result count mismatch:')) {
      throw new Error(`Forward of message ${messageId} returned no message`);
    }
    throw error;
  }
}
