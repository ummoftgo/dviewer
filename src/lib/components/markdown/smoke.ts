import { copyHtml } from '../../clipboard';
import { highlightCode } from '../../ipc';
import { DocTab } from '../../state/docs.svelte';
import { settings } from '../../state/settings.svelte';
import { blockDescription, blockElements, cleanCopyDom, htmlForCopy, copyMarkdown } from './copy';
import { rawBlock } from './blocks';
import { enhanceBlocks, markBlocks } from './blockControls';
import { enhanceCode } from './codeControls';
import { measureColumns } from './measureTable';
import { enhanceTables } from './enhance';
import { recommendWidths, type TableState } from './tables';

const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export async function checkToc(tab: DocTab): Promise<void> {
  const root = document.querySelector<HTMLElement>('article.markdown-body')!;
  const scroller = root.closest<HTMLElement>('.scroller')!;
  const nav = document.querySelector<HTMLElement>('nav[aria-label]')!;
  const buttons = [...nav.querySelectorAll<HTMLButtonElement>('button')];
  require(buttons.length === tab.toc.length, 'TOC entries do not match headings');
  const waitCurrent = (index: number) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`TOC did not activate heading ${index}`)); }, 3000);
    const check = () => {
      if (buttons[index].getAttribute('aria-current') !== 'true') return;
      clearTimeout(timeout); observer.disconnect(); resolve();
    };
    const observer = new MutationObserver(check);
    observer.observe(nav, { attributes: true, subtree: true, attributeFilter: ['aria-current'] });
    check();
  });
  const theme = settings.theme;
  const changeTheme = (next: typeof theme) => new Promise<void>((resolve, reject) => {
    const first = root.firstElementChild;
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('theme did not finish replacing the document')); }, 4000);
    const observer = new MutationObserver(() => {
      if (root.firstElementChild === first || !root.querySelector('[data-dviewer-ui="copy"]')) return;
      clearTimeout(timer); observer.disconnect(); resolve();
    });
    observer.observe(root, { childList: true, subtree: true });
    settings.theme = next;
  });
  try {
    scroller.scrollTop = 0;
    await waitCurrent(0);
    const middle = Math.floor(buttons.length / 2);
    const heading = root.querySelector<HTMLElement>(`#${CSS.escape(tab.toc[middle].id)}`)!;
    scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    await waitCurrent(middle);
    await frame();
    require(nav.scrollTop > 0, 'TOC did not follow the current heading');
    nav.dispatchEvent(new MouseEvent('mouseenter'));
    await frame();
    nav.scrollTop = 0;
    scroller.scrollTop = scroller.scrollHeight;
    await waitCurrent(buttons.length - 1);
    await frame();
    require(nav.scrollTop === 0, 'TOC moved under the pointer');
    nav.dispatchEvent(new MouseEvent('mouseleave'));
    await frame();
    require(nav.scrollTop > 0, 'TOC did not resume following after pointer exit');
    buttons[1].focus({ preventScroll: true });
    await frame();
    nav.scrollTop = 0;
    buttons[middle].click();
    await waitCurrent(middle);
    let lastScroll = scroller.scrollTop, stableSince = performance.now();
    const deadline = stableSince + 3000;
    while (performance.now() - stableSince < 100) {
      await frame();
      if (scroller.scrollTop !== lastScroll) { lastScroll = scroller.scrollTop; stableSince = performance.now(); }
      require(performance.now() < deadline, 'TOC click did not settle');
    }
    require(buttons[middle].getAttribute('aria-current') === 'true', 'TOC lost the clicked heading after native scroll rounding');
    require(nav.scrollTop === 0, 'TOC moved while keyboard focus was inside');
    buttons[1].blur();
    await changeTheme(settings.resolvedTheme === 'dark' ? 'light' : 'dark');
    scroller.scrollTop = 0;
    await waitCurrent(0);
    const replaced = root.querySelector<HTMLElement>(`#${CSS.escape(tab.toc[middle].id)}`)!;
    scroller.scrollTop += replaced.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    await waitCurrent(middle);
  } finally {
    if (settings.theme !== theme) await changeTheme(theme);
    nav.dispatchEvent(new MouseEvent('mouseleave'));
    scroller.scrollTop = 0;
    await waitCurrent(0);
  }
}

