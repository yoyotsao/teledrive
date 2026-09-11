# 統一上傳中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以單一、工作階段內持續存在的上傳中心取代 `ChonkyDrive.tsx` 中由每個批次整體覆寫的 `uploadingFiles` 陣列，讓所有上傳入口共用一個佇列、保留全部項目、失敗置頂、相同失敗檔案重試維持一列，並在影片預覽期間收合避讓。

**Architecture:** 先把全部判斷邏輯抽成不依賴 React／GramJS／DOM 的純模組（identity、reducer、selectors、windowing、rAF 排程），用 Vitest 逐一釘死；再以一個 `useUploadQueue` hook 把 reducer 接到 React，hook 的 `dispatch` 同步回傳新的 state snapshot，讓 `ChonkyDrive` 在身分確認後立刻知道要繼續、改用別的 id、還是放棄這個 `File`；最後把 `startUploadBatch()` 與 `uploadFolder()` 兩個入口改成只送出帶 `{ id, attempt }` 的項目層級動作，並以 isolated Playwright 驗證 DOM 行為。

**Tech Stack:** React 18 + TypeScript (strict)、Vite 7、Vitest 4、Playwright 1.59（isolated project，port 5173，`tests/support/fakeDrive.ts` 假後端）

**Spec:** `docs/superpowers/specs/2026-09-06-upload-center-design.md`

## Global Constraints

- **二進位資料不得經過 Python backend。** 上傳／下載一律是瀏覽器 ↔ Telegram CDN via GramJS。本計畫不新增、不修改任何後端路由、SQLite schema、Service Worker 或 Telegram 上傳函式。
- 不改變 Telegram 上傳協定、分段策略、併發數或重試策略。`MAX_UPLOAD_CONCURRENCY = 5`、`CHUNK_SIZE = 512KB`、`MAX_PARTS_PER_FILE = 1000`、`CHUNK_RETRY_COUNT = 3` 全部維持原值。
- 不寫入 SQLite、IndexedDB 或 `localStorage`。上傳中心的項目只活在目前頁面工作階段的記憶體中。
- 不新增虛擬列表套件。windowing 自己算。
- 不新增暫停、取消或手動重試按鈕。重新選取或拖入失敗檔案即代表重試。
- `File`、`Blob` 或位元組資料不得存入 React 顯示狀態。執行中的 `File` 參照由上傳工作層持有，terminal 後釋放。
- 展開面板寬度 **360–420 px**，高度不得超過視窗可用高度的 **65%**。窄於 **640 px** 時改為底部 sheet，左右各 **8 px** 安全間距，最大高度 **60vh**。
- 樣式一律使用既有 `--td-*` 變數（`frontend/src/theme.css`）與 inline style。專案沒有 CSS modules 或 Tailwind，不得引入。
- 上傳中心的清除、重試與項目合併，不得清除、也不得直接增加每日上傳統計。統計仍由 `frontend/src/lib/gramjs.ts` 在傳輸層呼叫 `recordUploadedBytes()` 累計。本計畫不得修改 `uploadStatisticsSync.ts` 或 `uploadStatistics.ts`。
- 錯誤訊息不得包含 session string、access hash、JWT 或其他憑證。
- 所有驗證均自動化。Playwright isolated 層不得觸及 Telegram（`tests/support/fixtures.ts` 已切斷 HTTP 與 WebSocket）。
- 既有 `upload-pipeline.spec.ts`、`upload-refresh.spec.ts`、`upload-statistics.spec.ts` 與 `npm run build` 必須持續通過。

## 與 spec 的兩處刻意差異

Spec 的「元件與責任邊界」把 identity、reducer、selectors 全放在一個 `frontend/src/lib/uploadQueue.ts`。本計畫拆成四個扁平模組（見下方 File Structure），理由是 `frontend/src/lib/` 既有慣例就是一個檔案一個責任、`.test.ts` 與實作並列。責任分配與 spec 完全相同，只是換了檔案邊界。

Spec 的 `UploadDestination.resolvedFolderId: string | null` 無法表達「尚未解析」——`null` 本身就是雲端硬碟根目錄這個合法值。本計畫額外加一個 `folderResolved: boolean`，`false` 代表 `ensureFolder()` 尚未回報。同理 `contentHash: string | null` 的 `null` 是 `hashFileBounded()` 合法的回傳（`frontend/src/lib/uploadPlanner.ts:27` catch 後回 `null`，不算錯誤），所以另加 `hashSettled: boolean`。canonical identity 只在 `folderResolved && hashSettled` 時算得出來。

---

## File Structure

**Create**

- `frontend/src/lib/uploadIdentity.ts` — `UploadDestination` 型別與兩個純函式：`provisionalIdentity()`、`canonicalIdentity()`。不知道 reducer 的存在。
- `frontend/src/lib/uploadIdentity.test.ts`
- `frontend/src/lib/uploadQueue.ts` — `UploadItem`、`UploadQueueState`、`UploadAction`、`uploadQueueReducer()`。純函式。身分確認閘門與 attempt 隔離住在這裡。
- `frontend/src/lib/uploadQueue.test.ts`
- `frontend/src/lib/uploadQueueSelectors.ts` — 篩選、搜尋、排序、計數、整體百分比。只讀 state。
- `frontend/src/lib/uploadQueueSelectors.test.ts`
- `frontend/src/lib/uploadWindow.ts` — `computeWindow()` 固定列高 windowing 數學。
- `frontend/src/lib/uploadWindow.test.ts`
- `frontend/src/lib/renderScheduler.ts` — 以可注入的 scheduler 把高頻更新合併成每個 animation frame 一次。
- `frontend/src/lib/renderScheduler.test.ts`
- `frontend/src/hooks/useUploadQueue.ts` — reducer 的 React 外殼。`dispatch` 同步回傳新 snapshot；保存 active item id → `File` 的參照表並在 terminal 後釋放。
- `frontend/src/components/VirtualUploadList.tsx` — 只渲染 viewport + overscan，不持有上傳業務狀態。
- `frontend/src/components/UploadCenter.tsx` — 展開面板、收合按鈕、篩選、搜尋、錯誤詳情區、清除控制。只消費 snapshot 與 callback，不啟動任何上傳。
- `frontend/tests/isolated/upload-center.spec.ts` — 本功能的 isolated Playwright 規格。

**Modify**

- `frontend/src/components/ChonkyDrive.tsx` — 移除 `UploadRow`（:916）、`uploadingFiles`、`uploadTotals`（:347）、`VISIBLE_MAX`／`visibleFiles`／`addVisible`／`updateVisible`（:1174-1190）與內嵌的上傳面板 JSX（:1802-1843）；改為掛載 `<UploadCenter>` 並在 `startUploadBatch()`、`uploadFolder()` 中送出項目層級動作。

---

## Task 1: identity 純函式

**Files:**
- Create: `frontend/src/lib/uploadIdentity.ts`
- Test: `frontend/src/lib/uploadIdentity.test.ts`

**Interfaces:**
- Consumes: 無。
- Produces: `UploadDestination`、`provisionalIdentity(input): string`、`canonicalIdentity(input): string | null`。Task 2 的 reducer 直接呼叫這兩個函式。

- [ ] **Step 1: 寫失敗的測試**

`frontend/src/lib/uploadIdentity.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { canonicalIdentity, provisionalIdentity, type UploadDestination } from './uploadIdentity';

const dest = (over: Partial<UploadDestination> = {}): UploadDestination => ({
  rootFolderId: null,
  relativePath: '',
  folderResolved: true,
  resolvedFolderId: null,
  ...over,
});

describe('provisionalIdentity', () => {
  const base = { destination: dest(), name: 'a.txt', size: 10, lastModified: 5 };

  it('相同的根目的地、相對路徑、檔名、大小與時間戳記得到相同結果', () => {
    expect(provisionalIdentity(base)).toBe(provisionalIdentity({ ...base }));
  });

  it('檔名不同就不同', () => {
    expect(provisionalIdentity(base)).not.toBe(provisionalIdentity({ ...base, name: 'b.txt' }));
  });

  it('相對路徑不同就不同', () => {
    const other = { ...base, destination: dest({ relativePath: 'sub' }) };
    expect(provisionalIdentity(base)).not.toBe(provisionalIdentity(other));
  });

  it('不受 folderResolved / resolvedFolderId 影響', () => {
    const unresolved = { ...base, destination: dest({ folderResolved: false, resolvedFolderId: null }) };
    const resolved = { ...base, destination: dest({ folderResolved: true, resolvedFolderId: 'F1' }) };
    expect(provisionalIdentity(unresolved)).toBe(provisionalIdentity(resolved));
  });

  it('欄位邊界不會碰撞', () => {
    const a = { ...base, name: 'a', size: 1 };
    const b = { ...base, name: 'a1', size: 0 };
    expect(provisionalIdentity(a)).not.toBe(provisionalIdentity(b));
  });
});

describe('canonicalIdentity', () => {
  const base = {
    id: 'i1',
    destination: dest({ resolvedFolderId: 'F1' }),
    name: 'a.txt',
    contentHash: 'abc:10',
    hashSettled: true,
  };

  it('資料夾未解析時回 null', () => {
    expect(canonicalIdentity({ ...base, destination: dest({ folderResolved: false }) })).toBeNull();
  });

  it('雜湊尚未回報時回 null', () => {
    expect(canonicalIdentity({ ...base, hashSettled: false, contentHash: null })).toBeNull();
  });

  it('目的地、檔名、內容雜湊都相同時相等', () => {
    expect(canonicalIdentity(base)).toBe(canonicalIdentity({ ...base, id: 'i2' }));
  });

  it('同一資料夾內容相同但檔名不同時不相等', () => {
    expect(canonicalIdentity(base)).not.toBe(canonicalIdentity({ ...base, name: 'b.txt' }));
  });

  it('忽略 relativePath，只看 resolvedFolderId（跨入口重試得以合併）', () => {
    const viaFolderDrop = { ...base, destination: dest({ rootFolderId: null, relativePath: 'A', resolvedFolderId: 'F_A' }) };
    const viaInsideFolder = { ...base, destination: dest({ rootFolderId: 'F_A', relativePath: '', resolvedFolderId: 'F_A' }) };
    expect(canonicalIdentity(viaFolderDrop)).toBe(canonicalIdentity(viaInsideFolder));
  });

  it('雜湊已回報但為 null 時，每個項目各自唯一，永不合併', () => {
    const noHash = { ...base, contentHash: null };
    expect(canonicalIdentity(noHash)).not.toBeNull();
    expect(canonicalIdentity(noHash)).not.toBe(canonicalIdentity({ ...noHash, id: 'i2' }));
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx vitest run src/lib/uploadIdentity.test.ts`
Expected: FAIL — `Failed to resolve import "./uploadIdentity"`

- [ ] **Step 3: 寫最小實作**

`frontend/src/lib/uploadIdentity.ts`：

