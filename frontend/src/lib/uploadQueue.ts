import { canonicalIdentity, provisionalIdentity, type UploadDestination } from './uploadIdentity';
import type { RenderScheduler } from './renderScheduler';

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
  /** 帳號遷移時顯示在固定第二行的非錯誤狀態。 */
  statusMessage: string | null;
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
  | {
    type: 'migrationProgressReset'; id: string; attempt: number; progress: number;
    message: '重新分派上傳帳號，該區段將從頭重傳'; now: number;
  }
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
function current(getItem: (id: string) => UploadItem | undefined, id: string, attempt: number): UploadItem | null {
  const item = getItem(id);
  if (!item || item.attempt !== attempt) return null;
  return item;
}

type CanonicalMatches = {
  active: CanonicalPriority;
  error: CanonicalPriority;
  complete: number;
};

type CanonicalPriorityEntry = { id: string; order: number };

/** Keeps the earliest stable queue slot at the head while category membership changes. */
class CanonicalPriority {
  private readonly entries: CanonicalPriorityEntry[] = [];
  private readonly positions = new Map<string, number>();

  get size(): number {
    return this.entries.length;
  }

  first(): string | undefined {
    return this.entries[0]?.id;
  }

  add(id: string, order: number): void {
    if (this.positions.has(id)) return;
    const index = this.entries.length;
    this.entries.push({ id, order });
    this.positions.set(id, index);
    this.bubbleUp(index);
  }

  delete(id: string): void {
    const index = this.positions.get(id);
    if (index === undefined) return;
    const last = this.entries.pop()!;
    this.positions.delete(id);
    if (index === this.entries.length) return;
    this.entries[index] = last;
    this.positions.set(last.id, index);
    if (index > 0 && this.entries[index].order < this.entries[Math.floor((index - 1) / 2)].order) {
      this.bubbleUp(index);
    } else {
      this.bubbleDown(index);
    }
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.entries[parent].order <= this.entries[current].order) break;
      this.swap(parent, current);
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;
      if (left < this.entries.length && this.entries[left].order < this.entries[smallest].order) smallest = left;
      if (right < this.entries.length && this.entries[right].order < this.entries[smallest].order) smallest = right;
      if (smallest === current) return;
      this.swap(current, smallest);
      current = smallest;
    }
  }

  private swap(left: number, right: number): void {
    [this.entries[left], this.entries[right]] = [this.entries[right], this.entries[left]];
    this.positions.set(this.entries[left].id, left);
    this.positions.set(this.entries[right].id, right);
  }
}

/**
 * 生產環境在此 working store 直接改寫單一列與索引；只有 snapshot() 會複製整個
 * queue 供 React 顯示。純 reducer 也委派給同一個 dispatch 核心，避免兩套行為漂移。
 */
export interface UploadQueueStore {
  dispatch(action: UploadAction): UploadQueueState;
  /** 供立即路由判斷用；尤其是 dispatch 後的 resolutions[id]。 */
  getState(): UploadQueueState;
  /** 為 React 發布一份不會再被 working store 改寫的 state。 */
  snapshot(): UploadQueueState;
  readonly revision: number;
}

/** Narrow test hook for asserting indexed actions do not enumerate the queue. */
export interface UploadQueueStoreOptions {
  onItemsByIdAccess?: (access: 'lookup' | 'scan') => void;
}

function provisionalEligible(item: UploadItem): boolean {
  return item.status !== 'complete';
}

function canonicalCategory(item: UploadItem): 'active' | 'error' | 'complete' | null {
  if (item.canonicalIdentity === null) return null;
  if (isActive(item)) return 'active';
  return item.status === 'error' ? 'error' : 'complete';
}

class MutableUploadQueueStore implements UploadQueueStore {
  private readonly itemsById: Record<string, UploadItem>;
  private order: Array<string | null>;
  private readonly orderIndex = new Map<string, number>();
  private readonly resolutions: Record<string, UploadResolution>;
  private readonly provisionalIndex = new Map<string, Set<string>>();
  private readonly canonicalIndex = new Map<string, CanonicalMatches>();
  private readonly state: UploadQueueState;
  revision = 0;

