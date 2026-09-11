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
