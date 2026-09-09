import { copyHtml } from '../../clipboard';
import { highlightCode } from '../../ipc';
import { DocTab } from '../../state/docs.svelte';
import { blockDescription, blockElements, cleanCopyDom, htmlForCopy } from './copy';
import { rawBlock } from './blocks';
import { enhanceBlocks } from './blockControls';
import { enhanceCode } from './codeControls';

const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

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
  let items: ClipboardItems = [];
  try {
    Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async (value: ClipboardItems) => { items = value; } });
    await copyHtml(html, raw);
    require(items.length === 1 && items[0].types.includes('text/html') && items[0].types.includes('text/plain'), 'HTML copy is missing a MIME type');
    require(await (await items[0].getType('text/html')).text() === html, 'HTML clipboard payload changed');
    require(await (await items[0].getType('text/plain')).text() === raw, 'plain clipboard payload changed');
    Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async () => { throw new Error('refused'); } });
    let rejected = false;
    try { await copyHtml(html, raw); } catch { rejected = true; }
    require(rejected, 'failed HTML copy was reported as success');
  } finally {
    if (descriptor) Object.defineProperty(navigator.clipboard, 'write', descriptor);
    else Reflect.deleteProperty(navigator.clipboard, 'write');
  }

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
  expectedCode.innerHTML = await highlightCode('JSON', source);
  const expected = expectedCode.innerHTML;
  try {
    const first = control.select('Rust');
    await pending;
    await control.select('JSON');
    release();
    await first;
    require(code.innerHTML === expected && control.language.name === 'JSON' && target.codeSelections.get(0) === 'JSON', 'late syntax reply overwrote a newer choice');
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
  require(controls.button.nextElementSibling?.getAttribute('data-dviewer-block') === '1', 'keyboard cannot reach the next block');
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