  constructor(initial: UploadQueueState, options: UploadQueueStoreOptions) {
    const itemsById = { ...initial.itemsById };
    this.itemsById = options.onItemsByIdAccess
      ? new Proxy(itemsById, {
        get(target, property, receiver) {
          if (typeof property === 'string') options.onItemsByIdAccess?.('lookup');
          return Reflect.get(target, property, receiver);
        },
        ownKeys(target) {
          options.onItemsByIdAccess?.('scan');
          return Reflect.ownKeys(target);
        },
      })
      : itemsById;
    this.order = [...initial.order];
    this.resolutions = { ...initial.resolutions };
    this.state = {
      ...initial,
      itemsById: this.itemsById,
      // 併入時會留下空槽；這個工作中的 state 僅供同步 resolution 查詢，
      // React 一律拿 snapshot() 的緊密排序陣列。
      order: this.order as string[],
      resolutions: this.resolutions,
    };
    this.order.forEach((id, index) => {
      if (id === null) return;
      this.orderIndex.set(id, index);
      const item = this.itemsById[id];
      if (!item) return;
      this.addProvisional(item);
      this.addCanonical(item);
    });
  }

  getState(): UploadQueueState {
    return this.state;
  }

  snapshot(): UploadQueueState {
    return {
      ...this.state,
      itemsById: { ...this.itemsById },
      order: this.order.filter((id): id is string => id !== null),
      resolutions: { ...this.resolutions },
    };
  }

  dispatch(action: UploadAction): UploadQueueState {
    if (this.apply(action)) this.revision += 1;
    return this.state;
  }

  private addProvisional(item: UploadItem): void {
    if (!provisionalEligible(item)) return;
    let ids = this.provisionalIndex.get(item.provisionalIdentity);
    if (!ids) {
      ids = new Set();
      this.provisionalIndex.set(item.provisionalIdentity, ids);
    }
    ids.add(item.id);
  }

  private removeProvisional(item: UploadItem): void {
    const ids = this.provisionalIndex.get(item.provisionalIdentity);
    if (!ids) return;
    ids.delete(item.id);
    if (ids.size === 0) this.provisionalIndex.delete(item.provisionalIdentity);
  }

  private addCanonical(item: UploadItem): void {
    const identity = item.canonicalIdentity;
    const category = canonicalCategory(item);
    if (identity === null || category === null) return;
    let matches = this.canonicalIndex.get(identity);
    if (!matches) {
      matches = { active: new CanonicalPriority(), error: new CanonicalPriority(), complete: 0 };
      this.canonicalIndex.set(identity, matches);
    }
    const order = this.orderIndex.get(item.id);
    if (order === undefined) return;
    if (category === 'active') matches.active.add(item.id, order);
    else if (category === 'error') matches.error.add(item.id, order);
    else matches.complete += 1;
  }

  private removeCanonical(item: UploadItem): void {
    const identity = item.canonicalIdentity;
    const category = canonicalCategory(item);
    if (identity === null || category === null) return;
    const matches = this.canonicalIndex.get(identity);
    if (!matches) return;
    if (category === 'active') matches.active.delete(item.id);
    else if (category === 'error') matches.error.delete(item.id);
    else matches.complete -= 1;
    if (matches.active.size === 0 && matches.error.size === 0 && matches.complete === 0) {
      this.canonicalIndex.delete(identity);
    }
  }

  private replaceItem(item: UploadItem): void {
    const prior = this.itemsById[item.id];
    if (prior && (
      prior.provisionalIdentity !== item.provisionalIdentity
      || provisionalEligible(prior) !== provisionalEligible(item)
    )) {
      this.removeProvisional(prior);
      this.addProvisional(item);
    }
    if (prior && (
      prior.canonicalIdentity !== item.canonicalIdentity
      || canonicalCategory(prior) !== canonicalCategory(item)
    )) {
      this.removeCanonical(prior);
      this.addCanonical(item);
    }
    this.itemsById[item.id] = item;
  }

  private appendItem(item: UploadItem): void {
    this.itemsById[item.id] = item;
    this.orderIndex.set(item.id, this.order.length);
    this.order.push(item.id);
    this.addProvisional(item);
    this.addCanonical(item);
  }

  private removeItem(id: string): void {
    const item = this.itemsById[id];
    if (!item) return;
    this.removeProvisional(item);
    this.removeCanonical(item);
    delete this.itemsById[id];
    const index = this.orderIndex.get(id);
    if (index !== undefined) this.order[index] = null;
    this.orderIndex.delete(id);
  }

