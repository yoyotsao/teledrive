import { useEffect, useMemo, useRef, useState } from 'react';
import type { UploadFilter, UploadItem, UploadQueueState } from '../lib/uploadQueue';
import { selectCounts, selectFinishedLabel, selectOverallPercent, selectVisibleItems, type UploadCounts } from '../lib/uploadQueueSelectors';
import { VirtualUploadList } from './VirtualUploadList';

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

const ROW_HEIGHT = 34;

const STATUS_LABEL: Record<UploadItem['status'], string> = {
  queued: '排隊中', hashing: '計算雜湊', uploading: '上傳中',
  registering: '註冊中', complete: '已完成', error: '失敗',
};

const ERROR_LABEL: Record<NonNullable<UploadItem['errorStage']>, string> = {
  hash: '無法讀取檔案', thumbnail: '縮圖處理失敗', telegram: '上傳失敗', register: '註冊失敗',
};

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

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

function Row({ item, showPath, onErrorDetail }: { item: UploadItem; showPath: boolean; onErrorDetail: (id: string | null) => void }) {
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
        {/* 固定第二行優先顯示遷移說明；否則同名檔案才顯示相對路徑。 */}
        {item.statusMessage ? (
          <span data-testid="upload-migration-message" style={{ display: 'block', fontSize: 10, color: 'var(--td-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.statusMessage}
          </span>
        ) : showPath && item.destination.relativePath !== '' && (
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
      {item.status === 'error' && (
        <button
          data-testid="upload-row-detail-btn"
          onClick={() => onErrorDetail(item.id)}
          aria-label={`${item.name} 的錯誤詳細資訊`}
          style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)', fontSize: 12, padding: '0 2px' }}
        >ⓘ</button>
      )}
    </div>
  );
}

export function UploadCenter({ state, isVideoPreviewOpen, onFilter, onQuery, onToggleCompleted, onErrorDetail, onPanelMode, onClearTerminal }: UploadCenterProps) {
  const narrow = useIsNarrow();
  const counts = selectCounts(state);
  const percent = selectOverallPercent(state);
  const items = selectVisibleItems(state);
  // 列高必須固定，所以相對路徑只在真的有同名衝突時才出現，
  // 且 ROW_HEIGHT 已預留兩行空間。
  // 單趟計數，不用 indexOf——一次資料夾上傳的每個檔案都是可見項目，
  // 平方級的比對會在每個 animation frame 凍住 10 000 檔的面板。
  const duplicateNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const item of items) seen.set(item.name, (seen.get(item.name) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
  }, [items]);

  // spec 說的是「第一次加入上傳項目時」——一次就好。用 ref 而不是 panelTouched，
  // 因為 panelTouched 的語意是「使用者自己收合過」，不該被影片預覽強制收合借用。
  const hasAutoExpanded = useRef(false);

  // 第一次加入項目時，若沒有開著影片預覽就自動展開；使用者手動收合過就不再自動展開。
  useEffect(() => {
    if (counts.total === 0) return;
    if (hasAutoExpanded.current || state.panelTouched) return;
    // 一次性開關必須在影片預覽的提早 return 之前就用掉：預覽期間開始的上傳只
    // 該顯示收合按鈕，關閉預覽後不能再補一次自動展開（spec 影片預覽第 4 條）。
    // counts.total === 0 的 guard 仍在最前面——佇列還空著時不能消耗這個開關。
    hasAutoExpanded.current = true;
    if (isVideoPreviewOpen) return;
    if (state.panelMode === 'collapsed') onPanelMode('expanded', false);
  }, [counts.total, state.panelTouched, state.panelMode, isVideoPreviewOpen, onPanelMode]);

  // 影片預覽只是「暫時」在畫面上強制收合（見下方 collapsed 的 render-time OR），
  // 它本身不會把 panelMode 寫回 store。若不補這一段，關閉預覽的瞬間
  // isVideoPreviewOpen 變 false、panelMode 仍是先前的 'expanded'，
  // 收合按鈕會立刻被完整面板取代——違反「關閉後維持收合」的需求。
  // byUser: false——這是系統強制收合，不是使用者手動收合，panelTouched 的語意
  // 必須保留給真正的使用者操作。關閉預覽後 panelMode 仍是 'collapsed'，
  // render-time 的 OR 會讓它維持收合；而上面的自動展開 effect 不會再誤觸發，
  // 是因為 hasAutoExpanded 這個一次性開關已經用掉了，不是因為 panelTouched 被借用。
  useEffect(() => {
    if (isVideoPreviewOpen && state.panelMode !== 'collapsed') onPanelMode('collapsed', false);
  }, [isVideoPreviewOpen, state.panelMode, onPanelMode]);

  // Hook 必須跑在提早 return 之前，否則佇列從空變成有項目時 hook 數量會改變。
  if (counts.total === 0) return null;

  // 影片預覽期間一律收合，且不接受展開——面板最小寬度 360 px 與播放器安全區域
  // 無法同時滿足「不遮擋播放器」與「失敗清單仍可讀」。
  const collapsed = isVideoPreviewOpen || state.panelMode === 'collapsed';

  if (collapsed) {
    const name = counts.active > 0
      ? `上傳中心，${percent}%，剩餘 ${counts.active} 項${counts.error > 0 ? `，失敗 ${counts.error} 項` : ''}`
      : counts.error > 0 ? `上傳中心，失敗 ${counts.error} 項` : '上傳中心，全部完成';
    return (
      <>
        <ErrorLiveRegion count={counts.error} />
        <button
          data-testid="upload-center-collapsed"
          aria-label={isVideoPreviewOpen ? `${name}（關閉預覽後可展開）` : name}
          onClick={() => { if (!isVideoPreviewOpen) onPanelMode('expanded', true); }}
          style={{
            position: 'fixed', zIndex: 1100,
            ...(isVideoPreviewOpen
              // 預覽遮罩的 zIndex 是 1000，按鈕必須在它之上。預覽卡片的 ✕／↓ 是
              // absolute top:8 / right:8、48（相對卡片，不是相對 viewport），卡片
              // 最高 90vh，所以在不夠高的視窗裡右上角一定會壓到那兩顆按鈕。卡片
              // 置中且最寬 90vw，左上角永遠在卡片之外——固定在左上角安全區。
              ? { top: 12, left: 12 }
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
      </>
    );
  }

  const label = selectFinishedLabel(state);
  const listHeight = Math.min(items.length * ROW_HEIGHT, Math.round(window.innerHeight * 0.65) - 120);

  return (
    <>
      <ErrorLiveRegion count={counts.error} />
      <div
      data-testid="upload-center"
      role="region"
      aria-label="上傳中心"
      style={{
        position: 'fixed', zIndex: 1100,
        display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
        background: 'var(--td-surface)', border: '1px solid var(--td-border)',
        // 預覽遮罩的 zIndex 是 1000（控制項 1001），面板必須在它之上；
        // 但仍低於 DetailsPanel(1500)、對話框(2000)與右鍵選單(3000)。
        boxShadow: `0 4px 12px var(--td-shadow)`,
        ...(narrow
          ? { left: 8, right: 8, bottom: 0, maxHeight: '60vh', borderRadius: '8px 8px 0 0' }
          : { right: 16, bottom: 16, width: 380, maxHeight: '65vh', borderRadius: 8 }),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--td-border)' }}>
        <span data-testid="upload-center-title" style={{ fontSize: 13, fontWeight: 600, color: 'var(--td-text-strong)' }}>
          上傳中心 {label.finished.toLocaleString()} / {label.total.toLocaleString()}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {counts.error > 0 && (
            <span data-testid="upload-center-error-badge" style={{ fontSize: 12, fontWeight: 600, color: '#dc2626' }}>
              失敗 {counts.error}
            </span>
          )}
          <button
            data-testid="upload-center-toggle"
            onClick={() => onPanelMode('collapsed', true)}
            aria-label="收合上傳中心"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--td-text-muted)', fontSize: 13 }}
          >收合</button>
        </div>
      </div>

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

      <VirtualUploadList
        items={items}
        rowHeight={ROW_HEIGHT}
        height={Math.max(ROW_HEIGHT, listHeight)}
        renderRow={(item) => <Row item={item} showPath={duplicateNames.has(item.name)} onErrorDetail={onErrorDetail} />}
      />

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
    </>
  );
}
