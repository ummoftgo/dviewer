import { tick } from 'svelte';
import { t } from '../../i18n';
import { DocTab, MarkdownSearchState } from '../../state/docs.svelte';
import { findMatches, type Matches } from './search';
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
    const breaks = findMatches(index.text, '\n', { how: 'literal', caseSensitive: true }).ranges;
    require(breaks.length > 0 && breaks.every(match => matchRanges(index, match).length > 0),
      'search dropped a structural newline match');
    const firstBreak = matchRanges(index, breaks[0])[0];
    require(firstBreak.collapsed && firstBreak.startContainer.textContent === 'gamma', 'structural newline did not anchor at the following text');
    const empty = document.createElement('p'); empty.innerHTML = '<br>';
    require(matchRanges(indexText(empty), [0, 1])[0]?.startContainer === empty, 'a standalone line break lost its navigation anchor');
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

async function checkToolbarSearch(tab: DocTab): Promise<void> {
  tab.markdownSearch.open = false;
  await tick();
  const button = document.querySelector<HTMLButtonElement>('.toolbar [data-action="search-markdown"]');
  require(button?.getAttribute('aria-pressed') === 'false' && button.title === t('toolbar.search')
    && button.getAttribute('aria-label') === t('toolbar.search'), 'toolbar search button state or tooltip is wrong');
  button!.click();
  await waitSearch(() => tab.markdownSearch.open && button!.getAttribute('aria-pressed') === 'true'
    && (document.activeElement?.matches('.markdown-searchbar input[type="search"]') ?? false),
    'toolbar button did not open and focus Markdown search');
  if (tab.markdownSearch.query) await waitSearch(() => tab.markdownSearch.searched && !tab.markdownSearch.running, 'toolbar query did not finish');
  button!.focus(); // The following Ctrl+F must move focus back into the search input.
}

export async function checkRenderedSearch(tab: DocTab): Promise<void> {
  const state = tab.markdownSearch;
  await checkToolbarSearch(tab);
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

export async function checkRawSearch(tab: DocTab): Promise<void> {
  const state = tab.markdownSearch;
  state.open = true; state.query = '## Section'; state.how = 'literal'; state.caseSensitive = true;
  await tick();
  await waitSearch(() => state.searched && !state.running, 'rendered markup query did not finish');
  require(state.hits === 0, 'rendered search unexpectedly included heading markup');
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }));
    await waitSearch(() => !!document.querySelector('.raw-view .source') && state.searched && !state.running,
      'raw view did not rerun the shared query');
    require(state.query === '## Section' && state.hits === 200, 'raw view lost the query or did not search markup');
    const source = document.querySelector<HTMLElement>('.raw-view .source')!;
    const scroller = source.closest<HTMLElement>('.scroller')!;
    const gutter = scroller.querySelector<HTMLElement>('.gutter')!;
    require(source.childNodes.length === 1 && source.textContent === tab.raw, 'raw highlighting changed the source text node');
    require(getComputedStyle(source).lineHeight === getComputedStyle(gutter).lineHeight, 'raw search misaligned the line-number gutter');
    state.query = '200';
    await tick();
    await waitSearch(() => !state.running && state.searched, 'raw numeric query did not finish');
    require(state.hits === findMatches(tab.raw!, '200', { how: 'literal', caseSensitive: true }).ranges.length,
      'raw search included the line-number gutter');
    state.query = '## Section';
    await tick();
    await waitSearch(() => !state.running && state.searched, 'raw heading query did not resume');
    await checkToolbarSearch(tab);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    await waitSearch(() => document.activeElement?.matches('.markdown-searchbar input[type="search"]') ?? false, 'Ctrl+F did not focus raw search');
    const input = document.activeElement!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    await waitSearch(() => state.current === 199 && scroller.scrollTop > 0, 'raw search did not navigate to its last match');
    require(CSS.highlights.get('md-search')?.size === 200 && CSS.highlights.get('md-search-current')?.size === 1,
      'raw search highlights are missing');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }));
    await waitSearch(() => !!document.querySelector('article.markdown-body') && state.searched && !state.running,
      'rendered view did not rerun the query after the round trip');
    require(state.query === '## Section' && state.hits === 0 && !CSS.highlights.get('md-search-current'),
      'raw ranges survived the rendered view switch');
  } finally { state.open = false; state.query = ''; tab.mode = 'rendered'; await tick(); }
}

export async function checkReadingSearch(tab: DocTab): Promise<void> {
  const state = tab.markdownSearch;
  await waitSearch(() => !!document.querySelector('article [data-dviewer-ui="copy"]'), 'combined document did not finish enhancement');
  const root = document.querySelector<HTMLElement>('article.markdown-body')!;
  const details = root.querySelector('details')!;
  require(!details.open, 'combined fixture details started open');
  state.open = true; state.how = 'literal'; state.caseSensitive = true;
  const run = async (query: string) => {
    state.query = query; await tick();
    await waitSearch(() => state.searched && !state.running, 'combined search did not finish');
    require(state.hits === 1 && !state.error, `combined search missed ${query}`);
  };
  try {
    await run('needleInline');
    require(CSS.highlights.get('md-search')?.size === 2, 'inline match did not span both text nodes');
    await run('detailsNeedle😀');
    await waitSearch(() => details.open, 'combined search did not open details');
    await run('farRightNeedle😀');
    await waitSearch(() => [...root.querySelectorAll('pre')].some(pre => pre.scrollLeft > 0), 'combined search did not reveal wide code');
    require(root.querySelectorAll('table')[0].rows.length === 33, 'combined fixture lost table rows');
  } finally { state.open = false; state.query = ''; await tick(); }
}