  private findCanonicalCandidate(identity: string): UploadItem | null {
    const matches = this.canonicalIndex.get(identity);
    if (!matches) return null;
    const activeId = matches.active.first();
    if (activeId) return this.itemsById[activeId] ?? null;
    const errorId = matches.error.first();
    return errorId ? this.itemsById[errorId] ?? null : null;
  }

  private resolveIdentity(id: string): boolean {
    const item = this.itemsById[id];
    if (!item || item.canonicalIdentity !== null) return false;
    const identity = canonicalIdentity(item);
    if (identity === null) return false;

    const settled = { ...item, canonicalIdentity: identity };
    // completed identity 是「新工作可以成立」的 fallback；活躍與失敗項目則優先。
    const match = this.findCanonicalCandidate(identity);

    if (!match) {
      this.replaceItem({ ...settled, mergePendingWith: null });
      this.resolutions[id] = { outcome: 'own', targetId: id, attempt: settled.attempt };
      return true;
    }

    this.removeItem(id);
    if (match.status === 'error') {
      this.replaceItem({
        ...match,
        attempt: match.attempt + 1,
        status: 'queued',
        progress: 0,
        errorStage: null,
        errorMessage: null,
        statusMessage: null,
        completedAt: null,
        contentHash: settled.contentHash,
        hashSettled: true,
        updatedAt: settled.updatedAt,
      });
      if (this.state.errorDetailId === match.id) this.state.errorDetailId = null;
      this.resolutions[id] = { outcome: 'merged', targetId: match.id, attempt: match.attempt + 1 };
      return true;
    }

    this.resolutions[id] = { outcome: 'discarded' };
    return true;
  }

  private apply(action: UploadAction): boolean {
    switch (action.type) {
      case 'enqueue': {
        const provisional = provisionalIdentity(action);
        const candidateId = this.provisionalIndex.get(provisional)?.values().next().value as string | undefined;
        const candidate = candidateId ? this.itemsById[candidateId] : null;
        const item: UploadItem = {
          id: action.id,
          name: action.name,
          destination: action.destination,
          size: action.size,
          lastModified: action.lastModified,
          provisionalIdentity: provisional,
          canonicalIdentity: null,
          mergePendingWith: candidate?.id ?? null,
          contentHash: null,
          hashSettled: false,
          status: 'queued',
          progress: 0,
          attempt: 1,
          errorStage: null,
          errorMessage: null,
          statusMessage: null,
          createdAt: action.now,
          updatedAt: action.now,
          completedAt: null,
        };
        this.appendItem(item);
        this.resolveIdentity(item.id);
        return true;
      }

      case 'setResolved': {
        const item = current((id) => this.itemsById[id], action.id, action.attempt);
        if (!item) return false;
        this.replaceItem({
          ...item,
          destination: { ...item.destination, folderResolved: true, resolvedFolderId: action.resolvedFolderId },
          updatedAt: action.now,
        });
        this.resolveIdentity(item.id);
        return true;
      }

      case 'setHash': {
        const item = current((id) => this.itemsById[id], action.id, action.attempt);
        if (!item) return false;
        this.replaceItem({ ...item, contentHash: action.contentHash, hashSettled: true, updatedAt: action.now });
        this.resolveIdentity(item.id);
        return true;
      }

      case 'setStatus': {
        const item = current((id) => this.itemsById[id], action.id, action.attempt);
        if (!item || !isActive(item) || item.status === action.status) return false;
        this.replaceItem({ ...item, status: action.status, updatedAt: action.now });
        return true;
      }

      case 'setProgress': {
        const item = current((id) => this.itemsById[id], action.id, action.attempt);
        if (!item || !isActive(item)) return false;
        const progress = Math.min(100, Math.max(0, Math.round(action.progress)));
        if (progress <= item.progress) return false;
        this.replaceItem({ ...item, progress, updatedAt: action.now });
        return true;
      }

      case 'migrationProgressReset': {
        const item = current((id) => this.itemsById[id], action.id, action.attempt);
        if (!item || !isActive(item)) return false;
        const progress = Math.min(99, Math.max(0, Math.round(action.progress)));
        this.replaceItem({ ...item, progress, statusMessage: action.message, updatedAt: action.now });
        return true;
      }

      case 'complete': {
        const item = current((id) => this.itemsById[id], action.id, action.attempt);
        if (!item || !isActive(item)) return false;
        this.replaceItem({
          ...item, status: 'complete', progress: 100, errorStage: null, errorMessage: null,
          statusMessage: null, completedAt: action.now, updatedAt: action.now, mergePendingWith: null,
        });
        return true;
      }

      case 'fail': {
        const item = current((id) => this.itemsById[id], action.id, action.attempt);
        if (!item || !isActive(item)) return false;
        this.replaceItem({
          ...item, status: 'error', errorStage: action.stage, errorMessage: action.message,
          statusMessage: null, completedAt: null, updatedAt: action.now, mergePendingWith: null,
        });
        return true;
      }

      case 'setFilter':
        if (this.state.filter === action.filter) return false;
        this.state.filter = action.filter;
        return true;

      case 'setQuery':
        if (this.state.query === action.query) return false;
        this.state.query = action.query;
        return true;

      case 'toggleCompleted':
        this.state.completedCollapsed = !this.state.completedCollapsed;
        return true;

      case 'setPanelMode':
        this.state.panelMode = action.mode;
        this.state.panelTouched = this.state.panelTouched || action.byUser;
        return true;

      case 'setErrorDetail':
        this.state.errorDetailId = action.id;
        return true;

      case 'clearTerminal': {
        const keptOrder: string[] = [];
        const keptItems: Record<string, UploadItem> = {};
        for (const id of this.order) {
          if (id === null) continue;
          const item = this.itemsById[id];
          if (!isActive(item)) continue;
          keptOrder.push(id);
          keptItems[id] = item;
        }
        const kept = new Set(keptOrder);
        for (const id of Object.keys(this.itemsById)) delete this.itemsById[id];
        Object.assign(this.itemsById, keptItems);
        this.order = keptOrder;
        this.state.order = this.order as string[];
        this.orderIndex.clear();
        this.provisionalIndex.clear();
        this.canonicalIndex.clear();
        keptOrder.forEach((id, index) => {
          const item = keptItems[id];
          this.orderIndex.set(id, index);
          this.addProvisional(item);
          this.addCanonical(item);
        });
        for (const [id, resolution] of Object.entries(this.resolutions)) {
          if (resolution.outcome === 'discarded' || !kept.has(resolution.targetId)) delete this.resolutions[id];
        }
        if (this.state.errorDetailId && !kept.has(this.state.errorDetailId)) this.state.errorDetailId = null;
        return true;
      }
    }
  }
}

