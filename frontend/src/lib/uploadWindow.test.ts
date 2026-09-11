import { describe, expect, it } from 'vitest';
import { computeWindow } from './uploadWindow';

const base = { total: 1000, rowHeight: 40, viewportHeight: 200, overscan: 2 };

describe('computeWindow', () => {
  it('列表頂部從索引 0 開始，沒有頂部 spacer', () => {
    const w = computeWindow({ ...base, scrollTop: 0 });
    expect(w.startIndex).toBe(0);
    expect(w.topSpacer).toBe(0);
    expect(w.endIndex).toBe(7);   // ceil(200/40) = 5 列 + 2 overscan
    expect(w.bottomSpacer).toBe((1000 - 7) * 40);
  });

  it('中段依 scrollTop 位移並保留 overscan', () => {
    const w = computeWindow({ ...base, scrollTop: 4000 });   // 第 100 列
    expect(w.startIndex).toBe(98);
    expect(w.endIndex).toBe(107);
    expect(w.topSpacer).toBe(98 * 40);
    expect(w.bottomSpacer).toBe((1000 - 107) * 40);
  });

  it('捲到底時 endIndex 不超過 total，bottomSpacer 為 0', () => {
    const w = computeWindow({ ...base, scrollTop: 1000 * 40 - 200 });
    expect(w.endIndex).toBe(1000);
    expect(w.bottomSpacer).toBe(0);
  });

  it('spacer 高度相加後等於完整捲動高度', () => {
    const w = computeWindow({ ...base, scrollTop: 4000 });
    expect(w.topSpacer + (w.endIndex - w.startIndex) * 40 + w.bottomSpacer).toBe(1000 * 40);
  });

  it('項目數少於一個 viewport 時全部渲染', () => {
    const w = computeWindow({ ...base, total: 3, scrollTop: 0 });
    expect(w).toEqual({ startIndex: 0, endIndex: 3, topSpacer: 0, bottomSpacer: 0 });
  });

  it('空清單回傳空範圍', () => {
    expect(computeWindow({ ...base, total: 0, scrollTop: 0 }))
      .toEqual({ startIndex: 0, endIndex: 0, topSpacer: 0, bottomSpacer: 0 });
  });

  it('篩選後清單變短、scrollTop 卻停在舊位置時，仍回傳有內容的範圍而不是空白 viewport', () => {
    const w = computeWindow({ ...base, total: 4, scrollTop: 4000 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(4);
    expect(w.topSpacer).toBe(0);
  });
});