export async function measureLargeSearch(tab: DocTab) {
  await waitSearch(() => !!document.querySelector('article [data-dviewer-ui="copy"]'), 'large document did not finish enhancement');
  const rendered = await measureSearch(document.querySelector<HTMLElement>('article.markdown-body')!, 'finalRawNeedle😀');
  const state = tab.markdownSearch;
  try {
    tab.mode = 'raw'; state.open = true; state.query = 'finalRawNeedle😀'; state.how = 'literal'; state.caseSensitive = true;
    await tick();
    await waitSearch(() => !!document.querySelector('.raw-view .source') && state.searched && !state.running,
      'large source search did not finish');
    const source = document.querySelector<HTMLElement>('.raw-view .source')!;
    require(state.hits === 1 && !state.error && source.childNodes.length === 1, 'large source search count or text node changed');
    await waitSearch(() => source.closest<HTMLElement>('.scroller')!.scrollTop > 0, 'large source search did not move to the result');
    return { rendered, raw: await measureSearch(source, 'finalRawNeedle😀') };
  } finally { state.open = false; state.query = ''; tab.mode = 'rendered'; await tick(); }
}

export async function measureTocScroll(tab: DocTab) {
  const root = document.querySelector<HTMLElement>('article.markdown-body')!;
  const scroller = root.closest<HTMLElement>('.scroller')!;
  scroller.scrollTop = 0;
  await waitSearch(() => document.querySelector('nav button[aria-current="true"]')?.textContent === tab.toc[0].text,
    'TOC benchmark did not reach the first heading');
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const headings = tab.toc.map(entry => root.querySelector<HTMLElement>(`#${CSS.escape(entry.id)}`)!);
  let headingReads = 0;
  const originals = headings.map(heading => heading.getBoundingClientRect);
  headings.forEach((heading, i) => { heading.getBoundingClientRect = () => { headingReads++; return originals[i].call(heading); }; });
  const sample = async (scroll: boolean) => {
    const intervals: number[] = [];
    let previous = await new Promise<number>(resolve => requestAnimationFrame(resolve));
    for (let i = 0; i < 60; i++) {
      if (scroll) scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * (i + 1) / 60;
      const next = await new Promise<number>(resolve => requestAnimationFrame(resolve));
      intervals.push(next - previous); previous = next;
    }
    return { samples: intervals, medianMs: median(intervals), maxMs: Math.max(...intervals) };
  };
  try {
    const control = await sample(false), scroll = await sample(true);
    await waitSearch(() => document.querySelector('nav button[aria-current="true"]')?.textContent === tab.toc.at(-1)!.text,
      'TOC benchmark did not reach the final heading');
    require(headingReads === 0, `TOC scroll reread ${headingReads} heading rectangles`);
    return { headings: headings.length, headingReads, control, scroll };
  } finally { headings.forEach((heading, i) => { heading.getBoundingClientRect = originals[i]; }); scroller.scrollTop = 0; }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};

export async function measureSearch(root: HTMLElement, query: string) {
  const samples = { collect: [] as number[], literal: [] as number[], regex: [] as number[], roundTrip: [] as number[], highlight: [] as number[] };
  let nodeCount = 0, textLength = 0, hitCount = 0;
  const run = (text: string, query: string, how: 'literal' | 'regex') => new Promise<{ result: Matches; elapsedMs: number; roundTripMs: number }>((resolve, reject) => {
    const start = performance.now();
    const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('benchmark worker timeout')); }, 1000);
    worker.onmessage = event => {
      clearTimeout(timer); worker.terminate();
      if (event.data.error) reject(new Error(`benchmark worker: ${event.data.error}`));
      else resolve({ ...event.data, roundTripMs: performance.now() - start });
    };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error('benchmark worker failed')); };
    worker.postMessage({ seq: 0, text, query, options: { caseSensitive: true, how } });
  });
  const prior = CSS.highlights?.get('md-search');
  try {
    for (let pass = 0; pass < 7; pass++) {
      let start = performance.now();
      const index = indexText(root);
      const collectionMs = performance.now() - start;
      nodeCount = index.nodes.length; textLength = index.text.length;
      const literal = await run(index.text, '__dviewer_missing_search_control__', 'literal');
      const regex = await run(index.text, '__dviewer_missing_search_control__\\d+', 'regex');
      require(literal.result.ranges.length === 0 && regex.result.ranges.length === 0, 'search benchmark control unexpectedly matched');
      const matches = await run(index.text, query, 'literal');
      hitCount = matches.result.ranges.length;
      require(hitCount > 0 && !matches.result.capped, 'highlight benchmark must not hit the result cap');
      start = performance.now();
      const highlight = new Highlight();
      for (const match of matches.result.ranges) for (const range of matchRanges(index, match)) highlight.add(range);
      CSS.highlights.set('md-search', highlight);
      const highlightMs = performance.now() - start;
      CSS.highlights.delete('md-search');
      if (pass) {
        samples.collect.push(collectionMs); samples.literal.push(literal.elapsedMs); samples.regex.push(regex.elapsedMs);
        samples.roundTrip.push(literal.roundTripMs); samples.highlight.push(highlightMs);
      }
    }
    return { textLength, nodeCount, hitCount, samples, medianMs: {
      collection: median(samples.collect), literalWorker: median(samples.literal), regexWorker: median(samples.regex),
      literalRoundTrip: median(samples.roundTrip), rangeAndHighlightRegistration: median(samples.highlight),
    } };
  } finally {
    if (prior) CSS.highlights.set('md-search', prior); else CSS.highlights?.delete('md-search');
  }
}
