import { describe, expect, it } from 'vitest';
import {
  createUploadQueuePublisher,
  createUploadQueueStore,
  initialUploadQueueState,
  safeErrorMessage,
  uploadQueueReducer as reduce,
  type UploadAction,
  type UploadQueueState,
} from './uploadQueue';
import { createRenderScheduler } from './renderScheduler';
import type { UploadDestination } from './uploadIdentity';

const resolvedTo = (folderId: string | null): UploadDestination => ({
  rootFolderId: folderId, relativePath: '', folderResolved: true, resolvedFolderId: folderId,
});
const unresolved = (rootFolderId: string | null, relativePath: string): UploadDestination => ({
  rootFolderId, relativePath, folderResolved: false, resolvedFolderId: null,
});

function run(state: UploadQueueState, ...actions: UploadAction[]): UploadQueueState {
  return actions.reduce(reduce, state);
}

const enqueue = (id: string, name: string, destination: UploadDestination, over: Partial<{ size: number; lastModified: number }> = {}): UploadAction =>
  ({ type: 'enqueue', id, name, destination, size: over.size ?? 100, lastModified: over.lastModified ?? 1, now: 1000 });

const settleHash = (id: string, attempt: number, contentHash: string | null): UploadAction =>
  ({ type: 'setHash', id, attempt, contentHash, now: 1001 });

const resolveFolder = (id: string, attempt: number, resolvedFolderId: string | null): UploadAction =>
  ({ type: 'setResolved', id, attempt, resolvedFolderId, now: 1001 });

describe('enqueue', () => {
  it('沒有候選時項目立即可見', () => {
    const s = run(initialUploadQueueState, enqueue('a', 'a.txt', resolvedTo(null)));
    expect(s.order).toEqual(['a']);
    expect(s.itemsById.a.mergePendingWith).toBeNull();
    expect(s.itemsById.a.status).toBe('queued');
    expect(s.itemsById.a.attempt).toBe(1);
    expect(s.itemsById.a.progress).toBe(0);
  });

  it('provisional identity 命中既有項目時，新項目掛 mergePendingWith 且不改寫原項目', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      settleHash('a', 1, 'H1:100'),
      { type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: '連線中斷', now: 1002 },
    );
    const before = s.itemsById.a;

    s = reduce(s, enqueue('b', 'a.txt', resolvedTo(null)));

    expect(s.itemsById.b.mergePendingWith).toBe('a');
    // 原失敗列一個欄位都沒有被碰。
    expect(s.itemsById.a).toEqual(before);
  });
});