```ts
/**
 * 上傳工作的身分。兩層：provisional identity 只負責找出候選項目，
 * canonical identity 才決定合併。詳見
 * docs/superpowers/specs/2026-09-06-upload-center-design.md 的「身分判定」。
 */

export interface UploadDestination {
  /** 發起這次上傳時的根目的資料夾（拖放目標或當前資料夾）。建立後不可變。 */
  rootFolderId: string | null;
  /** 根目的資料夾內、不含檔名的相對目錄路徑；單檔／多檔上傳為空字串。不可變。 */
  relativePath: string;
  /** ensureFolder() 是否已回報。null 是合法的解析結果（雲端硬碟根目錄），
   *  所以「尚未解析」需要獨立旗標，不能用 null 表示。 */
  folderResolved: boolean;
  /** 解析後的實際目的資料夾 ID。註冊中繼資料一律使用這個值。 */
  resolvedFolderId: string | null;
}

// 檔名與路徑可能包含任何可見字元，用 Unit Separator 當分隔避免欄位邊界碰撞。
const SEP = '\u001f';
const ROOT = '\u0000root';

function folderKey(id: string | null): string {
  return id === null ? ROOT : id;
}

export function provisionalIdentity(input: {
  destination: UploadDestination;
  name: string;
  size: number;
  lastModified: number;
}): string {
  const { rootFolderId, relativePath } = input.destination;
  return [folderKey(rootFolderId), relativePath, input.name, input.size, input.lastModified].join(SEP);
}

/**
 * resolvedFolderId 與 contentHash 都到齊後才算得出來，在那之前回 null。
 * 不含 relativePath——resolvedFolderId 已經編碼了實際位置，這正是跨入口重試
 * 能夠合併的原因。不含 size——sha256File() 回傳格式本身就是 <hex64>:<size>。
 */
export function canonicalIdentity(input: {
  id: string;
  destination: UploadDestination;
  name: string;
  contentHash: string | null;
  hashSettled: boolean;
}): string | null {
  if (!input.destination.folderResolved || !input.hashSettled) return null;
  // 雜湊算不出來就無法證明內容相同，退回每個項目各自唯一。
  const content = input.contentHash ?? `\u0000nohash${SEP}${input.id}`;
  return [folderKey(input.destination.resolvedFolderId), input.name, content].join(SEP);
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd frontend && npx vitest run src/lib/uploadIdentity.test.ts`
Expected: PASS（12 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/uploadIdentity.ts frontend/src/lib/uploadIdentity.test.ts
git commit -m "feat(upload): add provisional and canonical upload identity"
```

---

## Task 2: reducer — enqueue 與身分確認閘門

**Files:**
- Create: `frontend/src/lib/uploadQueue.ts`
- Test: `frontend/src/lib/uploadQueue.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `UploadDestination`、`provisionalIdentity()`、`canonicalIdentity()`。
- Produces:
  - `UploadStatus = 'queued' | 'hashing' | 'uploading' | 'registering' | 'complete' | 'error'`
  - `UploadErrorStage = 'hash' | 'thumbnail' | 'telegram' | 'register'`
  - `UploadItem`、`UploadQueueState`、`UploadAction`、`UploadResolution`
  - `initialUploadQueueState: UploadQueueState`
  - `uploadQueueReducer(state: UploadQueueState, action: UploadAction): UploadQueueState`

  Task 3 在同一個檔案續加 action。Task 4 的 selectors 只讀這些型別。Task 6 的 hook 包裝 `uploadQueueReducer`。

- [ ] **Step 1: 寫失敗的測試**

`frontend/src/lib/uploadQueue.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  initialUploadQueueState,
  safeErrorMessage,
  uploadQueueReducer as reduce,
  type UploadAction,
  type UploadQueueState,
} from './uploadQueue';
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
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx vitest run src/lib/uploadQueue.test.ts`
Expected: FAIL — `Failed to resolve import "./uploadQueue"`

- [ ] **Step 3: 寫最小實作**

`frontend/src/lib/uploadQueue.ts`：

```ts
import { canonicalIdentity, provisionalIdentity, type UploadDestination } from './uploadIdentity';

export type UploadStatus = 'queued' | 'hashing' | 'uploading' | 'registering' | 'complete' | 'error';
export type UploadErrorStage = 'hash' | 'thumbnail' | 'telegram' | 'register';
export type UploadFilter = 'all' | 'active' | 'error' | 'complete';

export interface UploadItem {
  id: string;
  name: string;
  destination: UploadDestination;
  size: number;
  lastModified: number;
  provisionalIdentity: string;
  /** folderResolved && hashSettled 之前為 null。 */
  canonicalIdentity: string | null;
  /** 非 null 時不進列表、不進計數，畫面上由候選項目那一列代表。 */
  mergePendingWith: string | null;
  contentHash: string | null;
  hashSettled: boolean;
  status: UploadStatus;
  progress: number;
  attempt: number;
  errorStage: UploadErrorStage | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/**
 * enqueue 時給的 id 在合併後可能已不存在。呼叫端 dispatch 完就用它查
 * 「這個 File 該繼續做、該改用別的 id 做、還是該放棄」。
 */
export type UploadResolution =
  | { outcome: 'own'; targetId: string; attempt: number }
  | { outcome: 'merged'; targetId: string; attempt: number }
  | { outcome: 'discarded' };

export interface UploadQueueState {
  itemsById: Record<string, UploadItem>;
  order: string[];
  resolutions: Record<string, UploadResolution>;
  filter: UploadFilter;
  query: string;
  completedCollapsed: boolean;
  panelMode: 'expanded' | 'collapsed';
  /** 使用者手動收合過就不再自動展開。 */
  panelTouched: boolean;
  errorDetailId: string | null;
}

export type UploadAction =
  | { type: 'enqueue'; id: string; name: string; size: number; lastModified: number; destination: UploadDestination; now: number }
  | { type: 'setResolved'; id: string; attempt: number; resolvedFolderId: string | null; now: number }
  | { type: 'setHash'; id: string; attempt: number; contentHash: string | null; now: number }
  | { type: 'setStatus'; id: string; attempt: number; status: 'hashing' | 'uploading' | 'registering'; now: number }
  | { type: 'setProgress'; id: string; attempt: number; progress: number; now: number }
  | { type: 'complete'; id: string; attempt: number; now: number }
  | { type: 'fail'; id: string; attempt: number; stage: UploadErrorStage; message: string; now: number }
  | { type: 'setFilter'; filter: UploadFilter }
  | { type: 'setQuery'; query: string }
  | { type: 'toggleCompleted' }
  | { type: 'setPanelMode'; mode: 'expanded' | 'collapsed'; byUser: boolean }
  | { type: 'setErrorDetail'; id: string | null }
  | { type: 'clearTerminal' };

export const initialUploadQueueState: UploadQueueState = {
  itemsById: {},
  order: [],
  resolutions: {},
  filter: 'all',
  query: '',
  completedCollapsed: true,
  panelMode: 'collapsed',
  panelTouched: false,
  errorDetailId: null,
};

const ACTIVE: readonly UploadStatus[] = ['queued', 'hashing', 'uploading', 'registering'];
export const isActive = (item: UploadItem): boolean => ACTIVE.includes(item.status);
export const isVisible = (item: UploadItem): boolean => item.mergePendingWith === null;

/** attempt 不符的非同步動作一律忽略——重試沿用同一個 id。 */
function current(state: UploadQueueState, id: string, attempt: number): UploadItem | null {
  const item = state.itemsById[id];
  if (!item || item.attempt !== attempt) return null;
  return item;
}

function withItem(state: UploadQueueState, item: UploadItem): UploadQueueState {
  return { ...state, itemsById: { ...state.itemsById, [item.id]: item } };
}

/**
 * resolvedFolderId 與 contentHash 都到齊後才跑：算出 canonical identity，
 * 對全佇列查表（不限於 provisional 候選，跨入口重試才能合併），
 * 然後決定合併、丟棄或成為獨立一列。
 */
function resolveIdentity(state: UploadQueueState, id: string): UploadQueueState {
  const item = state.itemsById[id];
  if (!item || item.canonicalIdentity !== null) return state;

  const identity = canonicalIdentity(item);
  if (identity === null) return state;

  const settled = { ...item, canonicalIdentity: identity };
  const match = state.order
    .map((other) => state.itemsById[other])
    .find((other) => other.id !== id && other.canonicalIdentity === identity);

  // 沒有對象，或對象已完成（使用者主動發起的新工作）——成為獨立一列。
  if (!match || match.status === 'complete') {
    return {
      ...withItem(state, { ...settled, mergePendingWith: null }),
      resolutions: { ...state.resolutions, [id]: { outcome: 'own', targetId: id, attempt: settled.attempt } },
    };
  }

  const itemsById = { ...state.itemsById };
  delete itemsById[id];
  const order = state.order.filter((other) => other !== id);

  if (match.status === 'error') {
    itemsById[match.id] = {
      ...match,
      attempt: match.attempt + 1,
      status: 'queued',
      progress: 0,
      errorStage: null,
      errorMessage: null,
      completedAt: null,
      contentHash: settled.contentHash,
      hashSettled: true,
      updatedAt: settled.updatedAt,
    };
    return {
      ...state, itemsById, order,
      errorDetailId: state.errorDetailId === match.id ? null : state.errorDetailId,
      resolutions: { ...state.resolutions, [id]: { outcome: 'merged', targetId: match.id, attempt: match.attempt + 1 } },
    };
  }

  // 仍在進行中——聚焦既有項目，丟棄新項目，原進度完全不動。
  return {
    ...state, itemsById, order,
    resolutions: { ...state.resolutions, [id]: { outcome: 'discarded' } },
  };
}

export function uploadQueueReducer(state: UploadQueueState, action: UploadAction): UploadQueueState {
  switch (action.type) {
    case 'enqueue': {
      const provisional = provisionalIdentity(action);
      const candidate = state.order
        .map((id) => state.itemsById[id])
        .find((item) => item.provisionalIdentity === provisional && item.status !== 'complete');
      const item: UploadItem = {
        id: action.id,
        name: action.name,
        destination: action.destination,
        size: action.size,
        lastModified: action.lastModified,
        provisionalIdentity: provisional,
        canonicalIdentity: null,
        mergePendingWith: candidate ? candidate.id : null,
        contentHash: null,
        hashSettled: false,
        status: 'queued',
        progress: 0,
        attempt: 1,
        errorStage: null,
        errorMessage: null,
        createdAt: action.now,
        updatedAt: action.now,
        completedAt: null,
      };
      return resolveIdentity(
        { ...state, itemsById: { ...state.itemsById, [item.id]: item }, order: [...state.order, item.id] },
        item.id,
      );
    }

    case 'setResolved': {
      const item = current(state, action.id, action.attempt);
      if (!item) return state;
      const next = {
        ...item,
        destination: { ...item.destination, folderResolved: true, resolvedFolderId: action.resolvedFolderId },
        updatedAt: action.now,
      };
      return resolveIdentity(withItem(state, next), item.id);
    }

    case 'setHash': {
      const item = current(state, action.id, action.attempt);
      if (!item) return state;
      const next = { ...item, contentHash: action.contentHash, hashSettled: true, updatedAt: action.now };
      return resolveIdentity(withItem(state, next), item.id);
    }

    default:
      return state;
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd frontend && npx vitest run src/lib/uploadQueue.test.ts`
Expected: 「enqueue」與「身分確認閘門」的 9 個測試 PASS。測試檔中用到的 `setStatus`、`setProgress`、`complete`、`fail` 目前落在 `default` 分支而沒有效果，因此其中三個仍會 FAIL——這是預期的，Task 3 補完。

