import { scrollTranslate } from './stickyHead';
import { waitSearch } from './searchSmoke';
import { indexText } from './searchDom';
import { cleanCopyDom } from './copy';

const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };

/** Observe layout/scroll completion and its actual geometry, never a frame count. */
function waitTable(wrap: HTMLElement, scroller: HTMLElement, predicate: () => boolean, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); mutation.disconnect(); resize.disconnect(); scroller.removeEventListener('scroll', check);
      error ? reject(error) : resolve();
    };
    const check = () => { if (predicate()) finish(); };
    const mutation = new MutationObserver(check);
    const resize = new ResizeObserver(check);
    const timer = setTimeout(() => finish(new Error(message)), 5000);
    mutation.observe(wrap, { attributes: true, childList: true, subtree: true });
    resize.observe(wrap);
    scroller.addEventListener('scroll', check, { passive: true });
    check();
  });
}

export async function checkStickyTables(): Promise<void> {
  // HTML arrives before the asynchronous table enhancement creates these nodes.
  await waitSearch(() => !!document.querySelector('article.markdown-body .table-wrap .table-head-clone'),
    'sticky table enhancement did not finish', 60_000);
  const root = document.querySelector<HTMLElement>('article.markdown-body')!;
  const scroller = root.closest<HTMLElement>('.scroller')!;
  const wrap = root.querySelector<HTMLElement>('.table-wrap')!;
  const viewport = wrap.querySelector<HTMLElement>('.table-viewport')!;
  const table = viewport.querySelector('table')!;
  const head = table.querySelector<HTMLElement>('thead th')!;
  const toggle = wrap.querySelector<HTMLButtonElement>('[data-action="mode"]')!;
  const saved = { top: scroller.scrollTop, left: viewport.scrollLeft, mode: wrap.dataset.mode };
  try {
    await document.fonts.ready;
    if (wrap.dataset.mode !== 'fill') toggle.click();
    await waitTable(wrap, scroller, () => wrap.dataset.mode === 'fill' && wrap.dataset.overflow === 'false', 'fill table layout did not become ready');
    require(getComputedStyle(viewport).overflowY === 'visible', 'fill table retained an inner vertical scroll container');
    require(getComputedStyle(head).position === 'sticky', 'fill header is not sticky');
    scroller.scrollTop += table.getBoundingClientRect().top - scroller.getBoundingClientRect().top + head.getBoundingClientRect().height + 20;
    await waitTable(wrap, scroller, () => Math.abs(head.getBoundingClientRect().top - scroller.getBoundingClientRect().top) <= 1, 'fill header did not stick to the scroller top');
    scroller.scrollTop += table.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 20;
    await waitTable(wrap, scroller, () => head.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top + 1, 'fill header outlived its table');
    toggle.click();
    const layer = wrap.querySelector<HTMLElement>('.table-head-layer')!;
    const clone = layer.querySelector<HTMLTableElement>('.table-head-clone')!;
    const sameWidths = () => [...table.rows[0].cells].every((cell, index) => Math.abs(cell.getBoundingClientRect().width - clone.rows[0].cells[index].getBoundingClientRect().width) <= 1);
    await waitTable(wrap, scroller, () => wrap.dataset.mode === 'scroll' && sameWidths(), 'scroll clone did not use natural column widths');
    scroller.scrollTop = 0;
    await waitTable(wrap, scroller, () => !layer.hasAttribute('data-active'), 'clone appeared before its original header passed the top');
    scroller.scrollTop += table.getBoundingClientRect().top - scroller.getBoundingClientRect().top + head.getBoundingClientRect().height + 20;
    await waitTable(wrap, scroller, () => layer.hasAttribute('data-active') && Math.abs(clone.getBoundingClientRect().top - scroller.getBoundingClientRect().top) <= 1, 'scroll header did not stick');
    require(viewport.scrollWidth > viewport.clientWidth + 1, 'sticky fixture no longer exercises horizontal overflow');
    viewport.scrollLeft = Math.min(120, viewport.scrollWidth - viewport.clientWidth);
    await waitTable(wrap, scroller, () => clone.style.transform === scrollTranslate(viewport.scrollLeft), 'clone did not follow horizontal scrolling');
    const grip = table.querySelector<HTMLElement>('.table-grip')!;
    const previousWidth = table.rows[0].cells[0].getBoundingClientRect().width;
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await waitTable(wrap, scroller, () => table.rows[0].cells[0].getBoundingClientRect().width > previousWidth && sameWidths(), 'clone did not follow a resized column');
    require(layer.inert && layer.getAttribute('aria-hidden') === 'true' && !clone.querySelector('.table-grip'), 'clone exposes interactive controls');
    require(!indexText(root).nodes.some(entry => layer.contains(entry.node)), 'clone entered the search index');
    const copied = wrap.cloneNode(true) as HTMLElement;
    cleanCopyDom(copied);
    require(!copied.querySelector('.table-head-clone'), 'clone entered copied HTML');
    wrap.querySelector<HTMLButtonElement>('[data-action="reset"]')!.click();
    await waitTable(wrap, scroller, sameWidths, 'clone lost alignment after reset');
    scroller.scrollTop += table.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 20;
    await waitTable(wrap, scroller, () => !layer.hasAttribute('data-active'), 'scroll header outlived its table');
  } finally {
    if (wrap.dataset.mode !== saved.mode) toggle.click();
    viewport.scrollLeft = saved.left;
    scroller.scrollTop = saved.top;
  }
}
