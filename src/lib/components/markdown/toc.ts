export function activeHeading(tops: readonly number[], scrollTop: number, offset: number, atBottom = false): number {
  if (!tops.length) return -1;
  if (scrollTop <= 0) return 0;
  if (atBottom) return tops.length - 1;
  let low = 0, high = tops.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    // Native scrolling rounds its destination; layout positions stay fractional.
    if (tops[mid] <= scrollTop + offset + 1) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}

/** Layout reads happen on invalidation, never on an ordinary scroll frame. */
export function headingPositions(root: HTMLElement, scroller: HTMLElement, ids: string[]) {
  const origin = scroller.getBoundingClientRect().top + scroller.clientTop - scroller.scrollTop;
  return ids.map(id => root.querySelector<HTMLElement>(`#${CSS.escape(id)}`))
    .filter((node): node is HTMLElement => !!node && node.checkVisibility())
    .map(node => ({id:node.id,top:node.getBoundingClientRect().top - origin}));
}

export function trackHeading(root: HTMLElement, scroller: HTMLElement, ids: string[], select: (id: string) => void,
  capture?: (headings: {id:string;top:number}[], top:number, max:number) => void) {
  let frame = 0, dirty = true, tops: number[] = [], visible: HTMLElement[] = [], offset = 0;
  const headings = ids.map(id => root.querySelector<HTMLElement>(`#${CSS.escape(id)}`)).filter((node): node is HTMLElement => !!node);
  let positions: {id:string;top:number}[] = [];
  const update = () => {
    frame = 0;
    if (dirty) {
      dirty = false;
      visible = headings.filter(node => node.checkVisibility());
      const origin = scroller.getBoundingClientRect().top + scroller.clientTop - scroller.scrollTop;
      tops = visible.map(node => node.getBoundingClientRect().top - origin);
      positions = visible.map((node,index) => ({id:node.id,top:tops[index]}));
      offset = parseFloat(getComputedStyle(document.documentElement).fontSize);
    }
    const index = activeHeading(tops, scroller.scrollTop, offset,
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1);
    select(visible[index]?.id ?? '');
    capture?.(positions, scroller.scrollTop, Math.max(0,scroller.scrollHeight - scroller.clientHeight));
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
    // A tab switch can precede the scheduled animation frame.
    cancelAnimationFrame(frame);
    if (scroller.isConnected) update();
    observer.disconnect();
    scroller.removeEventListener('scroll', schedule);
    root.removeEventListener('load', refresh, true);
    root.removeEventListener('toggle', refresh, true);
    document.fonts.removeEventListener('loadingdone', refresh);
  };
}
