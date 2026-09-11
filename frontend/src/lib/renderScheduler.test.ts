import { describe, expect, it, vi } from 'vitest';
import { createRenderScheduler } from './renderScheduler';

function fakeFrames() {
  const pending: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => { pending.push(cb); return pending.length; },
    cancel: () => {},
    flush: () => { const due = pending.splice(0); due.forEach((cb) => cb()); },
    get depth() { return pending.length; },
  };
}

describe('createRenderScheduler', () => {
  it('同一個 frame 內的多次 request 只執行一次', () => {
    const frames = fakeFrames();
    const scheduler = createRenderScheduler(frames.schedule, frames.cancel);
    const render = vi.fn();

    scheduler.request(render);
    scheduler.request(render);
    scheduler.request(render);
    expect(frames.depth).toBe(1);
    expect(render).not.toHaveBeenCalled();

    frames.flush();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('flush 後的新 request 會排入下一個 frame', () => {
    const frames = fakeFrames();
    const scheduler = createRenderScheduler(frames.schedule, frames.cancel);
    const render = vi.fn();

    scheduler.request(render);
    frames.flush();
    scheduler.request(render);
    frames.flush();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('執行的是最後一次傳入的 callback', () => {
    const frames = fakeFrames();
    const scheduler = createRenderScheduler(frames.schedule, frames.cancel);
    const first = vi.fn();
    const last = vi.fn();

    scheduler.request(first);
    scheduler.request(last);
    frames.flush();
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledTimes(1);
  });

  it('cancel 後 flush 不執行任何 callback', () => {
    const frames = fakeFrames();
    const scheduler = createRenderScheduler(frames.schedule, frames.cancel);
    const render = vi.fn();

    scheduler.request(render);
    scheduler.cancel();
    frames.flush();
    expect(render).not.toHaveBeenCalled();
  });
});
