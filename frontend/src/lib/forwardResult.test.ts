/**
 * Why this matters: gramjs's `forwardMessages` declares `Promise<Api.Message[]>`
 * but at runtime hands back one ARRAY PER SOURCE CHAT, each holding that chat's
 * forwarded messages — `[[msg]]`, not `[msg]`. Reading `result[0].id` therefore
 * yields undefined for every single forward, which is what broke chat import:
 * every media message failed with "returned no message" while the forwards had
 * in fact succeeded on Telegram's side. These asserts pin the real shape.
 */
import { describe, expect, it } from 'vitest';
import { unwrapForwardedMessage, unwrapForwardedMessages } from './forwardResult.ts';

const SOURCE_ID = 1288;
const msg = { id: 5001, media: { className: 'MessageMediaDocument' } };
const msg2 = { id: 5002, media: { className: 'MessageMediaDocument' } };

describe('unwrapForwardedMessages', () => {
  it('unwraps the nested [[msg1, msg2]] shape gramjs returns for one source chat', () => {
    expect(unwrapForwardedMessages([[msg, msg2]], [SOURCE_ID, SOURCE_ID + 1])).toEqual([msg, msg2]);
  });

  it('accepts the flat [msg1, msg2] shape its TypeScript signature promises', () => {
    expect(unwrapForwardedMessages([msg, msg2], [SOURCE_ID, SOURCE_ID + 1])).toEqual([msg, msg2]);
  });

  it('rejects a missing mapped slot instead of shifting later results onto the wrong source item', () => {
    expect(() => unwrapForwardedMessages([[msg, undefined, msg2]], [10, 11, 12])).toThrow('11');
  });

  it('rejects a result-count mismatch before assigning any result', () => {
    expect(() => unwrapForwardedMessages([[msg]], [10, 11])).toThrow(/2.*1|1.*2/);
  });

  it.each([
    { label: 'missing mapped slot', result: [[msg, undefined]], sourceIds: [10, 11] },
    { label: 'result-count mismatch', result: [[msg]], sourceIds: [10, 11] },
  ])('marks $label as a retryable transport-style result', ({ result, sourceIds }) => {
    let caught: any;
    try {
      unwrapForwardedMessages(result, sourceIds);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.response?.status).toBe(503);
  });
});

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
