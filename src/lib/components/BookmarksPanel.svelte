<script lang="ts">
  import { tick } from 'svelte';
  import type { BookmarkAnchor, BookmarkSource } from '../bookmarks';
  import { t } from '../i18n';
  import { sameSource } from '../source';
  import { bookmarks } from '../state/bookmarks.svelte';
  import type { DocTab } from '../state/docs.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    tab: DocTab | null;
    draft: {source:BookmarkSource; anchor:BookmarkAnchor} | null;
    onDone: () => void;
    onClose: () => void;
  }
  let {tab, draft, onDone, onClose}: Props = $props();
  let label = $derived(draft ? draft.anchor.text || t('bookmarks.top') : '');
  let input = $state<HTMLInputElement>();
  let panel: HTMLElement;
  const entries = $derived(bookmarks.entries.filter(item => tab && sameSource(item.source, tab.meta.source)));

  $effect(() => {
    if (!draft) return;
    void tick().then(() => { input?.focus(); input?.select(); });
  });

  function save() {
    if (draft && bookmarks.add(draft.source, draft.anchor, label)) {
      onDone(); panel.focus();
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation();
    if (draft) { onDone(); panel.focus(); }
    else onClose();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape is delegated from the panel controls.) -->
<aside class="bookmarks-panel" aria-label={t('bookmarks.title')} bind:this={panel} tabindex="-1" onkeydown={keydown}>
  <header>
    <h2>{t('bookmarks.title')}</h2>
    <button class="icon-btn" onclick={onClose} title={t('bookmarks.close')} aria-label={t('bookmarks.close')}><Icon name="close" /></button>
  </header>
  {#if bookmarks.error}<p role="alert">{t('bookmarks.loadFailed')}</p>{/if}
  {#if draft}
    <form onsubmit={event => { event.preventDefault(); save(); }}>
      <label for="bookmark-label">{t('bookmarks.label')}</label>
      <input class="field" id="bookmark-label" data-action="bookmark-label" bind:this={input} bind:value={label} maxlength="65536" />
      <div class="actions">
        <button class="btn" type="submit" disabled={!label.trim()}>{t('bookmarks.save')}</button>
        <button class="btn" type="button" onclick={onDone}>{t('bookmarks.cancel')}</button>
      </div>
    </form>
  {/if}
  <ul>
    {#each entries as item (item.id)}
      <li data-bookmark={item.id}>
        <button class="entry" data-action="bookmark-open" onclick={() => bookmarks.open(item)}>
          <strong>{item.label}</strong>
          <span>{item.source.type === 'file' ? item.source.path.split(/[\\/]/).pop() : item.source.url}</span>
          <span>{item.anchor.text || t('bookmarks.top')}</span>
          {#if bookmarks.results[item.id] === false}<span class="missing">{t('bookmarks.missing')}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if !entries.length && bookmarks.ready}<p>{t('bookmarks.empty')}</p>{/if}
</aside>

<style>
  .bookmarks-panel { width:18rem; max-width:45vw; min-width:0; flex:none; overflow:auto; border-left:1px solid var(--border); padding:0.75rem; }
  header, .actions { display:flex; align-items:center; gap:0.4rem; }
  header { justify-content:space-between; margin-bottom:0.75rem; }
  h2 { margin:0; font-size:0.95rem; }
  form { margin-bottom:1rem; }
  label { display:block; margin-bottom:0.3rem; }
  input { width:100%; min-width:0; }
  .actions { margin-top:0.4rem; }
  ul { list-style:none; padding:0; margin:0; }
  li + li { border-top:1px solid var(--border); }
  .entry { display:flex; flex-direction:column; align-items:flex-start; gap:0.2rem; width:100%; padding:0.65rem 0.35rem; border:0; background:transparent; text-align:left; color:var(--text); overflow-wrap:anywhere; }
  .entry:hover { background:var(--bg-hover); }
  span, p { color:var(--text-muted); font-size:0.85em; }
  .missing { color:var(--danger); }
</style>
