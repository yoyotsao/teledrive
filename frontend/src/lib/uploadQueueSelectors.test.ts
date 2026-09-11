import { describe, expect, it } from 'vitest';
import { initialUploadQueueState, type UploadItem, type UploadQueueState } from './uploadQueue';
import { selectCounts, selectFinishedLabel, selectOverallPercent, selectVisibleItems } from './uploadQueueSelectors';

function item(over: Partial<UploadItem> & Pick<UploadItem, 'id'>): UploadItem {
  return {
    name: `${over.id}.txt`,
    destination: { rootFolderId: null, relativePath: '', folderResolved: true, resolvedFolderId: null },
    size: 1, lastModified: 1,
    provisionalIdentity: over.id, canonicalIdentity: over.id, mergePendingWith: null,
    contentHash: null, hashSettled: true,
    status: 'queued', progress: 0, attempt: 1,
    errorStage: null, errorMessage: null, statusMessage: null,
    createdAt: 0, updatedAt: 0, completedAt: null,
    ...over,
  };
}

function stateOf(items: UploadItem[], over: Partial<UploadQueueState> = {}): UploadQueueState {
  return {
    ...initialUploadQueueState,
    itemsById: Object.fromEntries(items.map((i) => [i.id, i])),
    order: items.map((i) => i.id),
    ...over,
  };
}

const busy = item({ id: 'busy', status: 'uploading', progress: 40 });
const oldFail = item({ id: 'oldFail', status: 'error', errorStage: 'telegram', errorMessage: 'x', updatedAt: 10 });
const newFail = item({ id: 'newFail', status: 'error', errorStage: 'register', errorMessage: 'y', updatedAt: 20 });
const oldDone = item({ id: 'oldDone', status: 'complete', progress: 100, completedAt: 10 });
const newDone = item({ id: 'newDone', status: 'complete', progress: 100, completedAt: 20 });

describe('selectCounts', () => {
  it('分別數出 active、error、complete 與總數', () => {
    expect(selectCounts(stateOf([busy, oldFail, newFail, oldDone]))).toEqual({
      total: 4, active: 1, error: 2, complete: 1,
    });
  });

  it('mergePendingWith 非 null 的項目不進任何計數', () => {
    const hidden = item({ id: 'hidden', mergePendingWith: 'busy' });
    expect(selectCounts(stateOf([busy, hidden]))).toEqual({ total: 1, active: 1, error: 0, complete: 0 });
  });
});

describe('selectOverallPercent 與 selectFinishedLabel', () => {
  it('以項目數計算，失敗計入已結束', () => {
    expect(selectOverallPercent(stateOf([busy, newFail, oldDone, newDone]))).toBe(75);
    expect(selectFinishedLabel(stateOf([busy, newFail, oldDone, newDone]))).toEqual({ finished: 3, total: 4 });
  });

  it('無項目時為 0%', () => {
    expect(selectOverallPercent(initialUploadQueueState)).toBe(0);
  });

  it('無條件捨去，99.9% 不顯示成 100%', () => {
    const items = [busy, ...Array.from({ length: 999 }, (_, i) => item({ id: `d${i}`, status: 'complete', completedAt: i }))];
    expect(selectOverallPercent(stateOf(items))).toBe(99);
  });
});

describe('selectVisibleItems', () => {
  const all = [oldDone, busy, oldFail, newDone, newFail];

  it('全部檢視：失敗（新到舊）、進行中（加入順序）、完成（新到舊）', () => {
    const s = stateOf(all, { completedCollapsed: false });
    expect(selectVisibleItems(s).map((i) => i.id)).toEqual(['newFail', 'oldFail', 'busy', 'newDone', 'oldDone']);
  });

  it('全部檢視預設收合完成組', () => {
    expect(selectVisibleItems(stateOf(all)).map((i) => i.id)).toEqual(['newFail', 'oldFail', 'busy']);
  });

  it('完成篩選不套用收合', () => {
    const s = stateOf(all, { filter: 'complete', completedCollapsed: true });
    expect(selectVisibleItems(s).map((i) => i.id)).toEqual(['newDone', 'oldDone']);
  });

  it('失敗篩選只給失敗項目', () => {
    expect(selectVisibleItems(stateOf(all, { filter: 'error' })).map((i) => i.id)).toEqual(['newFail', 'oldFail']);
  });

  it('進行中篩選涵蓋 queued / hashing / uploading / registering', () => {
    const items = (['queued', 'hashing', 'uploading', 'registering'] as const).map((status, i) => item({ id: `s${i}`, status }));
    const s = stateOf([...items, oldDone], { filter: 'active' });
    expect(selectVisibleItems(s).map((i) => i.id)).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('搜尋比對檔名，不分大小寫，且作用於完整集合', () => {
    const s = stateOf([item({ id: 'x', name: 'Vacation-03.MP4', status: 'uploading' })], { query: 'vacation' });
    expect(selectVisibleItems(s).map((i) => i.id)).toEqual(['x']);
  });

  it('搜尋比對相對路徑', () => {
    const nested = item({
      id: 'n', name: 'photo.jpg', status: 'uploading',
      destination: { rootFolderId: null, relativePath: 'Trip/Day1', folderResolved: true, resolvedFolderId: 'F' },
    });
    expect(selectVisibleItems(stateOf([nested], { query: 'day1' })).map((i) => i.id)).toEqual(['n']);
  });

  it('搜尋有內容時，完成項目不受收合限制', () => {
    const s = stateOf(all, { query: 'newdone', completedCollapsed: true });
    expect(selectVisibleItems(s).map((i) => i.id)).toEqual(['newDone']);
  });

  it('隱藏的合併待確認項目永不出現', () => {
    const hidden = item({ id: 'hidden', name: 'busy.txt', mergePendingWith: 'busy', status: 'uploading' });
    expect(selectVisibleItems(stateOf([busy, hidden])).map((i) => i.id)).toEqual(['busy']);
  });
});