> 若要在本任務結束時看到全綠，可暫時 `it.skip` 掉 `canonical 相同且原項目為 error`、`canonical 相同但原項目仍在進行中`、`canonical 相同但原項目已完成`、`canonical 不同`、`跨入口重試` 這五個依賴 `fail`/`complete`/`setProgress` 的測試，並在 Task 3 Step 1 解除。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/uploadQueue.ts frontend/src/lib/uploadQueue.test.ts
git commit -m "feat(upload): add upload queue reducer with identity confirmation gate"
```

---

## Task 3: reducer — attempt 隔離、進度守則、清除

**Files:**
- Modify: `frontend/src/lib/uploadQueue.ts`（補完 `uploadQueueReducer` 的 `default` 分支）
- Modify: `frontend/src/lib/uploadQueue.test.ts`（新增 describe 區塊，並解除 Task 2 Step 4 的 `it.skip`）

**Interfaces:**
- Consumes: Task 2 的 `UploadQueueState`、`UploadAction`、`current()`、`withItem()`。
- Produces: `uploadQueueReducer` 完整支援全部 action。Task 6 的 hook 之後只需轉發。

- [ ] **Step 1: 寫失敗的測試**

先解除 Task 2 Step 4 提到的 `it.skip`，再把以下區塊接在 `uploadQueue.test.ts` 末尾：

```ts
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
    expect(safeErrorMessage(new Error('token eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxfQ.abcdef')))
      .toBe('token [已遮蔽]');
  });

  it('截斷過長訊息', () => {
    expect(safeErrorMessage(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(200);
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx vitest run src/lib/uploadQueue.test.ts`
Expected: FAIL — `expected 'queued' to be 'error'` 等等；`setStatus`/`setProgress`/`complete`/`fail`/`clearTerminal` 目前全是 no-op。

- [ ] **Step 3: 寫最小實作**

把 `uploadQueueReducer` 的 `default: return state;` 換成以下分支（`case 'enqueue'`、`'setResolved'`、`'setHash'` 保持不變）：

```ts
    case 'setStatus': {
      const item = current(state, action.id, action.attempt);
      if (!item || !isActive(item)) return state;
      if (item.status === action.status) return state;
      return withItem(state, { ...item, status: action.status, updatedAt: action.now });
    }

    case 'setProgress': {
      const item = current(state, action.id, action.attempt);
      // terminal 狀態拒絕遲到的進度；同一 attempt 內只能前進。
      if (!item || !isActive(item)) return state;
      const progress = Math.min(100, Math.max(0, Math.round(action.progress)));
      if (progress <= item.progress) return state;
      return withItem(state, { ...item, progress, updatedAt: action.now });
    }

    case 'complete': {
      const item = current(state, action.id, action.attempt);
      if (!item || !isActive(item)) return state;
      return withItem(state, {
        ...item,
        status: 'complete',
        progress: 100,
        errorStage: null,
        errorMessage: null,
        completedAt: action.now,
        updatedAt: action.now,
        // 身分尚未確認就結束的項目一律釋放為獨立列，狀態絕不卡在隱藏中。
        mergePendingWith: null,
      });
    }

    case 'fail': {
      const item = current(state, action.id, action.attempt);
      if (!item || !isActive(item)) return state;
      return withItem(state, {
        ...item,
        status: 'error',
        // 失敗前最後已知的百分比原樣保留，用來診斷失敗階段。
        errorStage: action.stage,
        errorMessage: action.message,
        completedAt: null,
        updatedAt: action.now,
        mergePendingWith: null,
      });
    }

    case 'setFilter':
      return state.filter === action.filter ? state : { ...state, filter: action.filter };

    case 'setQuery':
      return state.query === action.query ? state : { ...state, query: action.query };

    case 'toggleCompleted':
      return { ...state, completedCollapsed: !state.completedCollapsed };

    case 'setPanelMode':
      return {
        ...state,
        panelMode: action.mode,
        panelTouched: state.panelTouched || action.byUser,
      };

    case 'setErrorDetail':
      return { ...state, errorDetailId: action.id };

    case 'clearTerminal': {
      const order = state.order.filter((id) => isActive(state.itemsById[id]));
      const kept = new Set(order);
      const itemsById: Record<string, UploadItem> = {};
      for (const id of order) itemsById[id] = state.itemsById[id];
      const resolutions: Record<string, UploadResolution> = {};
      for (const [enqueuedId, resolution] of Object.entries(state.resolutions)) {
        if (resolution.outcome !== 'discarded' && kept.has(resolution.targetId)) {
          resolutions[enqueuedId] = resolution;
        }
      }
      return {
        ...state, itemsById, order, resolutions,
        errorDetailId: state.errorDetailId && kept.has(state.errorDetailId) ? state.errorDetailId : null,
      };
    }
```

再把這支工具函式加在 `uploadQueue.ts` 檔尾。上傳中心會把完整訊息顯示在錯誤詳情區，
所以訊息在進入狀態前就必須先過濾憑證：

```ts
// 20 字元以上的十六進位／base64 片段：access hash、session string、JWT 都長這樣。
const SECRET_LIKE = /[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,}){0,2}/g;
const MAX_MESSAGE = 200;

/** 錯誤訊息不得包含 session string、access hash、JWT 或其他憑證。 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw.trim()) return '上傳失敗，原因不明';
  const masked = raw.replace(SECRET_LIKE, '[已遮蔽]');
  return masked.length > MAX_MESSAGE ? `${masked.slice(0, MAX_MESSAGE - 1)}…` : masked;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd frontend && npx vitest run src/lib/uploadQueue.test.ts`
Expected: PASS（全部 30 個測試，含 Task 2 解除 skip 的五個）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/uploadQueue.ts frontend/src/lib/uploadQueue.test.ts
git commit -m "feat(upload): isolate late attempts and guard terminal upload states"
```

---

## Task 4: selectors — 篩選、搜尋、排序、計數、整體進度

**Files:**
- Create: `frontend/src/lib/uploadQueueSelectors.ts`
- Test: `frontend/src/lib/uploadQueueSelectors.test.ts`

**Interfaces:**
- Consumes: Task 2/3 的 `UploadQueueState`、`UploadItem`、`isActive()`、`isVisible()`。
- Produces:
  - `selectCounts(state): { total: number; active: number; error: number; complete: number }`
  - `selectVisibleItems(state): UploadItem[]`
  - `selectOverallPercent(state): number`
  - `selectFinishedLabel(state): { finished: number; total: number }`

  Task 8 的 `UploadCenter.tsx` 是唯一的消費者。

- [ ] **Step 1: 寫失敗的測試**

`frontend/src/lib/uploadQueueSelectors.test.ts`：

```ts
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
    errorStage: null, errorMessage: null,
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx vitest run src/lib/uploadQueueSelectors.test.ts`
Expected: FAIL — `Failed to resolve import "./uploadQueueSelectors"`

- [ ] **Step 3: 寫最小實作**

`frontend/src/lib/uploadQueueSelectors.ts`：

```ts
import { isActive, isVisible, type UploadItem, type UploadQueueState } from './uploadQueue';

export interface UploadCounts {
  total: number;
  active: number;
  error: number;
  complete: number;
}

function visibleItems(state: UploadQueueState): UploadItem[] {
  return state.order.map((id) => state.itemsById[id]).filter(isVisible);
}

export function selectCounts(state: UploadQueueState): UploadCounts {
  const items = visibleItems(state);
  return {
    total: items.length,
    active: items.filter(isActive).length,
    error: items.filter((i) => i.status === 'error').length,
    complete: items.filter((i) => i.status === 'complete').length,
  };
}

/** 失敗代表該次工作已結束，因此計入完成比例——紅色徽章負責揭露它不是全部成功。 */
export function selectFinishedLabel(state: UploadQueueState): { finished: number; total: number } {
  const { total, error, complete } = selectCounts(state);
  return { finished: error + complete, total };
}

export function selectOverallPercent(state: UploadQueueState): number {
  const { finished, total } = selectFinishedLabel(state);
  if (total === 0) return 0;
  return Math.floor((finished / total) * 100);
}

function matchesQuery(item: UploadItem, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return item.name.toLowerCase().includes(needle)
    || item.destination.relativePath.toLowerCase().includes(needle);
}

/**
 * 依 spec 的固定分組順序攤平成一維陣列：失敗、進行中、完成。
 * 列表本身不插入分組標題，windowing 才能用單一固定列高。
 */
export function selectVisibleItems(state: UploadQueueState): UploadItem[] {
  const query = state.query.trim();
  const pool = visibleItems(state).filter((item) => matchesQuery(item, query));

  const errors = pool.filter((i) => i.status === 'error').sort((a, b) => b.updatedAt - a.updatedAt);
  const actives = pool.filter(isActive);   // pool 已是加入順序
  const completes = pool.filter((i) => i.status === 'complete')
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

  switch (state.filter) {
    case 'error': return errors;
    case 'active': return actives;
    case 'complete': return completes;   // 完成篩選不套用收合
    case 'all': {
      // 搜尋有內容時自動顯示符合的完成項目，不受收合限制。
      const showComplete = !state.completedCollapsed || query.length > 0;
      return showComplete ? [...errors, ...actives, ...completes] : [...errors, ...actives];
    }
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd frontend && npx vitest run src/lib/uploadQueueSelectors.test.ts`
Expected: PASS（14 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/uploadQueueSelectors.ts frontend/src/lib/uploadQueueSelectors.test.ts
git commit -m "feat(upload): add upload queue selectors for filter, search and counts"
```

---

## Task 5: windowing 數學

**Files:**
- Create: `frontend/src/lib/uploadWindow.ts`
- Test: `frontend/src/lib/uploadWindow.test.ts`

**Interfaces:**
- Consumes: 無。
- Produces: `computeWindow(input): UploadWindow`，其中 `UploadWindow = { startIndex: number; endIndex: number; topSpacer: number; bottomSpacer: number }`，`endIndex` 為排除端（`items.slice(startIndex, endIndex)`）。Task 7 的 `VirtualUploadList.tsx` 是唯一消費者。

- [ ] **Step 1: 寫失敗的測試**

`frontend/src/lib/uploadWindow.test.ts`：

```ts
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx vitest run src/lib/uploadWindow.test.ts`
Expected: FAIL — `Failed to resolve import "./uploadWindow"`

- [ ] **Step 3: 寫最小實作**

`frontend/src/lib/uploadWindow.ts`：

```ts
export interface UploadWindow {
  startIndex: number;
  /** 排除端：items.slice(startIndex, endIndex)。 */
  endIndex: number;
  topSpacer: number;
  bottomSpacer: number;
}

/**
 * 固定列高的 windowing。不依賴 DOM，因此可以單獨測試。
 * scrollTop 可能落在清單長度之外（剛套用篩選、清單瞬間變短），
 * 此時把視窗夾回清單尾端，避免渲染出空白 viewport。
 */
export function computeWindow(input: {
  total: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan: number;
}): UploadWindow {
  const { total, rowHeight, viewportHeight, overscan } = input;
  if (total <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, topSpacer: 0, bottomSpacer: 0 };
  }

  const rowsInView = Math.ceil(viewportHeight / rowHeight);
  const maxScrollTop = Math.max(0, total * rowHeight - viewportHeight);
  const scrollTop = Math.min(Math.max(0, input.scrollTop), maxScrollTop);

  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(total, Math.floor(scrollTop / rowHeight) + rowsInView + overscan);

  return {
    startIndex,
    endIndex,
    topSpacer: startIndex * rowHeight,
    bottomSpacer: (total - endIndex) * rowHeight,
  };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd frontend && npx vitest run src/lib/uploadWindow.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/uploadWindow.ts frontend/src/lib/uploadWindow.test.ts
git commit -m "feat(upload): add fixed-row-height windowing math"
```

---

## Task 6: rAF 合併排程器

**Files:**
- Create: `frontend/src/lib/renderScheduler.ts`
- Test: `frontend/src/lib/renderScheduler.test.ts`

**Interfaces:**
- Consumes: 無。
- Produces: `createRenderScheduler(schedule?): { request(fn: () => void): void; cancel(): void }`。`schedule` 預設為 `requestAnimationFrame`，測試時注入假的。Task 7 的 hook 用它把高頻 `setProgress` 造成的重繪合併成每個 animation frame 一次。

- [ ] **Step 1: 寫失敗的測試**

`frontend/src/lib/renderScheduler.test.ts`：

```ts
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx vitest run src/lib/renderScheduler.test.ts`
Expected: FAIL — `Failed to resolve import "./renderScheduler"`

- [ ] **Step 3: 寫最小實作**

`frontend/src/lib/renderScheduler.ts`：

```ts
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
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd frontend && npx vitest run src/lib/renderScheduler.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/renderScheduler.ts frontend/src/lib/renderScheduler.test.ts
git commit -m "feat(upload): add animation-frame render scheduler"
```

---

## Task 7: 第一個垂直切片 — hook、UI 骨架、兩個入口全部改接佇列

這是第一個能跑 Playwright 的任務，也是唯一不能拆的任務：舊面板一旦移除，`startUploadBatch()` 與 `uploadFolder()` 必須在同一次提交裡改完，否則資料夾上傳會沒有 UI。

**Files:**
- Create: `frontend/src/hooks/useUploadQueue.ts`
- Create: `frontend/src/components/VirtualUploadList.tsx`
- Create: `frontend/src/components/UploadCenter.tsx`
- Create: `frontend/tests/isolated/upload-center.spec.ts`
- Modify: `frontend/src/components/ChonkyDrive.tsx`

**Interfaces:**
- Consumes: Task 1–6 全部。
- Produces:
  - `useUploadQueue(): UploadQueueApi`，其中
    ```ts
    interface UploadQueueApi {
      state: UploadQueueState;
      dispatch: (action: UploadAction) => UploadQueueState;   // 同步回傳新 snapshot
      enqueueFile: (file: File, destination: UploadDestination) => string;   // 回傳新 id
      holdFile: (id: string, file: File) => void;
      releaseFile: (id: string) => void;
    }
    ```
  - `<UploadCenter state isVideoPreviewOpen onFilter onQuery onToggleCompleted onPanelMode onErrorDetail onClearTerminal />`
  - `<VirtualUploadList items rowHeight height renderRow />`
  - `data-testid`：`upload-center`、`upload-center-collapsed`、`upload-center-row`、`upload-center-title`、`upload-center-clear`
- Task 8–11 只擴充這些元件，不改介面。

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/isolated/upload-center.spec.ts`：

```ts
import { createHash } from 'node:crypto';
import { expect, test } from '../support/fixtures.ts';

/** 與 frontend/src/lib/hashFile.ts 的 sha256File() 同格式：<hex64>:<size>。 */
function fingerprint(bytes: Buffer): string {
  return `${createHash('sha256').update(bytes).digest('hex')}:${bytes.length}`;
}

/** 讓假後端把這些內容回報成「已存在」，走去重路徑直接註冊，不碰 Telegram。 */
async function dedupeAll(page: import('@playwright/test').Page, drive: any, sources: Map<string, Buffer>) {
  let seq = 0;
  for (const [id] of sources) {
    drive.file(id, {
      filename: `${id}.bin`, filesize: sources.get(id)!.length, parent_id: 'hidden-sources',
      telegram_message_id: 900 + (seq += 1), access_hash: `9000${seq}`,
    });
  }
  await page.route('**/api/v1/files/check-hashes', async (route) => {
    const hashes = route.request().postDataJSON().hashes as string[];
    const results: Record<string, unknown[]> = {};
    for (const [id, bytes] of sources) {
      if (hashes.includes(fingerprint(bytes))) results[fingerprint(bytes)] = [drive.get(id)];
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });
  await page.route('**/api/v1/files/register', async (route) => {
    const body = route.request().postDataJSON();
    drive.file(body.file_id, {
      filename: body.filename, filesize: body.filesize, mime_type: body.mime_type ?? null,
      telegram_message_id: body.message_id, access_hash: body.access_hash ?? null,
      parent_id: body.parent_id ?? null, file_hash: body.file_hash ?? null, telegram_user_id: 42,
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(drive.get(body.file_id)) });
  });
}

const center = (page: import('@playwright/test').Page) => page.getByTestId('upload-center');
const rows = (page: import('@playwright/test').Page) => page.getByTestId('upload-center-row');

test('任意時刻只存在一個上傳中心，第二批追加而不取代第一批', async ({ page, openDrive, drive }) => {
  const first = Buffer.from('batch one payload');
  const second = Buffer.from('batch two payload');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', first], ['src-2', second]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: first },
  ]);
  await expect(center(page)).toHaveCount(1);
  await expect(rows(page)).toHaveCount(1);

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'second.txt', mimeType: 'text/plain', buffer: second },
  ]);
  await expect(center(page)).toHaveCount(1);
  await expect(center(page).getByTestId('upload-center-title')).toContainText('/ 2');
});

test('超過 100 個檔案時不刪除早期項目', async ({ page, openDrive, drive }) => {
  const sources = new Map<string, Buffer>();
  const payloads = Array.from({ length: 150 }, (_, i) => Buffer.from(`payload number ${i}`));
  payloads.forEach((bytes, i) => sources.set(`src-${i}`, bytes));

  await openDrive();
  await dedupeAll(page, drive, sources);

  await page.locator('input[type="file"]').first().setInputFiles(
    payloads.map((buffer, i) => ({ name: `file-${String(i).padStart(3, '0')}.txt`, mimeType: 'text/plain', buffer })),
  );

  await expect(center(page).getByTestId('upload-center-title')).toContainText('150 / 150', { timeout: 30_000 });
  // 第 1、第 100、最後一個都還在狀態裡，即使 DOM 只渲染了 viewport。
  expect(await rows(page).count()).toBeLessThan(150);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx playwright test --project=isolated tests/isolated/upload-center.spec.ts`
Expected: FAIL — `expected 1, received 0`（尚無 `upload-center` testid）

- [ ] **Step 3a: 寫 hook**

`frontend/src/hooks/useUploadQueue.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRenderScheduler } from '../lib/renderScheduler';
import type { UploadDestination } from '../lib/uploadIdentity';
import {
  initialUploadQueueState,
  uploadQueueReducer,
  type UploadAction,
  type UploadQueueState,
} from '../lib/uploadQueue';

export interface UploadQueueApi {
  state: UploadQueueState;
  /** 同步套用並回傳新的 snapshot，讓呼叫端立刻讀 state.resolutions[id]。 */
  dispatch: (action: UploadAction) => UploadQueueState;
  enqueueFile: (file: File, destination: UploadDestination) => string;
  holdFile: (id: string, file: File) => void;
  releaseFile: (id: string) => void;
}

export function useUploadQueue(): UploadQueueApi {
  const stateRef = useRef<UploadQueueState>(initialUploadQueueState);
  const [snapshot, setSnapshot] = useState<UploadQueueState>(initialUploadQueueState);
  const scheduler = useRef(createRenderScheduler()).current;
  // File 參照只活在這裡，永遠不進 React 顯示狀態。
  const filesRef = useRef(new Map<string, File>());

  useEffect(() => () => scheduler.cancel(), [scheduler]);

  const dispatch = useCallback((action: UploadAction): UploadQueueState => {
    const next = uploadQueueReducer(stateRef.current, action);
    // reducer 對「百分比沒有前進」等無效更新回傳同一個物件，直接跳過重繪。
    if (next === stateRef.current) return next;
    stateRef.current = next;
    scheduler.request(() => setSnapshot(stateRef.current));
    return next;
  }, [scheduler]);

  const enqueueFile = useCallback((file: File, destination: UploadDestination): string => {
    const id = crypto.randomUUID();
    dispatch({
      type: 'enqueue', id, name: file.name, size: file.size,
      lastModified: file.lastModified, destination, now: Date.now(),
    });
    return id;
  }, [dispatch]);

  const holdFile = useCallback((id: string, file: File) => { filesRef.current.set(id, file); }, []);
  const releaseFile = useCallback((id: string) => { filesRef.current.delete(id); }, []);

  return { state: snapshot, dispatch, enqueueFile, holdFile, releaseFile };
}
```

- [ ] **Step 3b: 寫虛擬列表**

`frontend/src/components/VirtualUploadList.tsx`：

```tsx
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { computeWindow } from '../lib/uploadWindow';
import type { UploadItem } from '../lib/uploadQueue';

interface Props {
  items: UploadItem[];
  rowHeight: number;
  height: number;
  renderRow: (item: UploadItem) => ReactNode;
}

const OVERSCAN = 4;

/** 只渲染 viewport 與 overscan 範圍；不持有任何上傳業務狀態。 */
export function VirtualUploadList({ items, rowHeight, height, renderRow }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // 篩選或搜尋讓清單變短時校正 offset，避免停在空白 viewport。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScrollTop = Math.max(0, items.length * rowHeight - height);
    if (el.scrollTop > maxScrollTop) {
      el.scrollTop = maxScrollTop;
      setScrollTop(maxScrollTop);
    }
  }, [items.length, rowHeight, height]);

  // 不要命名為 window——那會遮蔽全域 window，UploadCenter 還要用它算高度。
  const range = computeWindow({
    total: items.length, rowHeight, viewportHeight: height, scrollTop, overscan: OVERSCAN,
  });

  return (
    <div
      ref={scrollRef}
      data-testid="upload-virtual-list"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ height, overflowY: 'auto', overflowX: 'hidden' }}
    >
      <div style={{ height: range.topSpacer }} />
      {items.slice(range.startIndex, range.endIndex).map((item) => (
        <div key={item.id} data-testid="upload-center-row" style={{ height: rowHeight, boxSizing: 'border-box' }}>
          {renderRow(item)}
        </div>
      ))}
      <div style={{ height: range.bottomSpacer }} />
    </div>
  );
}
```

- [ ] **Step 3c: 寫上傳中心骨架**

`frontend/src/components/UploadCenter.tsx`。本任務只做展開面板與最小列；篩選、搜尋、錯誤詳情在 Task 8，收合按鈕與預覽避讓在 Task 9。

```tsx
import type { UploadItem, UploadQueueState } from '../lib/uploadQueue';
import { selectCounts, selectFinishedLabel, selectVisibleItems } from '../lib/uploadQueueSelectors';
import { VirtualUploadList } from './VirtualUploadList';

