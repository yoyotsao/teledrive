/**
 * Restores the FLOOD_WAIT vs FLOOD_PREMIUM_WAIT distinction that GramJS erases.
 *
 * In GramJS 2.26.21 (`errors/RPCErrorList.js`) the error table maps BOTH
 * patterns onto the same class:
 *
 *     [/FLOOD_WAIT_(\d+)/,         FloodWaitError],
 *     [/FLOOD_PREMIUM_WAIT_(\d+)/, FloodWaitError],
 *
 * `RPCMessageToError` matches the raw wire string, then constructs
 * `new Cls({ request, capture })` and drops the string; `FloodWaitError`
 * rebuilds its message as "A wait of N seconds is required (caused by …)" and
 * `FloodError` hardcodes `errorMessage = "FLOOD"`. So nothing on the thrown
 * error says PREMIUM, and a `.includes('PREMIUM')` test can never fire.
 *
 * That distinction is not cosmetic. FLOOD_PREMIUM_WAIT is an account-tier
 * upload cap: the wait it demands does not shrink when we send slower, so the
 * pacer's multiplicative rate cut cannot help — and because the cut is
 * persisted, answering a tier cap with a rate cut keeps the account throttled
 * long after Telegram has stopped throttling it. `AdaptiveRateLimiter.pause()`
 * exists precisely for this case, but it was unreachable.
 *
 * `rpcErrorRe` is an exported Map that `RPCMessageToError` iterates on every
 * call, so remapping the PREMIUM pattern to a tagging subclass restores the
 * distinction with no node_modules patching and no fork. The subclass extends
 * FloodWaitError, so `seconds` and every `instanceof` check keep working.
 */
import { rpcErrorRe, FloodWaitError, RPCMessageToError } from 'telegram/errors';
import { Api } from 'telegram';

/** Set on floods that arrived as FLOOD_PREMIUM_WAIT_N rather than FLOOD_WAIT_N. */
const PREMIUM_TAG = 'isPremiumFlood';

class FloodPremiumWaitError extends FloodWaitError {
  readonly isPremiumFlood = true;
}

let installed = false;

/**
 * Remap the PREMIUM pattern. Idempotent.
 *
 * Returns whether the tag round-trips through `RPCMessageToError` — false means
 * the pattern was not found or the Map is not writable, and premium floods will
 * keep being misread as "too fast".
 *
 * Caveat: a true result only proves THIS module instance is patched. If a
 * bundler ever hands the MTProto sender a separate copy of `telegram/errors`,
 * the sender would keep throwing untagged floods; the `premium=` field that
 * `sendFilePartGated` logs on every real flood is what confirms end to end.
 */
export function installPremiumFloodTag(): boolean {
  if (installed) return true;

  for (const [pattern] of rpcErrorRe) {
    if (String(pattern).includes('FLOOD_PREMIUM_WAIT')) {
      rpcErrorRe.set(pattern, FloodPremiumWaitError);
    }
  }

  const probe = RPCMessageToError(
    { errorCode: 420, errorMessage: 'FLOOD_PREMIUM_WAIT_1' } as unknown as Api.RpcError,
    { className: 'upload.SaveFilePart' } as unknown as Api.AnyRequest,
  );
  installed = isPremiumFlood(probe) && (probe as { seconds?: number }).seconds === 1;

  if (installed) {
    console.log('[GramJS] FLOOD_PREMIUM_WAIT tagging installed');
  } else {
    console.error(
      '[GramJS] FLOOD_PREMIUM_WAIT tagging FAILED to install — tier-cap floods will be ' +
        'misread as "sending too fast" and answered with a persisted rate cut',
    );
  }
  return installed;
}

/** True when this flood is the account-tier upload cap, not a "too fast" signal. */
export function isPremiumFlood(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as Record<string, unknown>)[PREMIUM_TAG] === true) {
    return true;
  }
  // Fallback for GramJS versions that do preserve the wire string.
  const e = err as { errorMessage?: string; message?: string } | null;
  return `${e?.errorMessage ?? ''} ${e?.message ?? ''}`.includes('PREMIUM');
}