export function createUploadQueueStore(
  initial: UploadQueueState = initialUploadQueueState,
  options: UploadQueueStoreOptions = {},
): UploadQueueStore {
  return new MutableUploadQueueStore(initial, options);
}

export interface UploadQueuePublisher {
  dispatch(action: UploadAction): UploadQueueState;
  cancel(): void;
}

/** Synchronously updates the working store, but coalesces React snapshots by frame. */
export function createUploadQueuePublisher(
  store: UploadQueueStore,
  scheduler: RenderScheduler,
  publish: (snapshot: UploadQueueState) => void,
): UploadQueuePublisher {
  return {
    dispatch(action) {
      const revision = store.revision;
      const state = store.dispatch(action);
      if (store.revision !== revision) scheduler.request(() => publish(store.snapshot()));
      return state;
    },
    cancel() {
      scheduler.cancel();
    },
  };
}

export function uploadQueueReducer(state: UploadQueueState, action: UploadAction): UploadQueueState {
  const store = createUploadQueueStore(state);
  store.dispatch(action);
  return store.revision === 0 ? state : store.snapshot();
}

// 20 字元以上的 base64／十六進位片段（session string、JWT），或 15 位以上的純數字
// （Telegram access hash 與 message id 是 int64，實際值常常只有 19 位，
//  接不到 20 字元的門檻）。長片段的分支排在前面，數字開頭的長 token 才會被整段遮蔽。
const SECRET_LIKE = /[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,}){0,2}|\d{15,}/g;
const MAX_MESSAGE = 200;

/** 錯誤訊息不得包含 session string、access hash、JWT 或其他憑證。 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw.trim()) return '上傳失敗，原因不明';
  const masked = raw.replace(SECRET_LIKE, '[已遮蔽]');
  return masked.length > MAX_MESSAGE ? `${masked.slice(0, MAX_MESSAGE - 1)}…` : masked;
}
