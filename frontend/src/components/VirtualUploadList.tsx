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
