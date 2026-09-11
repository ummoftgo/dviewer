export const scrollTranslate = (left: number): string => `translateX(${-left}px)`;

/** A display-only header after the original table in DOM order. */
export function stickyHead(wrap: HTMLElement, viewport: HTMLElement, table: HTMLTableElement) {
  const scroller = wrap.closest<HTMLElement>('.scroller');
  const original = table.tHead;
  if (!scroller || !original) return undefined;
  const layer = document.createElement('div');
  layer.className = 'table-head-layer';
  layer.dataset.dviewerUi = 'table-head';
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  const clip = document.createElement('div');
  clip.className = 'table-head-clip';
  const clone = document.createElement('table');
  clone.className = 'table-head-clone';
  const header = original.cloneNode(true) as HTMLTableSectionElement;
  for (const node of header.querySelectorAll('[data-dviewer-ui]')) node.remove();
  for (const node of [header, ...header.querySelectorAll('*')]) for (const attribute of [...node.attributes]) {
    if (attribute.name === 'id' || attribute.name === 'data-sourcepos' || attribute.name.startsWith('data-dviewer-')) node.removeAttribute(attribute.name);
  }
  const group = document.createElement('colgroup');
  const cols = Array.from({ length: original.rows[0].cells.length }, () => document.createElement('col'));
  group.append(...cols);
  clone.append(group, header);
  clip.append(clone);
  layer.append(clip);
  wrap.append(layer);
  let frame = 0;
  let left = NaN;
  const position = () => {
    frame = 0;
    const top = scroller.getBoundingClientRect().top;
    const active = (wrap.dataset.mode === 'scroll' || wrap.dataset.overflow === 'true')
      && original.getBoundingClientRect().top < top && table.getBoundingClientRect().bottom > top;
    if (layer.hasAttribute('data-active') !== active) layer.toggleAttribute('data-active', active);
    if (left !== viewport.scrollLeft) {
      left = viewport.scrollLeft;
      clone.style.transform = scrollTranslate(left);
    }
  };
  const schedule = () => { frame ||= requestAnimationFrame(position); };
  const observer = new IntersectionObserver(schedule, { root: scroller, threshold: [0, 1] });
  observer.observe(original);
  observer.observe(table);
  scroller.addEventListener('scroll', schedule, { passive: true });
  viewport.addEventListener('scroll', schedule, { passive: true });
  return {
    update(widths: number[], width: number) {
      clone.style.width = `${width}px`;
      cols.forEach((col, index) => { col.style.width = `${widths[index]}px`; });
      schedule();
    },
    destroy() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', schedule);
      viewport.removeEventListener('scroll', schedule);
      layer.remove();
    },
  };
}