export async function checkTableRecommendation(): Promise<void> {
  const root = document.createElement('article');
  root.className = 'markdown-body';
  root.style.cssText = 'position:fixed;left:-100000px;top:0;width:900px';
  const table = document.createElement('table');
  for (let i = 0; i < 32; i++) {
    const row = table.insertRow();
    row.insertCell().textContent = i === 31 ? 'Supercalifragilisticexpialidocious' : 'ID';
    row.insertCell().textContent = 'A sentence with many separate words. '.repeat(12);
  }
  const lastCell = table.rows[31].cells[0];
  lastCell.style.whiteSpace = 'nowrap';
  root.append(table);
  document.body.append(root);
  await document.fonts.ready;
  const word = document.createRange();
  word.selectNodeContents(lastCell);
  const wordWidth = word.getBoundingClientRect().width;
  const original = table.rows[0];
  const observation = new MutationObserver(() => {});
  observation.observe(document.body, { childList: true });
  try {
    const measured = measureColumns(table, root);
    const probe = observation.takeRecords().flatMap((record) => [...record.addedNodes])
      .find((node) => node instanceof HTMLElement && node.dataset.dviewerUi === 'table-measure') as HTMLElement;
    require(probe?.querySelector('table')?.rows.length === 20, 'recommendation did not limit its sample to 20 rows');
    require(!probe.isConnected && !root.querySelector('[data-dviewer-ui="table-measure"]'), 'measurement DOM leaked into the document');
    require(table.rows.length === 32 && table.rows[0] === original, 'measurement replaced or copied the original rows');
    require(measured[0].min >= wordWidth && measured[0].min > 100, 'recommendation broke a sampled word into characters');
    require(measured[1].max > measured[1].min * 3, 'recommendation lost the difference between words and sentences');
    const states = new Map<number, TableState>();
    // A not-yet-sized viewport must receive its first recommendation later.
    root.style.width = '0px';
    const handle = enhanceTables(root, states, 'fill');
    try {
      root.style.width = '900px';
      const state = states.get(0)!;
      const viewport = table.parentElement!;
      // The product's observer was registered first. Its queued layout must run
      // before this observer's frame; returning a handle does not mean it settled.
      await new Promise<void>((resolve, reject) => {
        let frameId = 0;
        const timer = setTimeout(() => {
          watcher.disconnect(); cancelAnimationFrame(frameId);
          reject(new Error('initial recommended layout did not complete'));
        }, 20_000);
        const watcher = new ResizeObserver(() => {
          if (!viewport.clientWidth) return;
          watcher.disconnect();
          frameId = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
        });
        watcher.observe(viewport);
      });
      const widths = [...table.rows[0].cells].map((cell) => cell.getBoundingClientRect().width);
      const border = table.getBoundingClientRect().width - widths.reduce((sum, width) => sum + width, 0);
      const minimum = 3 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      const expected = recommendWidths(measured, viewport.clientWidth - border, minimum);
      require(widths.every((width, i) => Math.abs(width - expected[i]) < 1),
        `default fill did not use the measured recommendation: ${JSON.stringify({ widths, expected, viewport: viewport.clientWidth, columns: [...table.querySelectorAll('col')].map(col => col.style.width) })}`);
      require(!state.fillRatios, 'automatic recommendation was frozen as manual ratios');
      const group = table.querySelector('colgroup')!;
      const columnState = () => [...group.querySelectorAll('col')].map((col) => col.style.width).join(',');
      const changed = (update: () => void) => new Promise<void>((resolve, reject) => {
        const before = columnState();
        const timer = setTimeout(() => { watcher.disconnect(); reject(new Error('recommended layout did not complete')); }, 20_000);
        const watcher = new MutationObserver(() => {
          if (columnState() === before) return;
          clearTimeout(timer); watcher.disconnect(); resolve();
        });
        watcher.observe(group, { attributes: true, attributeFilter: ['style'], subtree: true });
        update();
      });
      await changed(() => { root.style.width = '1050px'; });
      require(Math.abs(table.getBoundingClientRect().width - viewport.clientWidth) < 1 && !state.fillRatios,
        'automatic recommendation did not follow the document width');
      await changed(() => { root.style.fontSize = `${parseFloat(getComputedStyle(root).fontSize) + 3}px`; handle.refresh(); });
      const refreshed = measureColumns(table, root);
      require(refreshed[0].min > measured[0].min, 'font probe did not grow the sampled word');
      const after = recommendWidths(refreshed, viewport.clientWidth - border, minimum);
      require([...table.rows[0].cells].every((cell, i) => Math.abs(cell.getBoundingClientRect().width - after[i]) < 1),
        'font refresh kept stale recommended measurements');
    } finally { handle.destroy(); }
  } finally { observation.disconnect(); root.remove(); }
}

