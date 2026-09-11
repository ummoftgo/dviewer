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
  const root = document.querySelector<HTMLElement>('article.markdown-body')!;
  const scroller = root.closest<HTMLElement>('.scroller')!;
  const wrap = root.querySelector<HTMLElement>('.table-wrap')!;
  const viewport = wrap.querySelector<HTMLElement>('.table-viewport')!;
  const table = viewport.querySelector('table')!;
  const head = table.querySelector<HTMLElement>('thead th')!;
  const toggle = wrap.querySelector<HTMLButtonElement>('[data-action="mode"]')!;
  const saved = { top: scroller.scrollTop, mode: wrap.dataset.mode };
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
  } finally {
    if (wrap.dataset.mode !== saved.mode) toggle.click();
    scroller.scrollTop = saved.top;
  }
}
