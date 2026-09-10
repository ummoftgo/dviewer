<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { n, t } from '../../i18n';
  import type { DocTab } from '../../state/docs.svelte';
  import Icon from '../Icon.svelte';
  import { markdownSearch } from './searchController';

  interface Props {
    tab: DocTab;
    root?: HTMLElement;
    scroller?: HTMLElement;
    ready: boolean;
    focusSearch?: (() => void) | null;
  }
  let { tab, root, scroller, ready, focusSearch = $bindable(null) }: Props = $props();
  let input = $state<HTMLInputElement>();
  let controller = $state<ReturnType<typeof markdownSearch>>();
  const search = $derived(tab.markdownSearch);

  $effect(() => {
    focusSearch = () => {
      search.open = true;
      void tick().then(() => input?.select());
    };
    return () => { focusSearch = null; };
  });

  $effect(() => {
    const host = root, viewport = scroller, state = search;
    if (!ready || !host || !viewport) return;
    const handle = untrack(() => markdownSearch(host, viewport, state));
    controller = handle;
    return () => { handle.destroy(); controller = undefined; };
  });

  $effect(() => {
    const handle = controller, query = search.query, open = search.open;
    const options = { how: search.how, caseSensitive: search.caseSensitive };
    untrack(() => handle?.search(query, options, open));
  });

  function close() {
    search.open = false;
    scroller?.focus({ preventScroll: true });
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault(); event.stopPropagation(); controller?.move(event.shiftKey ? -1 : 1);
    }
  }
</script>

<svelte:window onkeydown={(event) => {
  if (event.target instanceof Element && event.target.closest('.markdown-searchbar')) keydown(event);
}} />

{#if search.open}
  <form class="markdown-searchbar" role="search" onsubmit={(event) => event.preventDefault()}>
    <Icon name="search" size={13} />
    <input type="search" bind:this={input} bind:value={search.query}
      placeholder={t('markdown.search.placeholder')} aria-label={t('markdown.search.placeholder')} />
    <label title={t('markdown.search.regex')}>
      <input type="checkbox" checked={search.how === 'regex'} aria-label={t('markdown.search.regex')}
        onchange={(event) => { search.how = event.currentTarget.checked ? 'regex' : 'literal'; }} />.*
    </label>
    <label title={t('search.caseSensitive')}>
      <input type="checkbox" bind:checked={search.caseSensitive} aria-label={t('search.caseSensitive')} />Aa
    </label>
    <span class="status" role="status">
      {#if search.running}{t('table.search.running')}
      {:else if search.error}<span class="error" title={search.detail}>{t(`markdown.search.${search.error}`)}</span>
      {:else if search.hits}{n(search.current + 1)} / {n(search.hits)}{#if search.capped}<span title={t('markdown.search.capped')}>+</span>{/if}
      {:else if search.searched}{t('table.search.empty')}{/if}
      {#if !search.supported}<span title={t('markdown.search.noHighlight')}>{t('markdown.search.noHighlight')}</span>{/if}
    </span>
    <button class="icon-btn" type="button" disabled={!search.hits} onclick={() => controller?.move(-1)}
      aria-label={t('search.prevLabel')} title={t('search.prev')}><Icon name="chevron-up" size={13} /></button>
    <button class="icon-btn" type="button" disabled={!search.hits} onclick={() => controller?.move(1)}
      aria-label={t('search.nextLabel')} title={t('search.next')}><Icon name="chevron-down" size={13} /></button>
    <button class="icon-btn" type="button" onclick={close} aria-label={t('markdown.search.close')} title={t('markdown.search.close')}>
      <Icon name="close" size={13} />
    </button>
  </form>
{/if}

<style>
  .markdown-searchbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
  }
  input[type='search'] {
    flex: 1;
    min-width: 6rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text);
    font: inherit;
  }
  label { display: flex; align-items: center; gap: 0.2rem; font-size: 0.85em; }
  .status { display: flex; gap: 0.4rem; font-size: 0.85em; font-variant-numeric: tabular-nums; }
  .error { color: var(--danger); }
</style>
