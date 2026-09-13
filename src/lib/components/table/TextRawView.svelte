<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { n, t } from '../../i18n';
  import { docLines, docLinesFind, errorMessage, treeSearchCancel } from '../../ipc';
  import type { DocTab } from '../../state/docs.svelte';
  import { settings } from '../../state/settings.svelte';
  import { anchorRow, isCompressed, rowTop, scrollTopForRow, spacerHeight } from '../../virtual';
  import { containsLines, rawHighlights, rawWindow, visibleLines, RawRequests } from '../../textRaw';
  import Icon from '../Icon.svelte';

  interface Props { tab: DocTab; focusSearch?: (() => void) | null }
  let { tab, focusSearch = $bindable(null) }: Props = $props();
  const generation = untrack(() => tab.meta.generation ?? 0);
  let live = true;
  const current = () => live && (tab.meta.generation ?? 0) === generation;
  let viewport = $state<HTMLElement>();
  let input = $state<HTMLInputElement>();
  let viewportHeight = $state(0);
  let scrollTop = $state(0);
  let total = $state(0);
  let rows = $state<string[]>([]);
  let start = $state(0);
  let range = $state<string>();
  let error = $state<string | null>(null);
  let searchError = $state<string | null>(null);
  let searching = $state(false);
  let searched = $state(false);
  let jumpLine = $state<number>();
  let request = 0;
  let searchRequest = 0;
  const requests = new RawRequests();
  let restored = false;
  const rowHeight = $derived(Math.max(18, Math.round(settings.docFontPx * settings.uiScale * 1.7)));
  const metrics = $derived({ rowHeight, totalRows: total, viewportHeight });

  $effect(() => {
    focusSearch = () => input?.select();
    return () => { focusSearch = null; };
  });

  $effect(() => {
    const target = tab;
    void docLines(target.id, 0, 0).then(page => {
      if (current()) total = page.total;
    }).catch(err => { if (current()) error = errorMessage(err); });
    return () => {
      live = false; request++; searchRequest++;
      if (searching) void treeSearchCancel(target.id).catch(() => {});
    };
  });

  $effect(() => {
    void total; void rowHeight; void viewportHeight; void scrollTop; void viewport;
    untrack(() => {
      if (!viewport || !total) return;
      if (!restored) {
        restored = true;
        viewport.scrollTop = tab.rawScrollTop;
        scrollTop = viewport.scrollTop;
      }
      void ensureWindow();
    });
  });

  $effect(() => {
    const host = viewport;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if (!isCompressed(metrics) || event.ctrlKey || event.shiftKey || event.deltaX || !event.deltaY) return;
      event.preventDefault();
      const lines = event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2
        ? event.deltaY * viewportHeight / rowHeight : event.deltaY / rowHeight;
      void goTo(anchorRow(metrics, host.scrollTop) + lines);
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  });

  function keydown(event: KeyboardEvent) {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const row = anchorRow(metrics, scrollTop);
    const page = Math.max(1, Math.floor(viewportHeight / rowHeight));
    const target = { ArrowUp: row - 1, ArrowDown: row + 1, PageUp: row - page, PageDown: row + page, Home: 0, End: total - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    void goTo(target);
  }

  async function ensureWindow() {
    if (!current() || !viewport || !total) return;
    const visible = visibleLines(metrics, scrollTop);
    if (containsLines(start, rows.length, visible)) {
      requests.pending = '';
      const seq = ++request;
      await tick();
      if (current() && seq === request) range = `${start}-${start + rows.length - 1}`;
      return;
    }
    const window = rawWindow(metrics, scrollTop);
    const key = `${window.start}:${window.count}`;
    if (!requests.begin(key)) return;
    range = undefined;
    error = null;
    const seq = ++request;
    try {
      const page = await docLines(tab.id, window.start, window.count);
      if (!current() || seq !== request) return;
      start = window.start;
      rows = page.lines;
      await tick();
      if (current() && seq === request) range = `${start}-${start + rows.length - 1}`;
    } catch (err) {
      if (current() && seq === request) {
        requests.finish(key, err);
        rows = [];
        error = errorMessage(err);
      }
    } finally {
      if (current() && seq === request) requests.finish(key);
    }
  }

  function onScroll() {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    tab.rawScrollTop = scrollTop;
  }

  async function goTo(row: number) {
    if (!viewport || !total) return;
    row = Math.max(0, Math.min(total - 1, row));
    range = undefined;
    viewport.scrollTop = scrollTopForRow(metrics, row);
    onScroll();
    await ensureWindow();
  }

  function changeQuery(value: string) {
    if (searching) void treeSearchCancel(tab.id).catch(() => {});
    tab.textSearch.query = value;
    tab.textSearch.current = null;
    searchRequest++;
    searched = false;
    searching = false;
    searchError = null;
  }

  async function find(backward = false) {
    const query = tab.textSearch.query;
    if (!total || !query) return;
    const seq = ++searchRequest;
    searching = true;
    searchError = null;
    const selected = tab.textSearch.current;
    const from = selected === null ? Math.floor(anchorRow(metrics, scrollTop))
      : (selected + (backward ? total - 1 : 1)) % total;
    try {
      const found = await docLinesFind(tab.id, query, from, backward);
      if (!current() || seq !== searchRequest) return;
      tab.textSearch.current = found;
      searched = true;
      if (found !== null) await goTo(found);
    } catch (err) {
      if (current() && seq === searchRequest) searchError = errorMessage(err);
    } finally {
      if (current() && seq === searchRequest) searching = false;
    }
  }
</script>

<svelte:window onkeydown={event => { if (event.target === viewport) keydown(event); }} />

<div class="layout">
  <form class="raw-searchbar" role="search" onsubmit={event => { event.preventDefault(); void find(); }}>
    <Icon name="search" size={13} />
    <input type="search" bind:this={input} value={tab.textSearch.query}
      placeholder={t('textRaw.find')} aria-label={t('textRaw.find')}
      oninput={event => changeQuery(event.currentTarget.value)}
      onkeydown={event => {
        if (event.key === 'Enter') { event.preventDefault(); void find(event.shiftKey); }
        if (event.key === 'Escape') { event.preventDefault(); viewport?.focus(); }
      }} />
    <button class="icon-btn" type="button" disabled={!total || !tab.textSearch.query}
      aria-label={t('search.prevLabel')} title={t('search.prev')} onclick={() => void find(true)}><Icon name="chevron-up" size={13} /></button>
    <button class="icon-btn" type="button" disabled={!total || !tab.textSearch.query}
      aria-label={t('search.nextLabel')} title={t('search.next')} onclick={() => void find()}><Icon name="chevron-down" size={13} /></button>
    <span role="status" class="search-status">
      {#if searchError}<span class="error">{searchError}</span>
      {:else if searching}{t('table.search.running')}
      {:else if tab.textSearch.current !== null}{t('textRaw.line', { line: n(tab.textSearch.current + 1) })}
      {:else if searched}{t('table.search.empty')}{/if}
    </span>
    <label>{t('textRaw.goTo')} <input type="number" min="1" max={total} step="1" bind:value={jumpLine}
      aria-label={t('textRaw.goTo')} onkeydown={event => {
        if (event.key === 'Enter') { event.preventDefault(); if (jumpLine !== undefined && Number.isInteger(jumpLine) && jumpLine >= 1 && jumpLine <= total) void goTo(jumpLine - 1); }
      }} /></label>
    <button type="button" disabled={jumpLine === undefined || !Number.isInteger(jumpLine) || jumpLine < 1 || jumpLine > total}
      onclick={() => { if (jumpLine !== undefined) void goTo(jumpLine - 1); }}>{t('textRaw.go')}</button>
  </form>
  <div class="text-raw-view" bind:this={viewport} bind:clientHeight={viewportHeight}
    tabindex="-1" role="region" aria-label={t('toolbar.mode.raw')} onscroll={onScroll}
    data-range={range} data-total={range === undefined ? undefined : total}
    style:--row-height={`${rowHeight}px`} style:--number-digits={String(total).length}>
    {#if error}<p class="status error" role="alert">{error}</p>
    {:else if !total}<p class="status">{t('markdown.rawLoading')}</p>{/if}
    <div class="spacer" style:height={`${spacerHeight(metrics)}px`}>
      <div class="line-window" style:top={`${rowTop(metrics, scrollTop, start)}px`}>
        {#each rows as line, offset (start + offset)}
          <div class="raw-line" class:found={tab.textSearch.current === start + offset} data-line={start + offset}>
            <span class="line-number" aria-hidden="true">{start + offset + 1}</span>
            <pre class="line-text">{#each rawHighlights(line, tab.textSearch.query) as part, piece (piece)}{#if part.matched}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</pre>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .layout { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; min-height: 0; }
  .raw-searchbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; padding: 0.3rem 0.6rem; border-bottom: 1px solid var(--border); color: var(--text-muted); }
  input { background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; padding: 0.2rem 0.4rem; }
  input[type='search'] { flex: 1; min-width: 8rem; }
  input[type='number'] { width: 8ch; }
  label { white-space: nowrap; }
  .search-status { font-size: 0.85em; }
  .text-raw-view { overflow: auto; min-height: 0; tab-size: 4; }
  .spacer { position: relative; min-width: 100%; }
  .line-window { position: absolute; min-width: 100%; width: max-content; }
  .raw-line { display: flex; height: var(--row-height); line-height: var(--row-height); font-family: var(--font-code); font-size: var(--doc-font-size); }
  .line-number { position: sticky; left: 0; z-index: 1; flex: 0 0 calc(var(--number-digits) * 1ch + 2ch); padding: 0 1ch; box-sizing: border-box; text-align: right; user-select: none; color: var(--text-muted); background: var(--bg); border-right: 1px solid var(--border); }
  .line-text { margin: 0; padding: 0 1ch; font: inherit; line-height: inherit; white-space: pre; }
  mark { color: inherit; background: var(--search-match, #b89c4066); }
  .found .line-number { color: var(--accent); font-weight: 600; }
  .status { margin: 0; padding: 0.75rem; color: var(--text-muted); }
  .error { color: var(--danger); }
</style>