describe('身分確認閘門', () => {
  const failedA = () => run(initialUploadQueueState,
    enqueue('a', 'a.txt', resolvedTo(null)),
    settleHash('a', 1, 'H1:100'),
    { type: 'fail', id: 'a', attempt: 1, stage: 'register', message: 'boom', now: 1002 },
  );

  it('canonical 相同且原項目為 error：併入原 id，attempt 加一，錯誤清除', () => {
    let s = reduce(failedA(), enqueue('b', 'a.txt', resolvedTo(null)));
    s = reduce(s, settleHash('b', 1, 'H1:100'));

    expect(s.order).toEqual(['a']);
    expect(s.itemsById.b).toBeUndefined();
    expect(s.itemsById.a.attempt).toBe(2);
    expect(s.itemsById.a.status).toBe('queued');
    expect(s.itemsById.a.progress).toBe(0);
    expect(s.itemsById.a.errorStage).toBeNull();
    expect(s.itemsById.a.errorMessage).toBeNull();
    expect(s.itemsById.a.completedAt).toBeNull();
    expect(s.resolutions.b).toEqual({ outcome: 'merged', targetId: 'a', attempt: 2 });
  });

  it('canonical 相同但原項目仍在進行中：丟棄新項目，原進度不動', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      settleHash('a', 1, 'H1:100'),
      { type: 'setStatus', id: 'a', attempt: 1, status: 'uploading', now: 1002 },
      { type: 'setProgress', id: 'a', attempt: 1, progress: 63, now: 1003 },
    );
    s = reduce(s, enqueue('b', 'a.txt', resolvedTo(null)));
    s = reduce(s, settleHash('b', 1, 'H1:100'));

    expect(s.order).toEqual(['a']);
    expect(s.itemsById.a.progress).toBe(63);
    expect(s.itemsById.a.attempt).toBe(1);
    expect(s.resolutions.b).toEqual({ outcome: 'discarded' });
  });

  it('canonical 相同但原項目已完成：不合併，新項目成為獨立一列', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      settleHash('a', 1, 'H1:100'),
      { type: 'complete', id: 'a', attempt: 1, now: 1002 },
    );
    s = reduce(s, enqueue('b', 'a.txt', resolvedTo(null)));
    s = reduce(s, settleHash('b', 1, 'H1:100'));

    expect(s.order).toEqual(['a', 'b']);
    expect(s.itemsById.b.mergePendingWith).toBeNull();
    expect(s.resolutions.b).toEqual({ outcome: 'own', targetId: 'b', attempt: 1 });
  });

  it('canonical 不同：拆成兩列，原失敗項目一個欄位都沒變', () => {
    const s0 = failedA();
    const before = s0.itemsById.a;
    let s = reduce(s0, enqueue('b', 'a.txt', resolvedTo(null)));
    s = reduce(s, settleHash('b', 1, 'H2:100'));

    expect(s.order).toEqual(['a', 'b']);
    expect(s.itemsById.a).toEqual(before);
    expect(s.itemsById.b.mergePendingWith).toBeNull();
    expect(s.itemsById.b.attempt).toBe(1);
  });

  it('同一資料夾內容相同但檔名不同：兩列都成立，第二個不被忽略', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo('F1')),
      enqueue('b', 'b.txt', resolvedTo('F1')),
      settleHash('a', 1, 'SAME:100'),
      settleHash('b', 1, 'SAME:100'),
    );
    expect(s.order).toEqual(['a', 'b']);
    expect(s.itemsById.b.mergePendingWith).toBeNull();
    expect(s.resolutions.b).toEqual({ outcome: 'own', targetId: 'b', attempt: 1 });
  });

  it('資料夾解析完成前不算 canonical identity，也不做任何合併決定', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', unresolved(null, 'A')),
      settleHash('a', 1, 'H1:100'),
    );
    expect(s.itemsById.a.canonicalIdentity).toBeNull();
    expect(s.resolutions.a).toBeUndefined();

    s = reduce(s, resolveFolder('a', 1, 'F_A'));
    expect(s.itemsById.a.canonicalIdentity).not.toBeNull();
    expect(s.resolutions.a).toEqual({ outcome: 'own', targetId: 'a', attempt: 1 });
  });

  it('跨入口重試：拖入資料夾 A 的失敗檔案，改為進入 A 後拖入時合併為同一列', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', unresolved(null, 'A')),
      settleHash('a', 1, 'H1:100'),
      resolveFolder('a', 1, 'F_A'),
      { type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: 'boom', now: 1002 },
    );
    // provisional identity 不同（rootFolderId/relativePath 都不同），
    // 所以進來時沒有候選，但 canonical 解析後仍必須合併。
    s = reduce(s, enqueue('b', 'a.txt', resolvedTo('F_A')));
    expect(s.itemsById.b.mergePendingWith).toBeNull();

    s = reduce(s, settleHash('b', 1, 'H1:100'));
    expect(s.order).toEqual(['a']);
    expect(s.itemsById.a.attempt).toBe(2);
    expect(s.resolutions.b).toEqual({ outcome: 'merged', targetId: 'a', attempt: 2 });
  });

  it('較早完成的 canonical match 不得遮蔽較新的 active match', () => {
    let s = run(initialUploadQueueState,
      enqueue('complete', 'a.txt', resolvedTo(null)),
      settleHash('complete', 1, 'H1:100'),
      { type: 'complete', id: 'complete', attempt: 1, now: 1002 },
      enqueue('active', 'a.txt', resolvedTo(null)),
      settleHash('active', 1, 'H1:100'),
      { type: 'setStatus', id: 'active', attempt: 1, status: 'uploading', now: 1003 },
      enqueue('new', 'a.txt', resolvedTo(null)),
    );

    s = reduce(s, settleHash('new', 1, 'H1:100'));

    expect(s.order).toEqual(['complete', 'active']);
    expect(s.itemsById.active.status).toBe('uploading');
    expect(s.resolutions.new).toEqual({ outcome: 'discarded' });
  });

  it('較早完成的 canonical match 不得遮蔽較新的 error match', () => {
    let s = run(initialUploadQueueState,
      enqueue('complete', 'a.txt', resolvedTo(null)),
      settleHash('complete', 1, 'H1:100'),
      { type: 'complete', id: 'complete', attempt: 1, now: 1002 },
      enqueue('error', 'a.txt', resolvedTo(null)),
      settleHash('error', 1, 'H1:100'),
      { type: 'fail', id: 'error', attempt: 1, stage: 'telegram', message: 'boom', now: 1003 },
      enqueue('new', 'a.txt', resolvedTo(null)),
    );

    s = reduce(s, settleHash('new', 1, 'H1:100'));

    expect(s.order).toEqual(['complete', 'error']);
    expect(s.itemsById.error).toMatchObject({ status: 'queued', attempt: 2, progress: 0 });
    expect(s.resolutions.new).toEqual({ outcome: 'merged', targetId: 'error', attempt: 2 });
  });
});