export interface UploadCenterProps {
  state: UploadQueueState;
  isVideoPreviewOpen: boolean;
  onPanelMode: (mode: 'expanded' | 'collapsed', byUser: boolean) => void;
  onClearTerminal: () => void;
}

const ROW_HEIGHT = 34;

const STATUS_LABEL: Record<UploadItem['status'], string> = {
  queued: '排隊中', hashing: '計算雜湊', uploading: '上傳中',
  registering: '註冊中', complete: '已完成', error: '失敗',
};

const ERROR_LABEL: Record<NonNullable<UploadItem['errorStage']>, string> = {
  hash: '無法讀取檔案', thumbnail: '縮圖處理失敗', telegram: '上傳失敗', register: '註冊失敗',
};

function Row({ item, showPath }: { item: UploadItem; showPath: boolean }) {
  const icon = item.status === 'complete' ? '✓' : item.status === 'error' ? '✕' : '↻';
  const color = item.status === 'complete' ? '#16a34a'
    : item.status === 'error' ? '#dc2626' : 'var(--td-accent)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: '100%', padding: '0 4px' }}>
      <span aria-hidden style={{ color, flexShrink: 0, fontSize: 13 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--td-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.name}
          {item.attempt > 1 && <span style={{ color: 'var(--td-text-muted)' }}>（第 {item.attempt} 次嘗試）</span>}
        </span>
        {/* 同名檔案才顯示相對路徑，否則每列高度不一致會拆掉 windowing。 */}
        {showPath && item.destination.relativePath !== '' && (
          <span style={{ display: 'block', fontSize: 10, color: 'var(--td-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.destination.relativePath}
          </span>
        )}
      </span>
      <span style={{ flexShrink: 0, fontSize: 11, color: item.status === 'error' ? '#dc2626' : 'var(--td-text-muted)' }}>
        {item.status === 'error'
          ? (item.errorStage ? ERROR_LABEL[item.errorStage] : '上傳失敗')
          : item.status === 'uploading' ? `${item.progress}%` : STATUS_LABEL[item.status]}
      </span>
    </div>
  );
}

export function UploadCenter({ state, onClearTerminal }: UploadCenterProps) {
  const counts = selectCounts(state);
  if (counts.total === 0) return null;

  const label = selectFinishedLabel(state);
  const items = selectVisibleItems(state);
  // 列高必須固定，所以相對路徑只在真的有同名衝突時才出現，
  // 且 ROW_HEIGHT 已預留兩行空間。
  const duplicateNames = new Set(
    items.map((i) => i.name).filter((name, idx, all) => all.indexOf(name) !== idx),
  );
  const listHeight = Math.min(items.length * ROW_HEIGHT, Math.round(window.innerHeight * 0.65) - 120);

  return (
    <div
      data-testid="upload-center"
      role="region"
      aria-label="上傳中心"
      style={{
        position: 'fixed', bottom: 16, right: 16, width: 380, maxWidth: 'calc(100vw - 32px)',
        maxHeight: '65vh', display: 'flex', flexDirection: 'column',
        background: 'var(--td-surface)', border: '1px solid var(--td-border)',
        borderRadius: 8, boxShadow: `0 4px 12px var(--td-shadow)`, zIndex: 900,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--td-border)' }}>
        <span data-testid="upload-center-title" style={{ fontSize: 13, fontWeight: 600, color: 'var(--td-text-strong)' }}>
          上傳中心 {label.finished.toLocaleString()} / {label.total.toLocaleString()}
        </span>
        {counts.error > 0 && (
          <span data-testid="upload-center-error-badge" style={{ fontSize: 12, fontWeight: 600, color: '#dc2626' }}>
            失敗 {counts.error}
          </span>
        )}
      </div>

      <VirtualUploadList
        items={items}
        rowHeight={ROW_HEIGHT}
        height={Math.max(ROW_HEIGHT, listHeight)}
        renderRow={(item) => <Row item={item} showPath={duplicateNames.has(item.name)} />}
      />

      <div style={{ padding: '8px 14px', borderTop: '1px solid var(--td-border)' }}>
        <button
          data-testid="upload-center-clear"
          onClick={onClearTerminal}
          disabled={counts.error + counts.complete === 0}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)', fontSize: 12, padding: 0 }}
        >
          清除已完成與失敗
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3d: 改接 `startUploadBatch()`**

在 `ChonkyDrive.tsx`：刪除 `:347` 的 `uploadTotals`、`:916` 的 `UploadRow` 與 `uploadingFiles` state、`:1802-1843` 的內嵌面板 JSX，並加入：

```tsx
const queue = useUploadQueue();

const currentDestination = useCallback((): UploadDestination => ({
  rootFolderId: currentFolderId,
  relativePath: '',
  folderResolved: true,          // 拖放／挑選路徑不需要建立資料夾
  resolvedFolderId: currentFolderId,
}), [currentFolderId]);
```

`startUploadBatch()` 開頭改成先入列、再確認身分，取代原本的 `setUploadingFiles(initialFiles)` 與 `indexByFile`／`setRowStatus`：

```tsx
const startUploadBatch = async (selectedFiles: File[]): Promise<void> => {
  const destination = currentDestination();
  // 每個 File 先拿到自己的 id；身分確認可能把它併到別的 id 上。
  const enqueued = selectedFiles.map((file) => ({ file, id: queue.enqueueFile(file, destination) }));

  const SINGLE_PATH_SIZE_LIMIT = 10 * 1024 * 1024;
  const albumPipeline = createAlbumPipeline();
  const uploadPromises: Promise<void>[] = [];
  const claimedHashes = new Map<string, Promise<RegisterableExistingPart[] | null>>();

  const routingPromises = enqueued.map(async ({ file, id: enqueuedId }) => {
    queue.dispatch({ type: 'setStatus', id: enqueuedId, attempt: 1, status: 'hashing', now: Date.now() });
    const fileHash = await hashFileBounded(file);

    // 身分確認閘門：這一步之後才知道要用哪個 id、哪個 attempt 做事。
    const settled = queue.dispatch({ type: 'setHash', id: enqueuedId, attempt: 1, contentHash: fileHash, now: Date.now() });
    const resolution = settled.resolutions[enqueuedId];
    if (!resolution || resolution.outcome === 'discarded') return;   // 相同工作已在進行中
    const id = resolution.targetId;
    const attempt = resolution.attempt;
    queue.holdFile(id, file);

    const done = () => { queue.dispatch({ type: 'complete', id, attempt, now: Date.now() }); queue.releaseFile(id); };
    const failed = (stage: UploadErrorStage, err: unknown) => {
      queue.dispatch({ type: 'fail', id, attempt, stage, message: safeErrorMessage(err), now: Date.now() });
      queue.releaseFile(id);
    };
    const onProgress = (pct: number) =>
      queue.dispatch({ type: 'setProgress', id, attempt, progress: pct, now: Date.now() });

    if (fileHash) {
      const checked = await checkFileHashesBounded([fileHash]);
      const existing = checked[fileHash] ?? [];
      const reusable = canonicalExistingParts(existing, file.size);
      if (reusable.length > 0) {
        queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
        uploadPromises.push(
          registerDuplicateParts(file, fileHash, reusable, destination.resolvedFolderId)
            .then(done).catch((err) => failed('register', err)),
        );
        return;
      }
      if (existing.length > 0) {
        console.warn('[Upload] Hash matched but stored copy is incomplete, re-uploading:', file.name);
      }
    }

    let publishParts: (parts: RegisterableExistingPart[] | null) => void = () => {};
    if (fileHash) {
      const claimed = claimedHashes.get(fileHash);
      if (claimed) {
        queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
        uploadPromises.push(
          claimed.then(async (parts) => {
            if (!parts || parts.length === 0) throw new Error('Matching upload failed');
            await registerDuplicateParts(file, fileHash, parts, destination.resolvedFolderId);
            done();
          }).catch((err) => failed('register', err)),
        );
        return;
      }
      claimedHashes.set(fileHash, new Promise((resolve) => { publishParts = resolve; }));
    }

    queue.dispatch({ type: 'setStatus', id, attempt, status: 'uploading', now: Date.now() });

    if (isAlbumEligibleMedia(file) && file.size <= SINGLE_PATH_SIZE_LIMIT) {
      uploadPromises.push(
        albumPipeline.enqueue(file, fileHash, destination.resolvedFolderId, onProgress)
          .then((res) => {
            if (!res) throw new Error('Upload failed');
            publishParts([{
              filesize: res.size, mime_type: file.type || null,
              telegram_message_id: res.message_id, access_hash: res.access_hash,
              part_index: 0, has_thumbnail: res.has_thumbnail, telegram_user_id: res.account_id,
            }]);
            done();
          }).catch((err) => { publishParts(null); failed('telegram', err); }),
      );
      return;
    }

    uploadPromises.push(
      uploadFileToTelegram(file, onProgress, fileHash)
        .then(async (result) => {
          if (!result.alreadyRegistered) {
            queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
            await registerUploadedParts(file, result.fileHash, result.parts, destination.resolvedFolderId);
          }
          publishParts(result.parts.map((part, i) => ({
            filesize: part.size, mime_type: file.type || null,
            telegram_message_id: part.message_id, access_hash: part.access_hash,
            part_index: i, has_thumbnail: i === 0 && part.has_thumbnail,
            telegram_user_id: part.account_id,
          })));
          done();
        }).catch((err) => { publishParts(null); failed('telegram', err); }),
    );
  });

  await Promise.allSettled(routingPromises);
  await Promise.allSettled([...uploadPromises, albumPipeline.flush()]);
  logChunkRates('batch done');
  loadContents();
};
```

- [ ] **Step 3e: 改接 `uploadFolder()`**

在 `uploadFolder()` 中刪除 `:1174-1190` 的 `VISIBLE_MAX`／`visibleFiles`／`addVisible`／`updateVisible`／`updateUI`、`discovered`／`completed`／`failed` 三個計數器，以及 `:1428-1429` 的 `setUploadTotals`／`setUploadingFiles('掃描資料夾中...')`。

`processEntry()` 中 `entry.file((file) => { ... })` 的開頭改成：

```tsx
const folderPath = basePath.replace(/\/$/, '');
const enqueuedId = queue.enqueueFile(file, {
  rootFolderId: parentFolderId,
  relativePath: folderPath,
  folderResolved: false,        // ensureFolder() 尚未回報
  resolvedFolderId: null,
});
```

`discoveryPromise` 內，凡是原本呼叫 `ensureFolder(folderPath)` 的地方，改成共用一次解析並回報給佇列；身分確認同樣要等 `setHash` 之後：

```tsx
const discoveryPromise = (async (): Promise<void> => {
  const folderId = await ensureFolder(folderPath);
  queue.dispatch({ type: 'setResolved', id: enqueuedId, attempt: 1, resolvedFolderId: folderId, now: Date.now() });

  // 快速判定：目的資料夾已有同名同大小的檔案就整個跳過。這條路徑不做內容
  // 雜湊，因此不會與既有失敗列合併——但先前失敗的檔案本來就不會在目的地，
  // 所以實務上碰不到。
  const alreadyThere = await existingFolderFiles(folderPath);
  if (alreadyThere.get(file.name) === file.size) {
    queue.dispatch({ type: 'setHash', id: enqueuedId, attempt: 1, contentHash: null, now: Date.now() });
    const settled = queue.dispatch({ type: 'complete', id: enqueuedId, attempt: 1, now: Date.now() });
    void settled;
    return;
  }

  queue.dispatch({ type: 'setStatus', id: enqueuedId, attempt: 1, status: 'hashing', now: Date.now() });
  const fileHash = await hashFileBounded(file);
  const settled = queue.dispatch({ type: 'setHash', id: enqueuedId, attempt: 1, contentHash: fileHash, now: Date.now() });
  const resolution = settled.resolutions[enqueuedId];
  if (!resolution || resolution.outcome === 'discarded') return;
  const id = resolution.targetId;
  const attempt = resolution.attempt;
  queue.holdFile(id, file);

  const done = () => { queue.dispatch({ type: 'complete', id, attempt, now: Date.now() }); queue.releaseFile(id); };
  const failed = (stage: UploadErrorStage, err: unknown) => {
    queue.dispatch({ type: 'fail', id, attempt, stage, message: safeErrorMessage(err), now: Date.now() });
    queue.releaseFile(id);
  };
  const onProgress = (pct: number) =>
    queue.dispatch({ type: 'setProgress', id, attempt, progress: pct, now: Date.now() });

  // 後端去重命中：直接註冊中繼資料，不碰 Telegram。
  if (fileHash) {
    const hashCheck = await checkFileHashBounded(fileHash);
    const asExisting = hashCheck.found ? canonicalExistingParts(hashCheck.files, file.size) : [];
    if (asExisting.length > 0) {
      queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
      try {
        await registerDuplicateParts(file, fileHash, asExisting, folderId);
        done();
      } catch (err) {
        failed('register', err);
      }
      return;
    }
    if (hashCheck.files.length > 0) {
      console.warn('[Upload] Hash matched but stored copy is incomplete, re-uploading:', file.name);
    }
  }

  // 批次內去重：搶到 claim 的人負責真的上傳，其餘的人排在它後面只註冊。
  // get/set 這一對必須保持同步，否則兩個同內容的 discovery 會同時搶到。
  const claim: { publish: (parts: RegisterableExistingPart[] | null) => void } = { publish: () => {} };
  if (fileHash) {
    const claimed = claimedHashes.get(fileHash);
    if (claimed) {
      queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
      // 排進 uploadPromises 而不是在這裡 await：discovery promise 內等 claim
      // 會讓 album pipeline 的尾批永遠等不到 flush。
      uploadPromises.push((async () => {
        const parts = await claimed;
        if (!parts || parts.length === 0) throw new Error('來源檔案上傳失敗');
        await registerDuplicateParts(file, fileHash, parts, folderId);
        done();
      })().catch((err) => failed('register', err)));
      return;
    }
    claimedHashes.set(fileHash, new Promise((resolve) => { claim.publish = resolve; }));
  }

  queue.dispatch({ type: 'setStatus', id, attempt, status: 'uploading', now: Date.now() });

  // 過了 claim 之後每條路徑都必須把它 settle 掉，排在後面的檔案才不會永遠等下去。
  try {
    if (isAlbumEligibleMedia(file) && file.size <= SMALL_FILE_LIMIT) {
      uploadPromises.push(
        albumPipeline.enqueue(file, fileHash, folderId, onProgress)
          .then((res) => {
            if (!res) { claim.publish(null); failed('telegram', new Error('上傳失敗')); return; }
            claim.publish([{
              filesize: file.size, mime_type: file.type || null,
              telegram_message_id: res.message_id, access_hash: res.access_hash,
              part_index: 0, has_thumbnail: res.has_thumbnail, telegram_user_id: res.account_id,
            }]);
            done();
          })
          .catch((err) => { claim.publish(null); failed('telegram', err); }),
      );
      return;
    }

    uploadPromises.push(
      uploadFileEntryFresh(file)
        .then(async (result) => {
          queue.dispatch({ type: 'setStatus', id, attempt, status: 'registering', now: Date.now() });
          await registerFolderFileParts(file, fileHash, folderId, result.parts, result.hasThumbnail);
          claim.publish(result.parts.map((part, j) => ({
            filesize: part.size, mime_type: file.type || null,
            telegram_message_id: part.message_id, access_hash: part.access_hash,
            part_index: j, has_thumbnail: j === 0 && result.hasThumbnail,
          })));
          done();
        })
        .catch((err) => { claim.publish(null); failed('telegram', err); }),
    );
  } catch (err) {
    claim.publish(null);
    throw err;
  }
})();
```

`uploadFolder()` 結尾把 `updateUI(); loadContents();` 簡化成 `loadContents();`。

- [ ] **Step 3f: 掛載元件**

在 `ChonkyDrive.tsx` 的 `return` 中，用以下取代原本 `{uploadingFiles.length > 0 && (() => { ... })()}` 整塊：

```tsx
<UploadCenter
  state={queue.state}
  isVideoPreviewOpen={previewFile !== null && fileKind(previewFile.mime_type, previewFile.filename) === 'video'}
  onPanelMode={(mode, byUser) => queue.dispatch({ type: 'setPanelMode', mode, byUser })}
  onClearTerminal={() => queue.dispatch({ type: 'clearTerminal' })}
/>
```

- [ ] **Step 4: 執行測試確認通過**

Run:
```bash
cd frontend && npx tsc --noEmit
cd frontend && npx playwright test --project=isolated tests/isolated/upload-center.spec.ts
cd frontend && npx playwright test --project=isolated tests/isolated/upload-pipeline.spec.ts tests/isolated/upload-refresh.spec.ts tests/isolated/upload-statistics.spec.ts
```
Expected: 三個指令全部 PASS。`upload-pipeline.spec.ts` 使用 `card()` 查看檔案清單而非上傳面板，因此不受本次改動影響。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useUploadQueue.ts frontend/src/components/UploadCenter.tsx frontend/src/components/VirtualUploadList.tsx frontend/src/components/ChonkyDrive.tsx frontend/tests/isolated/upload-center.spec.ts
git commit -m "feat(upload): replace per-batch upload rows with a single upload center"
```

---

## Task 8: 篩選、搜尋、錯誤詳情區

**Files:**
- Modify: `frontend/src/components/UploadCenter.tsx`
- Modify: `frontend/src/components/ChonkyDrive.tsx`（傳入新的 callback）
- Modify: `frontend/tests/isolated/upload-center.spec.ts`

**Interfaces:**
- Consumes: Task 7 的 `UploadCenterProps`、Task 4 的 selectors。
- Produces: `UploadCenterProps` 新增 `onFilter(filter)`、`onQuery(query)`、`onToggleCompleted()`、`onErrorDetail(id)`。新 testid：`upload-filter-all`、`upload-filter-active`、`upload-filter-error`、`upload-filter-complete`、`upload-search`、`upload-toggle-completed`、`upload-error-detail`、`upload-row-detail-btn`。

- [ ] **Step 1: 寫失敗的測試**

接在 `upload-center.spec.ts` 末尾：

```ts
/** 讓 register 對指定檔名回 500，製造「註冊失敗」。 */
async function failRegisterFor(page: import('@playwright/test').Page, filenames: string[]) {
  await page.route('**/api/v1/files/register', async (route) => {
    const body = route.request().postDataJSON();
    if (filenames.includes(body.filename)) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '中繼資料寫入失敗' }) });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...body, file_id: body.file_id, isDir: false }) });
  });
}

