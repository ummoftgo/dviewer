import type { MarkdownSearchState } from '../../state/docs.svelte';
import { indexText, matchRanges, revealMatch, type TextIndex } from './searchDom';
import type { Matches, SearchError, SearchOptions } from './search';

/** A worker belongs to one query. Termination also bounds pathological regexes. */
export function markdownSearch(root: HTMLElement, scroller: HTMLElement, state: MarkdownSearchState) {
  let index: TextIndex | undefined, hits: Range[][] = [];
  let worker: Worker | undefined, debounce: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  state.supported = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && !!CSS.highlights;
  const clearHighlights = () => {
    if (!state.supported) return;
    CSS.highlights.delete('md-search');
    CSS.highlights.delete('md-search-current');
  };
  const stop = () => {
    clearTimeout(debounce); clearTimeout(deadline); worker?.terminate(); worker = undefined;
    state.reset(); hits = []; clearHighlights();
  };
  const move = (delta: number) => {
    if (!hits.length) return;
    state.current = (state.current + delta + hits.length) % hits.length;
    const at = state.current, seq = state.seq;
    if (state.supported) {
      const highlight = new Highlight();
      for (const range of hits[at]) highlight.add(range);
      CSS.highlights.set('md-search-current', highlight);
    }
    void revealMatch(hits[at], scroller, () => alive && state.seq === seq && state.current === at);
  };
  const search = (query: string, options: SearchOptions, open: boolean) => {
    stop();
    if (!open || !query) return;
    state.running = true;
    state.searched = true;
    const seq = state.seq;
    debounce = setTimeout(() => {
      if (!alive || seq !== state.seq) return;
      const fail = (error: SearchError, detail = '') => {
        if (!alive || seq !== state.seq) return;
        clearTimeout(deadline); worker?.terminate(); worker = undefined;
        state.error = error; state.detail = detail; state.running = false;
      };
      try {
        index ??= indexText(root);
        const snapshot = index;
        worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
        deadline = setTimeout(() => fail('timeout'), 1000);
        worker.onerror = () => fail('worker');
        worker.onmessage = (event: MessageEvent<{ seq: number; result?: Matches; error?: SearchError; detail?: string }>) => {
          if (!alive || seq !== state.seq || event.data.seq !== seq) return;
          if (event.data.error) { fail(event.data.error, event.data.detail); return; }
          const result = event.data.result;
          if (!result) { fail('worker'); return; }
          clearTimeout(deadline); worker?.terminate(); worker = undefined;
          hits = result.ranges.map(match => matchRanges(snapshot, match)).filter(ranges => ranges.length > 0);
          if (state.supported) {
            const highlight = new Highlight();
            for (const ranges of hits) for (const range of ranges) highlight.add(range);
            CSS.highlights.set('md-search', highlight);
          }
          state.hits = hits.length; state.capped = result.capped;
          state.current = hits.length ? 0 : -1; state.running = false;
          move(0);
        };
        worker.postMessage({ seq, text: snapshot.text, query, options });
      } catch { fail('worker'); }
    }, 150);
  };
  const observer = new MutationObserver(records => {
    if (!records.some(record => {
      const element = record.target instanceof Element ? record.target : record.target.parentElement;
      if (element?.closest('[data-dviewer-ui],colgroup')) return false;
      if (record.type === 'characterData') return true;
      return [...record.addedNodes, ...record.removedNodes].some(node =>
        !(node instanceof Element && node.matches('[data-dviewer-ui],colgroup')));
    })) return;
    index = undefined;
    search(state.query, { how: state.how, caseSensitive: state.caseSensitive }, state.open);
  });
  observer.observe(root, { childList: true, characterData: true, subtree: true });
  return { search, move, destroy() { alive = false; observer.disconnect(); stop(); index = undefined; } };
}