describe('mutable upload queue store', () => {
  it('keeps the earliest eligible provisional candidate after an earlier row updates', () => {
    const store = createUploadQueueStore();
    store.dispatch(enqueue('a', 'a.txt', resolvedTo(null)));
    store.dispatch(enqueue('b', 'a.txt', resolvedTo(null)));
    store.dispatch({ type: 'setProgress', id: 'a', attempt: 1, progress: 20, now: 1002 });
    store.dispatch(enqueue('c', 'a.txt', resolvedTo(null)));

    expect(store.snapshot().itemsById.c.mergePendingWith).toBe('a');

    store.dispatch({ type: 'complete', id: 'c', attempt: 1, now: 1003 });
    expect(store.snapshot().itemsById.c.mergePendingWith).toBeNull();
  });

  it('keeps the earliest canonical error candidate after an identity-preserving update', () => {
    const failed = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      settleHash('a', 1, 'H1:100'),
      { type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: 'boom', now: 1002 },
    );
    const a = failed.itemsById.a;
    const store = createUploadQueueStore({
      ...failed,
      itemsById: { a, b: { ...a, id: 'b', createdAt: 1001, updatedAt: 1001 } },
      order: ['a', 'b'],
      resolutions: {},
    });

    store.dispatch(settleHash('a', 1, 'H1:100'));
    store.dispatch(enqueue('c', 'a.txt', resolvedTo(null)));
    const settled = store.dispatch(settleHash('c', 1, 'H1:100'));

    expect(settled.resolutions.c).toEqual({ outcome: 'merged', targetId: 'a', attempt: 2 });
  });

  it('keeps the earliest queue slot when a rehydrated active canonical row becomes an error', () => {
    const active = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      settleHash('a', 1, 'H1:100'),
      { type: 'setStatus', id: 'a', attempt: 1, status: 'uploading', now: 1002 },
    ).itemsById.a;
    const store = createUploadQueueStore({
      ...initialUploadQueueState,
      itemsById: {
        a: active,
        b: { ...active, id: 'b', status: 'error', errorStage: 'telegram', errorMessage: 'boom', createdAt: 1001, updatedAt: 1001 },
      },
      order: ['a', 'b'],
    });

    store.dispatch({ type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: 'later failure', now: 1003 });
    store.dispatch(enqueue('c', 'a.txt', resolvedTo(null)));
    const settled = store.dispatch(settleHash('c', 1, 'H1:100'));

    expect(settled.resolutions.c).toEqual({ outcome: 'merged', targetId: 'a', attempt: 2 });
  });

  it('keeps large-queue updates in the working store until a snapshot is requested', () => {
    const accesses = { lookup: 0, scan: 0 };
    const store = createUploadQueueStore(initialUploadQueueState, {
      onItemsByIdAccess: (access) => { accesses[access] += 1; },
    });
    for (let index = 0; index < 2_000; index += 1) {
      store.dispatch(enqueue(`item-${index}`, `${index}.txt`, resolvedTo(null)));
    }
    const before = store.getState();
    const firstSnapshot = store.snapshot();

    accesses.lookup = 0;
    accesses.scan = 0;
    store.dispatch({ type: 'setProgress', id: 'item-1999', attempt: 1, progress: 35, now: 1002 });

    expect(store.getState().itemsById).toBe(before.itemsById);
    expect(store.getState().order).toBe(before.order);
    expect(accesses.lookup).toBeGreaterThan(0);
    expect(accesses.lookup).toBeLessThanOrEqual(2);
    expect(accesses.scan).toBe(0);
    expect(firstSnapshot.itemsById['item-1999'].progress).toBe(0);
    expect(store.snapshot().itemsById['item-1999'].progress).toBe(35);
  });

  it('publishes one immutable snapshot for many updates in one animation frame', () => {
    const callbacks = new Map<number, () => void>();
    let nextFrame = 1;
    const scheduler = createRenderScheduler(
      (callback) => { const frame = nextFrame; nextFrame += 1; callbacks.set(frame, callback); return frame; },
      (frame) => { callbacks.delete(frame); },
    );
    const store = createUploadQueueStore();
    const published: UploadQueueState[] = [];
    const publisher = createUploadQueuePublisher(store, scheduler, (snapshot) => published.push(snapshot));

    publisher.dispatch(enqueue('a', 'a.txt', resolvedTo(null)));
    publisher.dispatch({ type: 'setProgress', id: 'a', attempt: 1, progress: 20, now: 1002 });
    publisher.dispatch({ type: 'setProgress', id: 'a', attempt: 1, progress: 40, now: 1003 });

    expect(callbacks.size).toBe(1);
    expect(published).toEqual([]);
    callbacks.values().next().value?.();
    expect(published).toHaveLength(1);
    expect(published[0].itemsById.a.progress).toBe(40);

    publisher.dispatch({ type: 'setProgress', id: 'a', attempt: 1, progress: 60, now: 1004 });
    expect(published[0].itemsById.a.progress).toBe(40);
  });
});

