/**
 * Attach manual wheel + touch scrolling to a scroll container along one axis,
 * driving scrollLeft/scrollTop ourselves and stopping the event so ancestor
 * scroll-lockers (react-remove-scroll) / the thread behind can't hijack it.
 * Only consumes gestures where the target axis dominates, so an orthogonal swipe
 * (e.g. a vertical swipe on a horizontal tab strip) still passes through.
 *
 * Horizontal strips that use this should also carry `scrollbar-hide`: they are
 * a single row of icons with a few px of padding, and the native horizontal
 * scrollbar renders INSIDE the box, straight over the icons. With wheel + drag
 * handled here the scrollbar is redundant anyway (mobile already runs
 * showsHorizontalScrollIndicator={false} on the equivalent strips).
 *
 * Returns a cleanup function.
 */
export function attachManualScroll(el: HTMLElement, axis: 'x' | 'y'): () => void {
  const apply = (delta: number): boolean => {
    const size = axis === 'y' ? el.clientHeight : el.clientWidth;
    const scrollSize = axis === 'y' ? el.scrollHeight : el.scrollWidth;
    const pos = axis === 'y' ? el.scrollTop : el.scrollLeft;
    if (scrollSize <= size) return false; // nothing to scroll
    if ((pos <= 0 && delta < 0) || (pos + size >= scrollSize - 1 && delta > 0)) return false; // at edge
    if (axis === 'y') el.scrollTop += delta; else el.scrollLeft += delta;
    return true;
  };

  const onWheel = (e: WheelEvent) => {
    // Support vertical wheels on the horizontal strip (common on trackpads/mice).
    const delta = axis === 'y'
      ? e.deltaY
      : (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
    if (apply(delta)) { e.preventDefault(); e.stopPropagation(); }
  };

  let lastX = 0, lastY = 0;
  const onTouchStart = (e: TouchEvent) => {
    lastX = e.touches[0]?.clientX ?? 0;
    lastY = e.touches[0]?.clientY ?? 0;
  };
  const onTouchMove = (e: TouchEvent) => {
    const x = e.touches[0]?.clientX ?? lastX;
    const y = e.touches[0]?.clientY ?? lastY;
    const dx = lastX - x, dy = lastY - y;
    lastX = x; lastY = y;
    const dominates = axis === 'y' ? Math.abs(dy) >= Math.abs(dx) : Math.abs(dx) >= Math.abs(dy);
    if (!dominates) return; // let the orthogonal gesture through
    apply(axis === 'y' ? dy : dx);
    e.preventDefault();
    e.stopPropagation();
  };

  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  return () => {
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchmove', onTouchMove);
  };
}
