/**
 * Whether the QR login code currently on screen is one Telegram will still
 * accept.
 *
 * Telegram stamps every login token with an absolute `expires`, measured at
 * ~29s of life. GramJS's signInUserWithQrCode ignores that field entirely and
 * re-exports on a hardcoded 30s timer (QR_CODE_TIMEOUT in
 * node_modules/telegram/client/auth.js), so the code on screen outlives the
 * token it encodes by a second or so at the end of every cycle. Scanning then
 * gets "掃描二維碼發生錯誤" on the phone while the web page — which used to drop
 * `expires` on the floor — still shows a QR that looks perfectly fine.
 *
 * We cannot make GramJS refresh sooner from here, but we can stop presenting a
 * code that is already dead. This is a pure function of (expiry, clock) so the
 * UI can ask it on a timer without it ever becoming a source of truth itself.
 */

/**
 * How far ahead of the deadline a token stops counting as scannable.
 *
 * The phone has to decode the image, then get auth.acceptLoginToken all the way
 * to Telegram. A token with less life left than that round trip will die in
 * flight, so treating it as usable would just move the same error later.
 */
export const SCAN_LATENCY_MS = 1500;

export type QrFreshness = {
  /** Show the QR only when this is true. */
  usable: boolean;
  /** Whole seconds left before the deadline, floored at 0. For display. */
  secondsLeft: number;
};

/**
 * @param expiresAtUnixSec Telegram's `expires` for the current token; 0 when no
 *   token has arrived yet.
 * @param nowMs The caller's clock, passed in so this stays pure and testable.
 */
export function qrFreshness(expiresAtUnixSec: number, nowMs: number): QrFreshness {
  if (expiresAtUnixSec <= 0) return { usable: false, secondsLeft: 0 };

  const remainingMs = expiresAtUnixSec * 1000 - nowMs;
  return {
    usable: remainingMs > SCAN_LATENCY_MS,
    secondsLeft: Math.max(0, Math.ceil(remainingMs / 1000)),
  };
}
