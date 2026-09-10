export function activeHeading(tops: readonly number[], scrollTop: number, offset: number, atBottom = false): number {
  if (!tops.length) return -1;
  if (scrollTop <= 0) return 0;
  if (atBottom) return tops.length - 1;
  let low = 0, high = tops.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (tops[mid] <= scrollTop + offset) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}

/** Layout reads happen on invalidation, never on an ordinary scroll frame. */
export function trackHeading(root: HTMLElement, scroller: HTMLElement, ids: string[], select: (id: string) => void) {
  let frame = 0, dirty = true, tops: number[] = [], visible: HTMLElement[] = [], offset = 0;
  const headings = ids.map(id => root.querySelector<HTMLElement>(`#${CSS.escape(id)}`)).filter((node): node is HTMLElement => !!node);
  const update = () => {
    frame = 0;
    if (dirty) {
      dirty = false;
      visible = headings.filter(node => node.checkVisibility());
      const origin = scroller.getBoundingClientRect().top + scroller.clientTop - scroller.scrollTop;
      tops = visible.map(node => node.getBoundingClientRect().top - origin);
      offset = parseFloat(getComputedStyle(document.documentElement).fontSize);
    }
    const index = activeHeading(tops, scroller.scrollTop, offset,
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1);
    select(visible[index]?.id ?? '');
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const refresh = () => { dirty = true; schedule(); };
  const observer = new ResizeObserver(refresh);
  observer.observe(root);
  observer.observe(scroller);
  scroller.addEventListener('scroll', schedule, { passive: true });
  root.addEventListener('load', refresh, true);
  root.addEventListener('toggle', refresh, true);
  document.fonts.addEventListener('loadingdone', refresh);
  refresh();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    scroller.removeEventListener('scroll', schedule);
    root.removeEventListener('load', refresh, true);
    root.removeEventListener('toggle', refresh, true);
    document.fonts.removeEventListener('loadingdone', refresh);
  };
}
