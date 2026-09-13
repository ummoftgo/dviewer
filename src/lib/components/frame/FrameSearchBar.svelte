<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../../i18n';
  import Icon from '../Icon.svelte';
  import type { DocTab } from '../../state/docs.svelte';
  interface Props { tab: DocTab; ready: boolean; onFind: (dir: 1 | -1) => void; focusSearch?: (() => void) | null }
  let {tab, ready, onFind, focusSearch = $bindable(null)}: Props = $props();
  let input = $state<HTMLInputElement>();
  $effect(() => {
    focusSearch = () => { tab.frameSearch.open = true; void tick().then(() => input?.select()); };
    return () => { focusSearch = null; };
  });
</script>
{#if tab.frameSearch.open}
  <div class="searchbar" role="search">
    <input bind:this={input} type="search" value={tab.frameSearch.query} aria-label={t('toolbar.search')}
      oninput={(event) => { tab.frameSearch.query = event.currentTarget.value; onFind(1); }} onkeydown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); onFind(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') tab.frameSearch.open = false;
      }} />
    <span aria-live="polite">{tab.frameSearch.index}/{tab.frameSearch.n}</span>
    <button class="icon-btn" disabled={!ready} onclick={() => onFind(-1)} aria-label={t('search.prev')} title={t('search.prev')}><Icon name="chevron-up" /></button>
    <button class="icon-btn" disabled={!ready} onclick={() => onFind(1)} aria-label={t('search.next')} title={t('search.next')}><Icon name="chevron-down" /></button>
    <button class="icon-btn" onclick={() => tab.frameSearch.open = false} aria-label={t('markdown.search.close')}><Icon name="close" /></button>
  </div>
{/if}
<style>
  .searchbar { display:flex; align-items:center; gap:0.4rem; padding:0.35rem 0.6rem; border-bottom:1px solid var(--border); }
  input { flex:1; min-width:5rem; padding:0.3rem 0.5rem; background:var(--bg-inset); color:var(--text); border:1px solid var(--border); border-radius:var(--radius-sm); font:inherit; }
  span { font-size:0.85em; color:var(--text-muted); }
</style>
