import { tick } from 'svelte';
import { t } from '../../i18n';
import { DocTab, MarkdownSearchState } from '../../state/docs.svelte';
import { findMatches } from './search';
import { indexText, matchRanges, revealMatch } from './searchDom';
import { markdownSearch } from './searchController';
import { enhanceTables } from './enhance';

const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };
export async function waitSearch(check: () => boolean, message: string, timeout = 3500): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeout) throw new Error(message);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
}

export async function checkSearchIndex(): Promise<void> {
  const scroller = document.createElement('div');
  scroller.style.cssText = 'position:fixed;left:-10000px;top:0;width:350px;height:60px;overflow:auto';
  const root = document.createElement('article');
  root.className = 'markdown-body';
  root.innerHTML = '<p>alpha<strong>beta</strong></p><p>gamma</p><table><tr><td>cellone</td><td>celltwo</td></tr></table>'
    + '<button data-dviewer-ui="test">NEVERSEARCH</button><span style="display:none">HiddenText</span>'
    + '<span class="katex"><span class="katex-mathml">duplicate</span><span class="katex-html" aria-hidden="true">visiblemath</span></span>'
    + `<details><summary>Details</summary><table><tr><th>ID</th><th>Text</th></tr><tr><td>A</td><td>${'Words in a long sentence. '.repeat(40)}</td></tr></table><p>😀needle<strong>tail</strong></p></details>`
    + `<pre><code>${'x'.repeat(800)} codeTarget</code></pre><div style="height:800px"></div>`;
  scroller.append(root); document.body.append(scroller);
  const tables = enhanceTables(root, new Map(), 'fill');
  try {
    const index = indexText(root);
    require(index.text.includes('alphabeta') && !index.text.includes('betagamma'), 'search lost inline continuity or joined paragraphs');
    require(!index.text.includes('cellonecelltwo'), 'search joined different table cells');
    require(!/NEVERSEARCH|HiddenText|duplicate/.test(index.text) && index.text.includes('visiblemath'), 'search indexed controls, hidden text, or duplicate math');
    const match = findMatches(index.text, '😀needletail', { how: 'literal', caseSensitive: true }).ranges[0];
    const ranges = matchRanges(index, match);
    require(ranges.length === 2 && ranges.map(range => range.toString()).join('') === '😀needletail', 'search did not map Unicode and inline spans to DOM ranges');
    const details = root.querySelector('details')!;
    require(!details.open, 'search collection opened details');
    await revealMatch(ranges, scroller, () => true);
    require(details.open && scroller.scrollTop > 0, 'search did not reveal a closed details match');
    await waitSearch(() => !!details.querySelector('col')?.style.width, 'details table layout did not finish');
    const bounds = ranges[0].getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
    require(Math.abs(bounds.top + bounds.height / 2 - viewport.top - scroller.clientHeight / 2) < 2,
      'search scrolled before details table layout finished');
    const codeMatch = findMatches(index.text, 'codeTarget', { how: 'literal', caseSensitive: true }).ranges[0];
    const codeRanges = matchRanges(index, codeMatch);
    await revealMatch(codeRanges, scroller, () => true);
    require(root.querySelector('pre')!.scrollLeft > 0, 'search did not scroll a wide code block horizontally');
    require(root.querySelectorAll('mark').length === 0, 'search mutated source markup to highlight matches');
  } finally { tables.destroy(); scroller.remove(); }
}

