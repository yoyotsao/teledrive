/**
 * Why this matters: gramjs's `forwardMessages` declares `Promise<Api.Message[]>`
 * but at runtime hands back one ARRAY PER SOURCE CHAT, each holding that chat's
 * forwarded messages — `[[msg]]`, not `[msg]`. Reading `result[0].id` therefore
 * yields undefined for every single forward, which is what broke chat import:
 * every media message failed with "returned no message" while the forwards had
 * in fact succeeded on Telegram's side. These asserts pin the real shape.
 */
import { describe, expect, it } from 'vitest';
import { unwrapForwardedMessage } from './forwardResult.ts';

const SOURCE_ID = 1288;
const msg = { id: 5001, media: { className: 'MessageMediaDocument' } };

describe('unwrapForwardedMessage', () => {
  // --- gramjs 的實際形狀：每個來源 chat 一個陣列 -------------------------------
  it('unwraps the nested [[msg]] shape gramjs actually returns', () => {
    expect(unwrapForwardedMessage([[msg]], SOURCE_ID)).toBe(msg);
  });

  // --- 宣告型別的扁平形狀也要接受（gramjs 若修正回傳值就會變成這個） -------------
  it('accepts the flat [msg] shape its TypeScript signature promises', () => {
    expect(unwrapForwardedMessage([msg], SOURCE_ID)).toBe(msg);
  });

  // --- 沒有訊息可回：必須拋錯，且錯誤要指出來源訊息 id --------------------------
  describe('throws, naming the source message, when there is no message to return', () => {
    it.each([
      { label: 'an empty result', result: [] },
      { label: 'a chat chunk that came back with no messages', result: [[]] },
      // gramjs logs "had missing message mapping ... (Message was empty)" and
      // leaves a hole in the array when it cannot map a randomId to a message.
      { label: 'an unmapped message slot', result: [[undefined]] },
      { label: 'a non-array result', result: undefined },
      // --- 回傳的東西必須真的是訊息（有 id），不是別的容器 ---------------------
      { label: 'a slot holding something without an id', result: [[{ media: {} }]] },
    ])('$label', ({ result }) => {
      expect(() => unwrapForwardedMessage(result as never, SOURCE_ID)).toThrow(String(SOURCE_ID));
    });
  });
});
