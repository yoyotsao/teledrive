import { useCallback, useRef } from 'react';

// Touch long-press (500ms) → fires onLongPress with the touch coordinates.
// Movement beyond a small threshold cancels it (treat as a scroll/drag).
export function useLongPress(onLongPress: (x: number, y: number) => void, ms = 500) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    start.current = null;
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    start.current = { x: t.clientX, y: t.clientY };
    timer.current = window.setTimeout(() => onLongPress(start.current!.x, start.current!.y), ms);
  }, [onLongPress, ms]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t || !start.current) return;
    if (Math.abs(t.clientX - start.current.x) > 10 || Math.abs(t.clientY - start.current.y) > 10) clear();
  }, [clear]);

  return { onTouchStart, onTouchMove, onTouchEnd: clear, onTouchCancel: clear };
}