export async function checkSearchWorker(): Promise<void> {
  const scroller = document.createElement('div'), root = document.createElement('article');
  scroller.style.cssText = 'position:fixed;left:-10000px;top:0;width:350px;height:80px;overflow:auto';
  root.textContent = 'a'.repeat(32) + '!';
  scroller.append(root); document.body.append(scroller);
  const state = new MarkdownSearchState();
  state.open = true;
  const handle = markdownSearch(root, scroller, state);
  const run = async (query: string, how: 'literal' | 'regex' = 'literal') => {
    state.query = query; state.how = how;
    handle.search(query, { how, caseSensitive: true }, true);
    await waitSearch(() => !state.running, 'search worker did not finish');
  };
  try {
    let frames = 0, frame = 0;
    const heartbeat = () => { frames++; frame = requestAnimationFrame(heartbeat); };
    frame = requestAnimationFrame(heartbeat);
    try { await run('^(a+)+$', 'regex'); }
    finally { cancelAnimationFrame(frame); }
    require(state.error === 'timeout' && frames > 2, 'pathological regex did not time out with the UI responsive');
    await run('!');
    require(state.hits === 1 && !state.error, 'search did not recover after terminating the worker');
    const seq = state.seq;
    root.textContent = 'changed changed';
    await waitSearch(() => state.seq > seq && !state.running, 'search did not rebuild the replaced text index');
    require(state.hits === 0, 'search retained disconnected ranges after a DOM replacement');
    await run('changed');
    require(state.hits === 2, 'search missed the replacement DOM');
    const snapshot = root.innerHTML, stableSeq = state.seq;
    const button = document.createElement('button');
    button.dataset.dviewerUi = 'test'; button.textContent = 'changed'; root.append(button);
    await tick(); await new Promise<void>(resolve => queueMicrotask(resolve));
    require(state.seq === stableSeq && state.hits === 2, 'owned controls invalidated the text cache');
    button.remove();
    state.supported = false;
    await run('changed');
    require(state.hits === 2 && !state.error && root.innerHTML === snapshot, 'search without Highlight API changed the DOM or lost results');
    handle.search('^(a+)+$', { how: 'regex', caseSensitive: true }, true);
    handle.search('changed', { how: 'literal', caseSensitive: true }, true);
    await waitSearch(() => !state.running, 'replacement query did not finish');
    require(state.hits === 2 && !state.error, 'stale search overwrote the replacement query');
    handle.search('changed', { how: 'literal', caseSensitive: true }, true);
    handle.destroy();
    await new Promise(resolve => setTimeout(resolve, 180));
    require(!state.running && state.hits === 0, 'destroyed search accepted a late result');
  } finally {
    // Reset support before clearing the shared registry after the fallback probe.
    state.supported = typeof Highlight !== 'undefined' && !!CSS.highlights;
    handle.destroy(); scroller.remove();
  }
}

export async function checkRenderedSearch(tab: DocTab): Promise<void> {
  const state = tab.markdownSearch;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  await waitSearch(() => document.activeElement?.matches('.markdown-searchbar input[type="search"]') ?? false, 'Ctrl+F did not focus Markdown search');
  const input = document.querySelector<HTMLInputElement>('.markdown-searchbar input[type="search"]')!;
  const run = async (query: string, how: 'literal' | 'regex' = 'literal', caseSensitive = true) => {
    state.query = query; state.how = how; state.caseSensitive = caseSensitive;
    await tick();
    await waitSearch(() => !state.running && state.searched, `rendered query did not finish: ${query}`);
  };
  try {
    await run('Paragraph');
    require(state.hits === 200 && state.supported && CSS.highlights.has('md-search'), 'rendered literal search count or native highlights are missing');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    await tick(); require(state.current === 199, 'Shift+Enter did not wrap to the last match');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(); require(state.current === 0, 'Enter did not wrap to the first match');
    await run('Paragraph (?:1|2):', 'regex');
    require(state.hits === 2 && CSS.highlights.get('md-search')?.size === 2, 'rendered regex count or ranges are wrong');
    await run('paragraph', 'literal', false); require(state.hits === 200, 'case-insensitive Markdown search failed');
    await run('paragraph'); require(state.hits === 0, 'case-sensitive Markdown search ignored case');
    await run('😀'.repeat(257), 'regex');
    require(state.error === 'length' && document.querySelector('.markdown-searchbar .error')?.textContent === t('markdown.search.length'),
      'regex length limit did not show the complete translated error');
    await run('[', 'regex');
    require(state.error === 'pattern', 'invalid regex was not reported');
    require(document.querySelector('.markdown-searchbar .error')?.textContent === t('markdown.search.pattern'), 'invalid regex did not show the complete translated error');
    state.supported = false;
    await tick();
    require(document.querySelector('.markdown-searchbar [role="status"]')?.textContent?.includes(t('markdown.search.noHighlight')),
      'search did not explain the highlight fallback');
    state.supported = true;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    require(!state.open && !CSS.highlights.has('md-search') && !CSS.highlights.has('md-search-current'), 'Escape did not close and clear Markdown search');
  } finally { state.open = false; state.query = ''; await tick(); }
}