/** Runs in the native smoke WebView. No DOM emulator or UI-test dependency. */
export async function checkMarkdownCopy(tab: DocTab): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!document.querySelector('.markdown-body .code-language')) {
    if (Date.now() > deadline) throw new Error('markdown copy controls did not settle');
    await frame();
  }
  const host = document.querySelector<HTMLElement>('.markdown-body')!;
  const controls = enhanceBlocks(host, () => {});
  require(enhanceBlocks(host, () => {}) === controls && host.querySelectorAll('.block-copy').length === 1, 'copy controls are not idempotent');
  const pristine = document.createElement('article');
  pristine.innerHTML = tab.html!;
  const elements = blockElements(pristine);
  const blocks = elements.map(blockDescription);
  const raw = await tab.loadRaw();
  require(pristine.querySelector('[data-sourcepos]') && !pristine.querySelector('em[data-sourcepos], code[data-sourcepos]'), 'block/inline source positions changed');
  const paragraph = elements.findIndex((element) => element.tagName === 'P' && element.hasAttribute('data-sourcepos'));
  require(paragraph >= 0 && rawBlock(raw, blocks, paragraph) !== null, 'paragraph cannot be copied from source');
  const html = htmlForCopy(tab.html!);
  require(!html.includes('data-sourcepos') && !html.includes('data-dviewer-'), 'HTML copy leaked internal attributes');
  checkCopyCleanup();

  // Inspect the actual native ClipboardItem payload without making headless CI
  // depend on OS clipboard focus. A separate interactive check reads back OS MIME.
  const descriptor = Object.getOwnPropertyDescriptor(navigator.clipboard, 'write');
  const textDescriptor = Object.getOwnPropertyDescriptor(navigator.clipboard, 'writeText');
  const previousStyled = settings.markdownCopyStyled;
  let copiedText = '';
  let items: ClipboardItems = [];
  try {
    // This case asserts unstyled HTML; never inherit a reader's saved preference.
    settings.markdownCopyStyled = false;
    Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async (value: ClipboardItems) => { items = value; } });
    await copyMarkdown(tab, 'html');
    require(items.length === 1 && items[0].types.includes('text/html') && items[0].types.includes('text/plain'), 'HTML copy is missing a MIME type');
    require(await (await items[0].getType('text/html')).text() === html, 'HTML clipboard payload changed');
    require(await (await items[0].getType('text/plain')).text() === html, 'HTML source is missing from the plain clipboard payload');
    await copyMarkdown(tab, 'html', paragraph);
    const blockHtml = htmlForCopy(tab.html!, paragraph);
    require(await (await items[0].getType('text/plain')).text() === blockHtml && blockHtml !== html, 'block HTML copy supplied the wrong plain payload');
    require(await (await items[0].getType('text/html')).text() === blockHtml, 'block HTML MIME differs from its source');
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (value: string) => { copiedText = value; } });
    await copyMarkdown(tab, 'raw');
    require(copiedText === raw, 'source copy stopped supplying Markdown');
    Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async () => { throw new Error('refused'); } });
    let rejected = false;
    try { await copyHtml(html); } catch { rejected = true; }
    require(rejected, 'failed HTML copy was reported as success');
  } finally {
    settings.markdownCopyStyled = previousStyled;
    if (descriptor) Object.defineProperty(navigator.clipboard, 'write', descriptor);
    else Reflect.deleteProperty(navigator.clipboard, 'write');
    if (textDescriptor) Object.defineProperty(navigator.clipboard, 'writeText', textDescriptor);
    else Reflect.deleteProperty(navigator.clipboard, 'writeText');
  }

  await checkCopyPosition();
  await checkCopyHover();

  const codeHandle = enhanceCode(host, tab, () => {});
  require(enhanceCode(host, tab, () => {}) === codeHandle, 'language controls are not idempotent');
  const probe = document.createElement('article');
  probe.style.cssText = 'position:fixed;left:-100000px';
  const pre = pristine.querySelector('pre:has(> code)')!.cloneNode(true) as HTMLElement;
  probe.append(pre);
  document.body.append(probe);
  const target = new DocTab(tab.meta);
  target.codeLanguages = tab.codeLanguages;
  let release!: () => void;
  let started!: () => void;
  let gate = new Promise<void>((resolve) => { release = resolve; });
  let pending = new Promise<void>((resolve) => { started = resolve; });
  const tested = enhanceCode(probe, target, () => {}, async (name, source) => {
    const result = await highlightCode(name, source);
    if (name === 'Rust') { started(); await gate; }
    return result;
  });
  const control = tested.controls[0];
  const code = pre.querySelector('code')!;
  const source = code.textContent!;
  const expectedCode = document.createElement('code');
  expectedCode.innerHTML = (await highlightCode('JSON', source)).html;
  const expected = expectedCode.innerHTML;
  try {
    const first = control.select('Rust');
    await pending;
    await control.select('JSON');
    release();
    await first;
    require(code.innerHTML === expected && control.language.name === 'JSON' && target.codeSelections.get(0) === 'JSON', 'late syntax reply overwrote a newer choice');
    for (const name of ['Fish', 'Sass', 'js']) {
      await control.select(name);
      const applied = await highlightCode(name, source);
      expectedCode.innerHTML = applied.html;
      require(control.language.name === applied.language.name && control.button.textContent?.includes(applied.language.name)
        && target.codeSelections.get(0) === applied.language.name && code.innerHTML === expectedCode.innerHTML,
        'syntax choice label differs from the applied grammar');
    }
    await control.select('JSON');
    gate = new Promise<void>((resolve) => { release = resolve; });
    pending = new Promise<void>((resolve) => { started = resolve; });
    const old = control.select('Rust');
    await pending;
    target.invalidate();
    release();
    await old;
    require(code.innerHTML === expected && target.codeSelections.size === 0, 'reply crossed the reinterpretation generation');
    require(code.textContent === source, 're-highlighting changed code text');
  } finally { release(); tested.destroy(); probe.remove(); }
  const firstBlock = host.querySelector<HTMLElement>('[data-dviewer-block]')!;
  firstBlock.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  controls.button.focus();
  controls.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  require(host.querySelector('[data-dviewer-selected]')?.getAttribute('data-dviewer-block') === '1', 'keyboard cannot reach the next block');
}