test('失敗置頂，失敗篩選只顯示失敗項目與具體原因', async ({ page, openDrive, drive }) => {
  const good = Buffer.from('this one registers fine');
  const bad = Buffer.from('this one fails to register');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-good', good], ['src-bad', bad]]));
  await failRegisterFor(page, ['bad.txt']);

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'good.txt', mimeType: 'text/plain', buffer: good },
    { name: 'bad.txt', mimeType: 'text/plain', buffer: bad },
  ]);

  await expect(page.getByTestId('upload-center-error-badge')).toContainText('失敗 1');
  // 失敗組永遠排在最前面。
  await expect(rows(page).first()).toContainText('bad.txt');
  await expect(rows(page).first()).toContainText('註冊失敗');

  await page.getByTestId('upload-filter-error').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('bad.txt');
});

test('搜尋找得到虛擬 viewport 外與已收合完成組內的項目', async ({ page, openDrive, drive }) => {
  const sources = new Map<string, Buffer>();
  const payloads = Array.from({ length: 150 }, (_, i) => Buffer.from(`searchable payload ${i}`));
  payloads.forEach((bytes, i) => sources.set(`src-${i}`, bytes));

  await openDrive();
  await dedupeAll(page, drive, sources);
  await page.locator('input[type="file"]').first().setInputFiles(
    payloads.map((buffer, i) => ({ name: `file-${String(i).padStart(3, '0')}.txt`, mimeType: 'text/plain', buffer })),
  );
  await expect(page.getByTestId('upload-center-title')).toContainText('150 / 150', { timeout: 30_000 });

  // 完成組預設收合，清單此刻是空的。
  await expect(rows(page)).toHaveCount(0);

  for (const name of ['file-000.txt', 'file-099.txt', 'file-149.txt']) {
    await page.getByTestId('upload-search').fill(name);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(name);
  }
});

