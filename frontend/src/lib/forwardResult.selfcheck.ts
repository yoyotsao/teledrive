/**
 * Self-check for unwrapForwardedMessage. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/forwardResult.selfcheck.ts | node --input-type=module
 *
 * Why this matters: gramjs's `forwardMessages` declares `Promise<Api.Message[]>`
 * but at runtime hands back one ARRAY PER SOURCE CHAT, each holding that chat's
 * forwarded messages — `[[msg]]`, not `[msg]`. Reading `result[0].id` therefore
 * yields undefined for every single forward, which is what broke chat import:
 * every media message failed with "returned no message" while the forwards had
 * in fact succeeded on Telegram's side. These asserts pin the real shape.
 */
import { unwrapForwardedMessage } from './forwardResult.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

function caught(fn: () => unknown): string {
  try { fn(); } catch (e: any) { return e.message; }
  return '';
}

const msg = { id: 5001, media: { className: 'MessageMediaDocument' } };

// --- gramjs 的實際形狀：每個來源 chat 一個陣列 -------------------------------
{
  check('unwraps the nested [[msg]] shape gramjs actually returns',
    unwrapForwardedMessage([[msg]], 1288) === msg);
}

// --- 宣告型別的扁平形狀也要接受（gramjs 若修正回傳值就會變成這個） -------------
{
  check('accepts the flat [msg] shape its TypeScript signature promises',
    unwrapForwardedMessage([msg], 1288) === msg);
}

// --- 沒有訊息可回：必須拋錯，且錯誤要指出來源訊息 id --------------------------
{
  check('an empty result throws and names the source message',
    caught(() => unwrapForwardedMessage([], 1288)).includes('1288'));
}
{
  check('a chat chunk that came back with no messages throws',
    caught(() => unwrapForwardedMessage([[]], 1288)).includes('1288'));
}
{
  // gramjs logs "had missing message mapping ... (Message was empty)" and leaves
  // a hole in the array when it cannot map a randomId back to a message.
  check('an unmapped message slot throws rather than returning undefined',
    caught(() => unwrapForwardedMessage([[undefined]], 1288)).includes('1288'));
}
{
  check('a non-array result throws',
    caught(() => unwrapForwardedMessage(undefined, 1288)).includes('1288'));
}

// --- 回傳的東西必須真的是訊息（有 id），不是別的容器 -------------------------
{
  check('a slot holding something without an id throws',
    caught(() => unwrapForwardedMessage([[{ media: {} }]], 1288)).includes('1288'));
}

console.log('\nall forwardResult self-checks passed');
