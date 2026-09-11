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
