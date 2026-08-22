/**
 * Pure helper for reading gramjs's forwardMessages result. Deliberately imports
 * nothing — not even `telegram` — so it can be bundled and run under node by
 * forwardResult.selfcheck.ts.
 */

/**
 * Pull the single forwarded message out of what `client.forwardMessages` returns.
 *
 * Its signature says `Promise<Api.Message[]>`, but the implementation pushes ONE
 * ENTRY PER SOURCE CHAT and each entry is itself that chat's array of forwarded
 * messages, so forwarding one message actually yields `[[msg]]`. (The nesting
 * comes from `messages.ForwardMessages` carrying a vector `randomId`, which
 * gramjs auto-fills per id and which sends `_getResponseMessage` down its
 * array-returning branch.) Reading `result[0].id` therefore gets undefined every
 * time — the forward succeeds on Telegram's side and the caller still sees a
 * failure. We accept the flat shape too, so a gramjs release that squares the
 * implementation with the signature doesn't break us back.
 */
export function unwrapForwardedMessage(result: unknown, messageId: number): any {
  const first = Array.isArray(result) ? result[0] : undefined;
  const forwarded = Array.isArray(first) ? first[0] : first;
  if (!forwarded?.id) {
    throw new Error(`Forward of message ${messageId} returned no message`);
  }
  return forwarded;
}
