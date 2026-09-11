export interface RenderScheduler {
  /** 同一個 frame 內重複呼叫只會執行最後一個 callback 一次。 */
  request(fn: () => void): void;
  cancel(): void;
}

/**
 * 把高頻狀態變動合併成每個 animation frame 最多一次重繪。
 * schedule/cancel 可注入，讓這支邏輯不需要瀏覽器就能測試；
 * 實際上傳 callback 不經過這裡，因此不受節流影響。
 */
export function createRenderScheduler(
  schedule: (cb: () => void) => number = requestAnimationFrame,
  cancel: (handle: number) => void = cancelAnimationFrame,
): RenderScheduler {
  let handle: number | null = null;
  let pending: (() => void) | null = null;

  return {
    request(fn) {
      pending = fn;
      if (handle !== null) return;
      handle = schedule(() => {
        handle = null;
        const due = pending;
        pending = null;
        due?.();
      });
    },
    cancel() {
      if (handle !== null) cancel(handle);
      handle = null;
      pending = null;
    },
  };
}