describe('attempt 隔離', () => {
  const retried = () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      settleHash('a', 1, 'H1:100'),
      { type: 'setStatus', id: 'a', attempt: 1, status: 'uploading', now: 1002 },
      { type: 'setProgress', id: 'a', attempt: 1, progress: 90, now: 1003 },
      { type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: 'boom', now: 1004 },
    );
    s = reduce(s, enqueue('b', 'a.txt', resolvedTo(null)));
    return reduce(s, settleHash('b', 1, 'H1:100'));   // 併入 a，attempt = 2
  };

  it('失敗時保留最後已知百分比', () => {
    const s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      { type: 'setProgress', id: 'a', attempt: 1, progress: 90, now: 1003 },
      { type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: 'boom', now: 1004 },
    );
    expect(s.itemsById.a.progress).toBe(90);
    expect(s.itemsById.a.status).toBe('error');
  });

  it('新 attempt 從 0% 起算，不沿用上一次的 90%', () => {
    expect(retried().itemsById.a.attempt).toBe(2);
    expect(retried().itemsById.a.progress).toBe(0);
  });

  it('舊 attempt 遲到的 setProgress 不影響新 attempt', () => {
    const s = reduce(retried(), { type: 'setProgress', id: 'a', attempt: 1, progress: 95, now: 1005 });
    expect(s.itemsById.a.progress).toBe(0);
  });

  it('舊 attempt 遲到的 fail 不把已重新排隊的項目打回錯誤', () => {
    const s = reduce(retried(), { type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: 'late', now: 1005 });
    expect(s.itemsById.a.status).toBe('queued');
    expect(s.itemsById.a.errorMessage).toBeNull();
  });

  it('舊 attempt 遲到的 complete 不把項目標成完成', () => {
    const s = reduce(retried(), { type: 'complete', id: 'a', attempt: 1, now: 1005 });
    expect(s.itemsById.a.status).toBe('queued');
    expect(s.itemsById.a.completedAt).toBeNull();
  });
});