/** A floating control must not change which document block is the first child. */
export async function checkCopyPosition(): Promise<void> {
  const root = document.createElement('article');
  root.className = 'markdown-body';
  root.style.cssText = 'position:fixed;left:-100000px;top:0;width:280px';
  root.innerHTML = '<h1>First heading</h1><p>Another block</p>';
  document.body.append(root);
  markBlocks(root);
  const heading = root.querySelector('h1')!;
  const paragraph = root.querySelector('p')!;
  const top = heading.getBoundingClientRect().top;
  const controls = enhanceBlocks(root, () => {});
  const unchanged = () => require(root.firstElementChild === heading && Math.abs(heading.getBoundingClientRect().top - top) < 1,
    'copy control moved the first heading');
  try {
    unchanged();
    for (const block of [paragraph, heading, paragraph]) {
      block.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      unchanged();
      require(Math.abs(parseFloat(controls.button.style.top) - block.offsetTop) < 1, 'copy control did not follow its block');
    }
    heading.style.paddingBottom = '40px';
    root.dispatchEvent(new Event('load'));
    await frame();
    require(Math.abs(parseFloat(controls.button.style.top) - paragraph.offsetTop) < 1, 'copy control missed a layout change');
  } finally { controls.destroy(); root.remove(); }
}

/** Same sanitised document and table state; only the new controls differ. */
export async function measureMarkdown(tab: DocTab) {
  const { enhanceTables, renderMath, renderMermaid, rewriteImages } = await import('./enhance');
  const { markBlocks } = await import('./blockControls');
  const host = document.querySelector<HTMLElement>('.markdown-body')!;
  const original = document.createElement('article');
  original.className = 'markdown-body';
  original.style.cssText = `position:fixed;left:-100000px;top:0;width:${host.clientWidth}px`;
  document.body.append(original);
  const post = { before: [] as number[], after: [] as number[] };
  const parse = { before: [] as number[], after: [] as number[] };
  const hover: number[] = [];
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  };
  try {
    for (let run = 0; run < 7; run++) {
      for (const mode of run % 2 ? ['after', 'before'] as const : ['before', 'after'] as const) {
        let start = performance.now();
        original.innerHTML = tab.html!;
        const parseMs = performance.now() - start;
        start = performance.now();
        if (mode === 'after') markBlocks(original);
        rewriteImages(original, tab.meta);
        await Promise.all([renderMermaid(original, false), renderMath(original)]);
        const tables = enhanceTables(original, new Map(), tab.markdownTableMode);
        const blocks = mode === 'after' ? enhanceBlocks(original, () => {}) : undefined;
        const code = mode === 'after' ? enhanceCode(original, tab, () => {}) : undefined;
        void original.offsetHeight;
        const elapsed = performance.now() - start;
        if (run > 0) { post[mode].push(elapsed); parse[mode].push(parseMs); }
        if (mode === 'after' && run > 0) {
          for (const element of blockElements(original).filter((node) => node.hasAttribute('data-dviewer-block')).slice(0, 60)) {
            const before = performance.now();
            element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            void blocks!.button.offsetTop;
            hover.push(performance.now() - before);
          }
        }
        code?.destroy(); blocks?.destroy(); tables.destroy();
        original.replaceChildren();
      }
    }
    return { headings: tab.toc.length, codeBlocks: Object.keys(tab.codeLanguages).length,
      tables: (tab.html!.match(/<table\b/g) ?? []).length,
      samples: post, parseSamples: parse, medianPostMs: { before: median(post.before), after: median(post.after) },
      controlParseMs: { before: median(parse.before), after: median(parse.after) },
      hoverSamples: hover.length, hoverMedianMs: median(hover), hoverMaxMs: Math.max(...hover) };
  } finally { original.remove(); }
}