test('完整錯誤訊息顯示在列表外的固定區域，不改變列高', async ({ page, openDrive, drive }) => {
  const bad = Buffer.from('registration will fail');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-bad', bad]]));
  await failRegisterFor(page, ['bad.txt']);

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'bad.txt', mimeType: 'text/plain', buffer: bad },
  ]);
  await expect(rows(page)).toHaveCount(1);
  const before = await rows(page).first().boundingBox();

  await page.getByTestId('upload-row-detail-btn').first().click();
  await expect(page.getByTestId('upload-error-detail')).toBeVisible();
  const after = await rows(page).first().boundingBox();
  expect(after!.height).toBe(before!.height);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx playwright test --project=isolated tests/isolated/upload-center.spec.ts`
Expected: FAIL — `upload-filter-error` / `upload-search` / `upload-row-detail-btn` 皆不存在

- [ ] **Step 3: 寫最小實作**

`UploadCenter.tsx` 的 props 加上四個 callback，並在標題與列表之間插入篩選列與搜尋框，在列表下方插入錯誤詳情區。`Row` 加一個詳細資訊按鈕。

```tsx
export interface UploadCenterProps {
  state: UploadQueueState;
  isVideoPreviewOpen: boolean;
  onFilter: (filter: UploadFilter) => void;
  onQuery: (query: string) => void;
  onToggleCompleted: () => void;
  onErrorDetail: (id: string | null) => void;
  onPanelMode: (mode: 'expanded' | 'collapsed', byUser: boolean) => void;
  onClearTerminal: () => void;
}