describe('進度守則', () => {
  const uploading = () => run(initialUploadQueueState,
    enqueue('a', 'a.txt', resolvedTo(null)),
    { type: 'setStatus', id: 'a', attempt: 1, status: 'uploading', now: 1002 },
    { type: 'setProgress', id: 'a', attempt: 1, progress: 50, now: 1003 },
  );

  it('同一 attempt 內不得倒退', () => {
    const s = reduce(uploading(), { type: 'setProgress', id: 'a', attempt: 1, progress: 20, now: 1004 });
    expect(s.itemsById.a.progress).toBe(50);
  });

  it('帳號遷移可在同一個有效 attempt 受控地回退進度並顯示重傳訊息', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      { type: 'setStatus', id: 'a', attempt: 1, status: 'uploading', now: 1002 },
      { type: 'setProgress', id: 'a', attempt: 1, progress: 60, now: 1003 },
    );
    s = reduce(s, {
      type: 'migrationProgressReset', id: 'a', attempt: 1, progress: 25,
      message: '重新分派上傳帳號，該區段將從頭重傳', now: 1004,
    });
    expect(s.itemsById.a.progress).toBe(25);
    expect(s.itemsById.a.statusMessage).toBe('重新分派上傳帳號，該區段將從頭重傳');

    s = reduce(s, { type: 'setProgress', id: 'a', attempt: 1, progress: 20, now: 1005 });
    expect(s.itemsById.a.progress).toBe(25);
  });

  it('帳號遷移回退的百分比限制在未完成範圍', () => {
    const s = reduce(uploading(), {
      type: 'migrationProgressReset', id: 'a', attempt: 1, progress: 100,
      message: '重新分派上傳帳號，該區段將從頭重傳', now: 1004,
    });
    expect(s.itemsById.a.progress).toBe(99);
  });

  it('過期 attempt 拒絕帳號遷移回退', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      settleHash('a', 1, 'H1:100'),
      { type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: 'boom', now: 1003 },
    );
    s = reduce(s, enqueue('b', 'a.txt', resolvedTo(null)));
    s = reduce(s, settleHash('b', 1, 'H1:100'));
    s = reduce(s, {
      type: 'migrationProgressReset', id: 'a', attempt: 1, progress: 25,
      message: '重新分派上傳帳號，該區段將從頭重傳', now: 1005,
    });
    expect(s.itemsById.a.progress).toBe(0);
    expect(s.itemsById.a.statusMessage).toBeNull();
  });

  it('terminal 項目拒絕帳號遷移回退', () => {
    const terminal = reduce(uploading(), { type: 'complete', id: 'a', attempt: 1, now: 1010 });
    const s = reduce(terminal, {
      type: 'migrationProgressReset', id: 'a', attempt: 1, progress: 25,
      message: '重新分派上傳帳號，該區段將從頭重傳', now: 1011,
    });
    expect(s).toBe(terminal);
  });

  it('complete 會清除帳號遷移訊息', () => {
    const migrating = reduce(uploading(), {
      type: 'migrationProgressReset', id: 'a', attempt: 1, progress: 25,
      message: '重新分派上傳帳號，該區段將從頭重傳', now: 1004,
    });
    const s = reduce(migrating, { type: 'complete', id: 'a', attempt: 1, now: 1010 });
    expect(s.itemsById.a.statusMessage).toBeNull();
  });

  it('fail 會清除帳號遷移訊息', () => {
    const migrating = reduce(uploading(), {
      type: 'migrationProgressReset', id: 'a', attempt: 1, progress: 25,
      message: '重新分派上傳帳號，該區段將從頭重傳', now: 1004,
    });
    const s = reduce(migrating, { type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: 'boom', now: 1010 });
    expect(s.itemsById.a.statusMessage).toBeNull();
  });

  it('新檔案重試會清除帳號遷移訊息', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      settleHash('a', 1, 'H1:100'),
      { type: 'setStatus', id: 'a', attempt: 1, status: 'uploading', now: 1002 },
      { type: 'setProgress', id: 'a', attempt: 1, progress: 50, now: 1003 },
    );
    s = reduce(s, {
      type: 'migrationProgressReset', id: 'a', attempt: 1, progress: 25,
      message: '重新分派上傳帳號，該區段將從頭重傳', now: 1004,
    });
    s = reduce(s, { type: 'fail', id: 'a', attempt: 1, stage: 'telegram', message: 'boom', now: 1005 });
    s = reduce(s, enqueue('b', 'a.txt', resolvedTo(null)));
    s = reduce(s, settleHash('b', 1, 'H1:100'));
    expect(s.itemsById.a.attempt).toBe(2);
    expect(s.itemsById.a.statusMessage).toBeNull();
  });

  it('百分比相同時回傳同一個 state 物件，讓外層跳過重繪', () => {
    const s0 = uploading();
    expect(reduce(s0, { type: 'setProgress', id: 'a', attempt: 1, progress: 50, now: 1004 })).toBe(s0);
  });

  it('complete 固定為 100% 並記錄完成時間', () => {
    const s = reduce(uploading(), { type: 'complete', id: 'a', attempt: 1, now: 1010 });
    expect(s.itemsById.a.progress).toBe(100);
    expect(s.itemsById.a.completedAt).toBe(1010);
  });

  it('terminal 狀態拒絕遲到的 setProgress', () => {
    let s = reduce(uploading(), { type: 'complete', id: 'a', attempt: 1, now: 1010 });
    s = reduce(s, { type: 'setProgress', id: 'a', attempt: 1, progress: 60, now: 1011 });
    expect(s.itemsById.a.progress).toBe(100);
  });

  it('terminal 轉移一律釋放 mergePendingWith，狀態不會卡在隱藏中', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      enqueue('b', 'a.txt', resolvedTo(null)),
    );
    expect(s.itemsById.b.mergePendingWith).toBe('a');
    s = reduce(s, { type: 'complete', id: 'b', attempt: 1, now: 1010 });
    expect(s.itemsById.b.mergePendingWith).toBeNull();
  });
});

