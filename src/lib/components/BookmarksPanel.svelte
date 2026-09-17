<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { bookmarkDocument, selectBookmarks, type Bookmark, type BookmarkAnchor, type BookmarkSource } from '../bookmarks';
  import { t } from '../i18n';
  import { sameSource } from '../source';
  import { bookmarks, bookmarkTarget, canBookmark } from '../state/bookmarks.svelte';
  import type { DocTab } from '../state/docs.svelte';
  import Icon from './Icon.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import type { MenuItem } from './menu';

  interface Props {
    tab: DocTab | null;
    draft: {source:BookmarkSource; anchor:BookmarkAnchor} | null;
    onDone: () => void;
    onClose: () => void;
  }
  let {tab, draft, onDone, onClose}: Props = $props();
  let label = $derived(draft ? (draft.anchor.id === '' ? t('bookmarks.top') : draft.anchor.text) : '');
  let input = $state<HTMLInputElement>();
  let panel: HTMLElement;
  onMount(() => panel.focus());
  let all = $state(false);
  let query = $state('');
  let editing = $state<{id:string; label:string} | null>(null);
  let renameInput = $state<HTMLInputElement>();
  let menu = $state<{item:Bookmark; x:number; y:number; button:HTMLButtonElement} | null>(null);
  const headings = $derived(tab?.view === 'frame' ? tab.frameToc : tab?.toc ?? []);
  const entries = $derived(selectBookmarks(bookmarks.entries,tab?.meta.source ?? null,headings,all,query));

  $effect(() => {
    if (!editing?.id) return;
    void tick().then(() => { renameInput?.focus(); renameInput?.select(); });
  });

  $effect(() => {
    if (!draft) return;
    all = false; query = ''; editing = null;
    void tick().then(() => { input?.focus(); input?.select(); });
  });

  function save() {
    if (draft && bookmarks.add(draft.source, draft.anchor, label)) {
      onDone(); panel.focus();
    }
  }

  function rename(item: Bookmark) {
    onDone(); editing = {id:item.id,label:item.label}; menu = null;
  }

  function saveName() {
    if (editing && bookmarks.rename(editing.id, editing.label)) { editing = null; panel.focus(); }
  }

  function menuItems(item: Bookmark): MenuItem[] {
    return [
      {label:t('bookmarks.rename'),hint:'F2',action:() => rename(item)},
      {label:t('bookmarks.reassign'),disabled:!canBookmark(tab) || !tab || !sameSource(item.source,tab.meta.source),
        action:() => { const destination = bookmarkTarget(tab); if (destination) bookmarks.reassign(item.id,destination); }},
    ];
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation();
    if (editing) { editing = null; panel.focus(); }
    else if (draft) { onDone(); panel.focus(); }
    else onClose();
  }
</script>

<!-- Escape is delegated from the panel controls. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="bookmarks-panel" aria-label={t('bookmarks.title')} bind:this={panel} tabindex="-1" onkeydown={keydown}>
  <header>
    <h2>{t('bookmarks.title')}</h2>
    <button class="icon-btn" onclick={onClose} title={t('bookmarks.close')} aria-label={t('bookmarks.close')}><Icon name="close" /></button>
  </header>
  {#if bookmarks.error}<p role="alert">{t('bookmarks.loadFailed')}</p>{/if}
  <div class="segmented" role="group" aria-label={t('bookmarks.scope')}>
    <button aria-pressed={!all} onclick={() => { all = false; }}>{t('bookmarks.current')}</button>
    <button data-action="bookmarks-all" aria-pressed={all} onclick={() => { all = true; }}>{t('bookmarks.all')}</button>
  </div>
  <input class="field filter" type="search" bind:value={query} aria-label={t('bookmarks.filter')} placeholder={t('bookmarks.filter')} />
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
        {#if editing?.id === item.id}
          <form onsubmit={event => { event.preventDefault(); saveName(); }}>
            <input class="field" bind:this={renameInput} bind:value={editing.label} maxlength="65536" aria-label={t('bookmarks.label')} />
            <div class="actions">
              <button class="btn" type="submit" disabled={!editing.label.trim()}>{t('bookmarks.save')}</button>
              <button class="btn" type="button" onclick={() => { editing = null; }}>{t('bookmarks.cancel')}</button>
            </div>
          </form>
        {:else}
        <div class="row">
        <button class="entry" data-action="bookmark-open" onclick={() => bookmarks.open(item)} ondblclick={() => rename(item)}
          onkeydown={event => { if (event.key === 'F2') { event.preventDefault(); rename(item); } }}>
          <strong>{item.label}</strong>
          <span title={item.source.type === 'file' ? item.source.path : item.source.url}>{bookmarkDocument(item.source)}</span>
          <span>{item.anchor.id === '' ? t('bookmarks.top') : item.anchor.text}</span>
          {#if bookmarks.results[item.id] === false}<span class="missing">{t('bookmarks.missing')}</span>{/if}
        </button>
        <div class="row-actions">
          <button class="icon-btn" aria-haspopup="menu" title={t('bookmarks.actions')} aria-label={t('bookmarks.actions')}
            onclick={event => { const box = event.currentTarget.getBoundingClientRect(); menu = {item,x:box.right,y:box.bottom,button:event.currentTarget}; }}>
            <Icon name="chevron-down" size={12} />
          </button>
          <button class="icon-btn" data-action="bookmark-delete" title={t('bookmarks.delete')} aria-label={t('bookmarks.delete')}
            onclick={() => { bookmarks.remove(item.id); panel.focus(); }}><Icon name="close" size={12} /></button>
        </div>
        </div>
        {/if}
      </li>
    {/each}
  </ul>
  {#if !entries.length && bookmarks.ready}<p>{t('bookmarks.empty')}</p>{/if}
</aside>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.item)} onClose={() => { menu?.button.focus(); menu = null; }} />
{/if}

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
  .filter { margin:0.6rem 0; }
  .row { display:flex; align-items:flex-start; }
  .row-actions { display:flex; flex:none; padding-top:0.6rem; }
  .entry { min-width:0; }
  .entry { display:flex; flex-direction:column; align-items:flex-start; gap:0.2rem; width:100%; padding:0.65rem 0.35rem; border:0; background:transparent; text-align:left; color:var(--text); overflow-wrap:anywhere; }
  .entry:hover { background:var(--bg-hover); }
  span, p { color:var(--text-muted); font-size:0.85em; }
  .missing { color:var(--danger); }
</style>