const FILTERS: Array<{ key: UploadFilter; label: string; count: (c: UploadCounts) => number }> = [
  { key: 'all', label: '全部', count: (c) => c.total },
  { key: 'active', label: '進行中', count: (c) => c.active },
  { key: 'error', label: '失敗', count: (c) => c.error },
  { key: 'complete', label: '完成', count: (c) => c.complete },
];
```

篩選列（`role="tablist"`，鍵盤可操作，顏色不是唯一訊號）：

```tsx
<div role="tablist" aria-label="上傳狀態篩選"
  style={{ display: 'flex', gap: 4, padding: '6px 14px', overflowX: 'auto', borderBottom: '1px solid var(--td-border)' }}>
  {FILTERS.map(({ key, label, count }) => (
    <button
      key={key}
      role="tab"
      data-testid={`upload-filter-${key}`}
      aria-selected={state.filter === key}
      onClick={() => onFilter(key)}
      style={{
        flexShrink: 0, cursor: 'pointer', fontSize: 12, borderRadius: 4, padding: '3px 8px',
        border: '1px solid ' + (state.filter === key ? 'var(--td-accent)' : 'var(--td-border)'),
        background: state.filter === key ? 'var(--td-accent-soft)' : 'transparent',
        color: key === 'error' && count(counts) > 0 ? '#dc2626' : 'var(--td-text)',
      }}
    >
      {label} {count(counts)}
    </button>
  ))}
</div>

<div style={{ padding: '6px 14px' }}>
  <input
    data-testid="upload-search"
    type="search"
    aria-label="搜尋上傳項目"
    placeholder="搜尋檔名…"
    value={state.query}
    onChange={(e) => onQuery(e.target.value)}
    style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--td-border)', background: 'var(--td-surface-alt)', color: 'var(--td-text)' }}
  />
  {state.filter === 'all' && counts.complete > 0 && (
    <button
      data-testid="upload-toggle-completed"
      aria-expanded={!state.completedCollapsed}
      onClick={onToggleCompleted}
      style={{ marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--td-text-muted)', padding: 0 }}
    >
      {state.completedCollapsed ? '顯示' : '隱藏'}已完成（{counts.complete}）
    </button>
  )}
</div>
```

`Row` 加詳細資訊按鈕（只在 error 時出現），並把 `onErrorDetail` 往下傳：

```tsx
{item.status === 'error' && (
  <button
    data-testid="upload-row-detail-btn"
    onClick={() => onErrorDetail(item.id)}
    aria-label={`${item.name} 的錯誤詳細資訊`}
    style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)', fontSize: 12, padding: '0 2px' }}
  >ⓘ</button>
)}
```

錯誤詳情區放在虛擬列表與清除列之間，高度固定不影響列高：

```tsx
{state.errorDetailId && state.itemsById[state.errorDetailId] && (
  <div
    data-testid="upload-error-detail"
    style={{ padding: '8px 14px', borderTop: '1px solid var(--td-border)', background: 'var(--td-surface-alt)', maxHeight: 90, overflowY: 'auto' }}
  >
    <div style={{ fontSize: 11, color: 'var(--td-text-muted)', marginBottom: 2 }}>
      {state.itemsById[state.errorDetailId].name}
      <button onClick={() => onErrorDetail(null)} aria-label="關閉錯誤詳細資訊"
        style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)' }}>✕</button>
    </div>
    <div style={{ fontSize: 12, color: '#dc2626', wordBreak: 'break-word' }}>
      {state.itemsById[state.errorDetailId].errorMessage}
    </div>
  </div>
)}
```

在 `ChonkyDrive.tsx` 補上四個 callback：

```tsx
onFilter={(filter) => queue.dispatch({ type: 'setFilter', filter })}
onQuery={(query) => queue.dispatch({ type: 'setQuery', query })}
onToggleCompleted={() => queue.dispatch({ type: 'toggleCompleted' })}
onErrorDetail={(id) => queue.dispatch({ type: 'setErrorDetail', id })}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd frontend && npx playwright test --project=isolated tests/isolated/upload-center.spec.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/UploadCenter.tsx frontend/src/components/ChonkyDrive.tsx frontend/tests/isolated/upload-center.spec.ts
git commit -m "feat(upload): add filters, search and pinned error detail to upload center"
```

---

## Task 9: 收合按鈕、影片預覽避讓、行動裝置 sheet

**Files:**
- Modify: `frontend/src/components/UploadCenter.tsx`
- Modify: `frontend/tests/isolated/upload-center.spec.ts`

**Interfaces:**
- Consumes: Task 8 的 `UploadCenterProps`（介面不變）、Task 4 的 `selectOverallPercent()`。
- Produces: 新 testid `upload-center-collapsed`、`upload-center-toggle`。`isVideoPreviewOpen` 為 true 時強制收合且不可展開。

- [ ] **Step 1: 寫失敗的測試**

先在 `fakeDrive` 中準備一個可預覽的影片與圖片。接在 `upload-center.spec.ts` 末尾：

```ts
test('開啟影片預覽時收合並讓開播放器，關閉後維持收合', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('collapse me while the player is open');
  await openDrive((d) => {
    d.file('clip', { filename: 'clip.mp4', filesize: 2048, mime_type: 'video/mp4', telegram_message_id: 501, access_hash: '50101' });
  });
  await dedupeAll(page, drive, new Map([['src-1', payload]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'note.txt', mimeType: 'text/plain', buffer: payload },
  ]);
  await expect(page.getByTestId('upload-center')).toBeVisible();

  await page.getByText('clip.mp4').first().dblclick();

  await expect(page.getByTestId('upload-center')).toHaveCount(0);
  const button = page.getByTestId('upload-center-collapsed');
  await expect(button).toBeVisible();

  // 收合按鈕不得覆蓋播放器或預覽控制。
  const closeBtn = page.getByRole('button', { name: '✕' }).first();
  const a = await button.boundingBox();
  const b = await closeBtn.boundingBox();
  const overlaps = a!.x < b!.x + b!.width && b!.x < a!.x + a!.width
    && a!.y < b!.y + b!.height && b!.y < a!.y + a!.height;
  expect(overlaps).toBe(false);

  // 預覽期間點擊不展開。
  await button.click();
  await expect(page.getByTestId('upload-center')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('upload-center')).toHaveCount(0);
  await expect(page.getByTestId('upload-center-collapsed')).toBeVisible();
});

test('圖片預覽不觸發收合', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('image preview must not collapse the panel');
  await openDrive((d) => {
    d.file('pic', { filename: 'pic.jpg', filesize: 1024, mime_type: 'image/jpeg', telegram_message_id: 502, access_hash: '50202' });
  });
  await dedupeAll(page, drive, new Map([['src-1', payload]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'note.txt', mimeType: 'text/plain', buffer: payload },
  ]);
  await expect(page.getByTestId('upload-center')).toBeVisible();

  await page.getByText('pic.jpg').first().dblclick();
  await expect(page.getByTestId('upload-center')).toBeVisible();
});

test('窄螢幕改為底部 sheet，且不超出畫面', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('narrow viewport layout');
  await page.setViewportSize({ width: 390, height: 780 });
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', payload]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'note.txt', mimeType: 'text/plain', buffer: payload },
  ]);

  const box = await page.getByTestId('upload-center').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(8);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390 - 8 + 0.5);
  expect(box!.height).toBeLessThanOrEqual(780 * 0.6 + 0.5);

  // 篩選與清除控制皆可鍵盤操作。
  await page.getByTestId('upload-filter-error').focus();
  await expect(page.getByTestId('upload-filter-error')).toBeFocused();
  await page.getByTestId('upload-center-clear').focus();
  await expect(page.getByTestId('upload-center-clear')).toBeFocused();
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx playwright test --project=isolated tests/isolated/upload-center.spec.ts`
Expected: FAIL — `upload-center-collapsed` 不存在；窄螢幕下面板寬度仍為 380 px

- [ ] **Step 3: 寫最小實作**

在 `UploadCenter.tsx` 頂部加入視窗寬度追蹤與自動展開／強制收合規則：

```tsx
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}
```

在元件內：

```tsx
const narrow = useIsNarrow();
const counts = selectCounts(state);
const percent = selectOverallPercent(state);

// 第一次加入項目時，若沒有開著影片預覽就自動展開；使用者手動收合過就不再自動展開。
useEffect(() => {
  if (counts.total === 0) return;
  if (state.panelTouched || isVideoPreviewOpen) return;
  if (state.panelMode === 'collapsed') onPanelMode('expanded', false);
}, [counts.total, state.panelTouched, state.panelMode, isVideoPreviewOpen, onPanelMode]);

if (counts.total === 0) return null;

// 影片預覽期間一律收合，且不接受展開——面板最小寬度 360 px 與播放器安全區域
// 無法同時滿足「不遮擋播放器」與「失敗清單仍可讀」。
const collapsed = isVideoPreviewOpen || state.panelMode === 'collapsed';
```

收合按鈕：

```tsx
if (collapsed) {
  const name = counts.active > 0
    ? `上傳中心，${percent}%，剩餘 ${counts.active} 項${counts.error > 0 ? `，失敗 ${counts.error} 項` : ''}`
    : counts.error > 0 ? `上傳中心，失敗 ${counts.error} 項` : '上傳中心，全部完成';
  return (
    <button
      data-testid="upload-center-collapsed"
      aria-label={isVideoPreviewOpen ? `${name}（關閉預覽後可展開）` : name}
      onClick={() => { if (!isVideoPreviewOpen) onPanelMode('expanded', true); }}
      style={{
        position: 'fixed', zIndex: 1100,
        ...(isVideoPreviewOpen
          // 預覽遮罩的 zIndex 是 1000，按鈕必須在它之上，且固定在右上角安全區。
          ? { top: 12, right: 12 }
          : narrow ? { bottom: 12, right: 8 } : { bottom: 16, right: 16 }),
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', borderRadius: 999, cursor: isVideoPreviewOpen ? 'default' : 'pointer',
        background: 'var(--td-surface)', border: '1px solid var(--td-border)',
        boxShadow: `0 2px 8px var(--td-shadow)`, color: 'var(--td-text)', fontSize: 12,
      }}
    >
      <span>{counts.active > 0 ? `${percent}%・剩餘 ${counts.active}` : counts.error > 0 ? '上傳中心' : '✓ 已完成'}</span>
      {counts.error > 0 && (
        <span style={{ background: '#dc2626', color: '#fff', borderRadius: 999, padding: '0 6px', fontWeight: 600 }}>
          {counts.error}
        </span>
      )}
    </button>
  );
}
```

展開面板的容器樣式改成隨 `narrow` 切換，並在標題列加收合按鈕：

```tsx
style={{
  position: 'fixed', zIndex: 900,
  display: 'flex', flexDirection: 'column',
  background: 'var(--td-surface)', border: '1px solid var(--td-border)',
  boxShadow: `0 4px 12px var(--td-shadow)`,
  ...(narrow
    ? { left: 8, right: 8, bottom: 0, maxHeight: '60vh', borderRadius: '8px 8px 0 0' }
    : { right: 16, bottom: 16, width: 380, maxHeight: '65vh', borderRadius: 8 }),
}}
```

```tsx
<button
  data-testid="upload-center-toggle"
  onClick={() => onPanelMode('collapsed', true)}
  aria-label="收合上傳中心"
  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)', fontSize: 13 }}