describe('clearTerminal', () => {
  const mixed = () => run(initialUploadQueueState,
    enqueue('done', 'd.txt', resolvedTo(null)),
    enqueue('bad', 'e.txt', resolvedTo(null)),
    enqueue('busy', 'f.txt', resolvedTo(null)),
    settleHash('done', 1, 'HD:100'),
    settleHash('bad', 1, 'HB:100'),
    settleHash('busy', 1, 'HS:100'),
    { type: 'complete', id: 'done', attempt: 1, now: 1010 },
    { type: 'fail', id: 'bad', attempt: 1, stage: 'register', message: 'boom', now: 1010 },
    { type: 'setStatus', id: 'busy', attempt: 1, status: 'uploading', now: 1010 },
  );

  it('只移除 complete 與 error，保留所有 active', () => {
    const s = reduce(mixed(), { type: 'clearTerminal' });
    expect(s.order).toEqual(['busy']);
    expect(s.itemsById.done).toBeUndefined();
    expect(s.itemsById.bad).toBeUndefined();
  });

  it('連帶清掉指向已移除項目的錯誤詳情與 resolutions', () => {
    let s = reduce(mixed(), { type: 'setErrorDetail', id: 'bad' });
    s = reduce(s, { type: 'clearTerminal' });
    expect(s.errorDetailId).toBeNull();
    expect(s.resolutions.bad).toBeUndefined();
    expect(s.resolutions.busy).toBeDefined();
  });

  it('清除後再次加入相同檔案，attempt 從 1 開始', () => {
    let s = reduce(mixed(), { type: 'clearTerminal' });
    s = reduce(s, enqueue('again', 'e.txt', resolvedTo(null)));
    expect(s.itemsById.again.attempt).toBe(1);
  });
});