export function checkCopyCleanup(): void {
  const clone = document.createElement('article');
  const owned = document.createElement('button');
  owned.dataset.dviewerUi = 'test';
  owned.textContent = 'owned control';
  clone.append(owned);
  const author = document.createElement('p');
  author.className = 'table-tools';
  author.textContent = 'author content';
  clone.append(author);
  const wrapper = document.createElement('div');
  wrapper.dataset.dviewerWrap = 'test';
  const table = document.createElement('table');
  wrapper.append(table);
  clone.append(wrapper);
  const image = document.createElement('img');
  image.src = 'http://asset.localhost/changed';
  image.dataset.dviewerSrc = './original.png';
  clone.append(image);
  cleanCopyDom(clone);
  require(!clone.contains(owned), 'HTML cleanup kept an owned button');
  require(clone.contains(author), 'HTML cleanup removed an author class');
  require(table.parentElement === clone, 'HTML cleanup kept a table wrapper');
  require(image.getAttribute('src') === './original.png', 'HTML cleanup lost the original image path');

}

/** Follow the reader's route through the actual CSS margin hit area. */
export async function checkCopyHover(): Promise<void> {
  const root = document.createElement('article');
  root.className = 'markdown-body';
  root.style.cssText = 'position:fixed;left:80px;top:120px;width:280px;z-index:9999';
  root.innerHTML = '<p>Block hover target</p>';
  document.body.append(root);
  markBlocks(root);
  let copied = -1;
  const controls = enhanceBlocks(root, (index) => { copied = index; });
  const block = root.querySelector('p')!;
  const button = controls.button;
  const events: unknown[] = [];
  for (const type of ['pointerover', 'pointerout', 'pointerleave', 'focusin', 'focusout']) root.addEventListener(type, event => {
    events.push({ type, trusted: event.isTrusted, target: (event.target as Element)?.tagName,
      related: ((event as PointerEvent).relatedTarget as Element)?.tagName, at: performance.now() });
  });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 240));
  try {
    button.blur();
    block.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await frame();
    const blockBox = block.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const gap = document.elementFromPoint((buttonBox.right + blockBox.left) / 2, buttonBox.top + buttonBox.height / 2);
    require(gap === button || (gap && button.contains(gap)), 'copy button margin has an unbridged gap');
    // Leaving the block is not enough to hide it; a pointer can still be in transit.
    root.dispatchEvent(new PointerEvent('pointerleave', { relatedTarget: document.body }));
    require(button.dataset.visible === 'true', 'copy button vanished before reaching the margin');
    gap!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: block }));
    await pause();
    require(button.dataset.visible === 'true', 'copy button vanished over the margin bridge');
    button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: gap }));
    await pause();
    require(button.dataset.visible === 'true', `copy button vanished while hovered: ${JSON.stringify(events)}`);
    button.click();
    require(copied === 0 && root.querySelectorAll('.block-copy').length === 1, 'hover copy cannot be clicked or was duplicated');
    button.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    root.dispatchEvent(new PointerEvent('pointerleave', { relatedTarget: document.body }));
    await pause();
    require(!button.hasAttribute('data-visible'), 'copy button stayed after leaving both targets');
    block.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    root.dispatchEvent(new PointerEvent('pointerleave', { relatedTarget: document.body }));
    controls.destroy();
    await pause();
    require(!root.querySelector('.block-copy'), 'hover cleanup left its button behind');
  } finally { controls.destroy(); root.remove(); }
}