>收合</button>
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd frontend && npx playwright test --project=isolated tests/isolated/upload-center.spec.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/UploadCenter.tsx frontend/tests/isolated/upload-center.spec.ts
git commit -m "feat(upload): collapse upload center for video preview and narrow screens"
```

---

## Task 10: 重試合併與清除的端到端驗證

**Files:**
- Modify: `frontend/tests/isolated/upload-center.spec.ts`
- Modify: `frontend/src/components/UploadCenter.tsx`（僅在測試揭露缺口時）

**Interfaces:**
- Consumes: Task 7–9 的全部 testid。
- Produces: 無新介面。本任務把 reducer 層已證明的規則，在真實 DOM 上再證一次。

- [ ] **Step 1: 寫失敗的測試**

接在 `upload-center.spec.ts` 末尾：

```ts
test('相同失敗檔案再次選取時直接轉為第 2 次嘗試，DOM 只有一列', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('this will fail once then succeed');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', payload]]));

  let failNext = true;
  await page.route('**/api/v1/files/register', async (route) => {
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '中繼資料寫入失敗' }) });
    }
    const body = route.request().postDataJSON();
    drive.file(body.file_id, {
      filename: body.filename, filesize: body.filesize, telegram_message_id: body.message_id,
      access_hash: body.access_hash ?? null, parent_id: body.parent_id ?? null, telegram_user_id: 42,
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(drive.get(body.file_id)) });
  });

  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles([{ name: 'retry.txt', mimeType: 'text/plain', buffer: payload }]);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('註冊失敗');

  await input.setInputFiles([{ name: 'retry.txt', mimeType: 'text/plain', buffer: payload }]);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('第 2 次嘗試');
  await expect(page.getByTestId('upload-center-error-badge')).toHaveCount(0);
  await expect(page.getByTestId('upload-center-title')).toContainText('1 / 1');
});

test('同名但內容不同的兩個檔案顯示兩列並各自更新', async ({ page, openDrive, drive }) => {
  const first = Buffer.from('same name, first content');
  const second = Buffer.from('same name, different content entirely');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', first], ['src-2', second]]));

  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles([{ name: 'dup.txt', mimeType: 'text/plain', buffer: first }]);
  await expect(page.getByTestId('upload-center-title')).toContainText('1 / 1');

  await input.setInputFiles([{ name: 'dup.txt', mimeType: 'text/plain', buffer: second }]);
  await expect(page.getByTestId('upload-center-title')).toContainText('2 / 2');
});

test('同一資料夾中內容相同、檔名不同的兩個檔案各自成列且都註冊成功', async ({ page, openDrive, drive }) => {
  const shared = Buffer.from('identical bytes under two names');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', shared]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: shared },
    { name: 'beta.txt', mimeType: 'text/plain', buffer: shared },
  ]);

  await expect(page.getByTestId('upload-center-title')).toContainText('2 / 2');
  await page.getByTestId('upload-filter-complete').click();
  await expect(rows(page)).toHaveCount(2);
  // 兩份中繼資料都真的寫進了假後端。
  const registered = drive.requests.filter((r) => r.method === 'POST' && r.path === '/files/register');
  expect(registered.map((r) => r.body.filename).sort()).toEqual(['alpha.txt', 'beta.txt']);
});

test('清除已完成與失敗後，進行中的列仍存在', async ({ page, openDrive, drive }) => {
  const quick = Buffer.from('resolves immediately');
  const slow = Buffer.from('this lookup is deliberately slow');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', quick]]));

  // slow.txt 的 hash 查詢卡住，讓它一直停在進行中。
  await page.route('**/api/v1/files/check-hashes', async (route) => {
    const hashes = route.request().postDataJSON().hashes as string[];
    if (hashes.includes(fingerprint(slow))) await new Promise((r) => setTimeout(r, 15_000));
    const results: Record<string, unknown[]> = {};
    if (hashes.includes(fingerprint(quick))) results[fingerprint(quick)] = [drive.get('src-1')];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'quick.txt', mimeType: 'text/plain', buffer: quick },
    { name: 'slow.txt', mimeType: 'text/plain', buffer: slow },
  ]);

  await expect(page.getByTestId('upload-center-title')).toContainText('1 / 2');
  await page.getByTestId('upload-center-clear').click();
  await expect(page.getByTestId('upload-center-title')).toContainText('0 / 1');
  await page.getByTestId('upload-filter-active').click();
  await expect(rows(page).first()).toContainText('slow.txt');
});
```

- [ ] **Step 2: 執行測試確認失敗（或直接通過）**

Run: `cd frontend && npx playwright test --project=isolated tests/isolated/upload-center.spec.ts`
Expected: 這四個測試驗證的規則在 Task 2/3 的 reducer 已經實作，理想情況直接 PASS。若有 FAIL，代表 Task 7 的接線把 `resolutions` 用錯了 —— 不要改 reducer，回頭修 `ChonkyDrive.tsx` 中身分確認後 `id` / `attempt` 的取用。

- [ ] **Step 3: 修正接線（僅在 Step 2 有 FAIL 時）**

最可能的兩個缺口：
1. `setStatus`／`setProgress` 仍在用 `enqueuedId` 而不是 `resolution.targetId`。
2. 合併發生後 `attempt` 仍寫死 `1`，而不是 `resolution.attempt`。

兩者都在 `startUploadBatch()` 與 `uploadFolder()` 的 `discoveryPromise` 內，逐一比對 Task 7 Step 3d/3e 的程式碼。

- [ ] **Step 4: 執行測試確認通過**

Run: `cd frontend && npx playwright test --project=isolated tests/isolated/upload-center.spec.ts`
Expected: PASS（12 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/isolated/upload-center.spec.ts frontend/src/components/ChonkyDrive.tsx
git commit -m "test(upload): cover retry merge, same-name splits and clear semantics"
```

---

## Task 11: 無障礙、全套測試與線上驗收

**Files:**
- Modify: `frontend/src/components/UploadCenter.tsx`
- Modify: `frontend/tests/isolated/upload-center.spec.ts`

**Interfaces:**
- Consumes: 全部先前任務。
- Produces: 單一失敗摘要 live region（`data-testid="upload-live-region"`）。

- [ ] **Step 1: 寫失敗的測試**

```ts
test('新增失敗時透過單一摘要 live region 宣告，進度更新不進 live region', async ({ page, openDrive, drive }) => {
  const bad = Buffer.from('announce this failure');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-bad', bad]]));
  await failRegisterFor(page, ['bad.txt']);

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'bad.txt', mimeType: 'text/plain', buffer: bad },
  ]);

  const live = page.getByTestId('upload-live-region');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveText('1 個檔案上傳失敗');
  // 整個面板只有這一個 live region。
  expect(await page.locator('[aria-live]').count()).toBe(1);
});

test('面板是具名 region，篩選是可鍵盤操作的 tabs', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('accessibility surface');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', payload]]));
  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'note.txt', mimeType: 'text/plain', buffer: payload },
  ]);

  await expect(page.getByRole('region', { name: '上傳中心' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /失敗/ })).toBeVisible();
  await page.getByTestId('upload-filter-complete').press('Enter');
  await expect(page.getByTestId('upload-filter-complete')).toHaveAttribute('aria-selected', 'true');
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd frontend && npx playwright test --project=isolated tests/isolated/upload-center.spec.ts`
Expected: FAIL — `upload-live-region` 不存在

- [ ] **Step 3: 寫最小實作**

在 `UploadCenter.tsx` 的展開面板與收合按鈕之外、元件回傳的最外層加入 live region。它必須在兩種面板模式下都存在，因此獨立於 `collapsed` 分支：

```tsx
function ErrorLiveRegion({ count }: { count: number }) {
  return (
    <div
      data-testid="upload-live-region"
      aria-live="polite"
      style={{
        position: 'absolute', width: 1, height: 1, overflow: 'hidden',
        clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
      }}
    >
      {count > 0 ? `${count} 個檔案上傳失敗` : ''}
    </div>
  );
}
```

把 `collapsed` 與展開兩個回傳都包進 fragment：

```tsx
return (
  <>
    <ErrorLiveRegion count={counts.error} />
    {collapsed ? collapsedButton : expandedPanel}
  </>
);
```

同時確認全域 `prefers-reduced-motion` 已被尊重：本元件沒有任何 transition 或 animation，因此不需額外處理；若在 Task 9 加過 transition，在此移除或包進 `@media (prefers-reduced-motion: reduce)`。

- [ ] **Step 4: 執行全套測試**

```bash
cd frontend && npx tsc --noEmit
cd frontend && npm run test:unit
cd frontend && npm run test:e2e
cd frontend && npm run build
node scripts/run-tests.mjs
```
Expected: 全部 PASS。特別確認 `upload-pipeline.spec.ts`、`upload-refresh.spec.ts`、`upload-statistics.spec.ts` 仍通過，且 `backend` pytest 未受影響（本計畫沒有動後端）。

- [ ] **Step 5: 線上驗收**

CLAUDE.md 的開發規則要求「完成修正後必須打開網頁確認成果」，spec 則要求最終驗收使用 Playwright MCP 而非人工操作。兩者合起來的做法：用 Playwright MCP 開啟 `https://teledrive.yoyotsaoteledrive.dpdns.org`，在真實登入狀態下確認以下三點，並保留截圖：

1. 一次拖入 3 個檔案後只出現一個上傳中心，標題顯示 `已結束數 / 總數`。
2. 上傳完成後再拖入第 4 個檔案，前 3 筆仍在清單中（切到「完成」篩選可見）。
3. 開啟任一影片預覽，面板收合成右上角按鈕且不覆蓋播放器的關閉／下載按鈕。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/UploadCenter.tsx frontend/tests/isolated/upload-center.spec.ts
git commit -m "feat(upload): announce upload failures through a single live region"
```

---

## 交付檢查表

- [ ] 任意時刻只存在一個上傳中心（Task 7 測試 1）
- [ ] 第二次及之後的拖放追加到同一個佇列（Task 7 測試 1）
- [ ] 全部項目可透過捲動、篩選或搜尋找到（Task 8 測試 2）
- [ ] 大於 100 筆時不刪除早期項目，也不為每筆建立常駐 DOM 節點（Task 7 測試 2）
- [ ] 失敗總數始終可見，失敗列優先（Task 8 測試 1）
- [ ] 新批次不清除舊失敗（Task 2 reducer 測試 + Task 7 測試 1）
- [ ] 相同失敗檔案再次上傳維持一列並顯示嘗試次數（Task 10 測試 1）
- [ ] 相同 active 檔案不重複排入；同名不同內容、同內容不同檔名都不誤合併（Task 2/3 + Task 10 測試 2、3）
- [ ] 身分確認前不改寫任何既有項目（Task 2 測試「canonical 不同」）
- [ ] 遲到的舊 attempt 更新不影響新一次嘗試（Task 3「attempt 隔離」）
- [ ] 影片預覽期間不遮住播放器或預覽控制（Task 9 測試 1）
- [ ] 清除操作永不移除進行中的工作（Task 3 + Task 10 測試 4）
- [ ] 上傳中心的清除、重試與合併不改動每日上傳統計（未修改 `uploadStatisticsSync.ts`；`upload-statistics.spec.ts` 持續通過）
- [ ] 不新增任何讓檔案位元組經過 Python backend 的路徑（未修改 `backend/`）