describe('批次隔離', () => {
  it('新批次追加後仍保留舊批次的成功、進行中與失敗項目', () => {
    let s = run(initialUploadQueueState,
      enqueue('done', 'd.txt', resolvedTo(null)),
      enqueue('busy', 'e.txt', resolvedTo(null)),
      enqueue('bad', 'f.txt', resolvedTo(null)),
      { type: 'complete', id: 'done', attempt: 1, now: 1010 },
      { type: 'setStatus', id: 'busy', attempt: 1, status: 'uploading', now: 1010 },
      { type: 'setProgress', id: 'busy', attempt: 1, progress: 30, now: 1010 },
      { type: 'fail', id: 'bad', attempt: 1, stage: 'telegram', message: 'boom', now: 1010 },
    );
    s = run(s, enqueue('n1', 'g.txt', resolvedTo(null)), enqueue('n2', 'h.txt', resolvedTo(null)));

    expect(s.order).toEqual(['done', 'busy', 'bad', 'n1', 'n2']);
    expect(s.itemsById.done.status).toBe('complete');
    expect(s.itemsById.busy.progress).toBe(30);
    expect(s.itemsById.bad.status).toBe('error');
  });

  it('不同批次的非同步 action 只更新指定 ID', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'a.txt', resolvedTo(null)),
      enqueue('b', 'b.txt', resolvedTo(null)),
      { type: 'setStatus', id: 'a', attempt: 1, status: 'uploading', now: 1010 },
      { type: 'setStatus', id: 'b', attempt: 1, status: 'uploading', now: 1010 },
    );
    s = reduce(s, { type: 'setProgress', id: 'a', attempt: 1, progress: 70, now: 1011 });
    expect(s.itemsById.a.progress).toBe(70);
    expect(s.itemsById.b.progress).toBe(0);
  });

  it('同名不同 ID 的進度互不影響（內容不同，故不合併）', () => {
    let s = run(initialUploadQueueState,
      enqueue('a', 'same.txt', resolvedTo(null), { size: 1 }),
      enqueue('b', 'same.txt', resolvedTo(null), { size: 2 }),
      settleHash('a', 1, 'H1:1'),
      settleHash('b', 1, 'H2:2'),
      { type: 'setStatus', id: 'a', attempt: 1, status: 'uploading', now: 1010 },
      { type: 'setStatus', id: 'b', attempt: 1, status: 'uploading', now: 1010 },
    );
    expect(s.order).toEqual(['a', 'b']);
    s = reduce(s, { type: 'setProgress', id: 'b', attempt: 1, progress: 55, now: 1011 });
    expect(s.itemsById.a.progress).toBe(0);
    expect(s.itemsById.b.progress).toBe(55);
  });
});

describe('safeErrorMessage', () => {
  it('保留一般錯誤訊息', () => {
    expect(safeErrorMessage(new Error('中繼資料寫入失敗'))).toBe('中繼資料寫入失敗');
  });

  it('非 Error 值退回通用文字，不寫「失敗」兩個字了事', () => {
    expect(safeErrorMessage(undefined)).toBe('上傳失敗，原因不明');
  });

  it('遮蔽長十六進位／base64 片段，避免洩漏 access hash、session string 或 JWT', () => {
    expect(safeErrorMessage(new Error('access_hash 8773541354821330442 rejected')))
      .toBe('access_hash [已遮蔽] rejected');
    expect(safeErrorMessage(new Error('token eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxfQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXkQ')))
      .toBe('token [已遮蔽]');
  });

  it('截斷過長訊息', () => {
    // 每個字都短到不會被遮蔽（未達 {20,} 與 \d{15,} 門檻），
    // 遮蔽後長度不變，因此真正走到截斷分支——用 'x'.repeat(500) 的話
    // 整串會先被當成一個長片段遮成 [已遮蔽]，永遠測不到截斷。
    const long = 'the quick brown fox jumps over the lazy dog '.repeat(6).trim();
    expect(long.length).toBeGreaterThan(200);
    const result = safeErrorMessage(new Error(long));
    expect(result).toHaveLength(200);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('面板狀態', () => {
  it('使用者手動收合後標記 panelTouched', () => {
    const s = reduce(initialUploadQueueState, { type: 'setPanelMode', mode: 'collapsed', byUser: true });
    expect(s.panelTouched).toBe(true);
  });

  it('非使用者發起的展開不標記 panelTouched', () => {
    const s = reduce(initialUploadQueueState, { type: 'setPanelMode', mode: 'expanded', byUser: false });
    expect(s.panelMode).toBe('expanded');
    expect(s.panelTouched).toBe(false);
  });
});
