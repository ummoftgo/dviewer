<script lang="ts">
  import { session } from './lib/state/session.svelte';
  import BookmarksPanel from './lib/components/BookmarksPanel.svelte';
  import { bookmarks, bookmarkTarget } from './lib/state/bookmarks.svelte';
  import UpdateDialog from "./lib/components/UpdateDialog.svelte";
  import { updates } from "./lib/state/updates.svelte";
  import SubTabBar from "./lib/components/SubTabBar.svelte";
  import { family, nextMainTab, nextSubtab } from "./lib/subtabs";
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import Icon from "./lib/components/Icon.svelte";
  import SettingsPanel from "./lib/components/SettingsPanel.svelte";
  import { reportDelivery, reportNewWindow, runSmoke } from "./lib/smoke";
  import StartPane from "./lib/components/StartPane.svelte";
  import TabBar from "./lib/components/TabBar.svelte";
  import Toast from "./lib/components/Toast.svelte";
  import ThemeStyles from "./lib/components/ThemeStyles.svelte";
  import Toolbar from "./lib/components/Toolbar.svelte";
  import TreeView from "./lib/components/tree/TreeView.svelte";
  import TableView from "./lib/components/table/TableView.svelte";
  import CollectionView from "./lib/components/collection/CollectionView.svelte";
  import ArchiveView from "./lib/components/archive/ArchiveView.svelte";
  import MarkdownView from "./lib/components/markdown/MarkdownView.svelte";
  import RawView from "./lib/components/markdown/RawView.svelte";
  import FrameView from "./lib/components/frame/FrameView.svelte";
  import TextRawView from "./lib/components/table/TextRawView.svelte";
  import * as ipc from "./lib/ipc";
  import { detectSystemLocale, t } from "./lib/i18n";
  import { pickFiles } from "./lib/open";
  import { workspace } from "./lib/state/docs.svelte";
  import { shortcutKey } from "./lib/keys";
  import { nextFocusMode } from './lib/focusMode';
  import { toasts } from './lib/state/toast.svelte';
  import { supportsRaw } from './lib/viewMode';
  import { recents } from "./lib/state/recents.svelte";
  import { applySettings, settings, watchSystemTheme } from "./lib/state/settings.svelte";

  let settingsOpen = $state(false);
  let showToc = $state(true);
  let bookmarksOpen = $state(false);
  let bookmarkDraft = $state<ReturnType<typeof bookmarkTarget>>(null);
  let dropActive = $state(false);
  let searchBarFocus = $state<(() => void) | null>(null);
  let focusMode = $state(false);
  let main = $state<HTMLElement>();
  let returnFocus: { element: HTMLElement; tab: number | null } | null = null;

  const active = $derived(workspace.active);

  // --- settings -----------------------------------------------------------

  onMount(() => watchSystemTheme());
  onMount(() => updates.watch());
  onMount(() => detectSystemLocale());
  onMount(() => () => document.body.removeAttribute('data-focus'));

  $effect(() => {
    // Reading these here is what subscribes the effect to them.
    void settings.theme;
    void settings.systemDark;
    void settings.uiScale;
    void settings.docFontPx;
    void settings.fontBody;
    void settings.fontCode;
    applySettings();
  });

  /**
   * True when this process was started with `--smoke`, in which case the
   * harness drives instead of the reader. Read once on mount, and used by the
   * delivery listener below as well — a self-check has to report what arrives
   * rather than open it.
   */
  let smoking = $state(false);

  async function initialize() {
    const status = await ipc.smokeStatus();
    smoking = status.active;
    const request = await ipc.startupRequest();
    await Promise.all([settings.load(), recents.load(), bookmarks.load()]);
    if (status.active) {
      if (status.window !== 'main') return reportNewWindow(status.window, request);
      return runSmoke();
    }
    const save = status.window === 'main' && !request.skipRestore;
    await session.start(request, save && settings.restoreSession, save);
  }

  $effect(() => { session.watch(); });
  let positionRestored = $state(false);
  $effect(() => {
    const at = active?.positionRestoredAt ?? 0;
    const remaining = at + 3000 - Date.now();
    positionRestored = at > 0 && remaining > 0;
    if (positionRestored) {
      const timer = setTimeout(() => { positionRestored = false; }, remaining);
      return () => clearTimeout(timer);
    }
  });

  // --- backend events -----------------------------------------------------
  //
  // Subscribed once for the whole app and routed by docId, so a background tab
  // keeps indexing and searching while the user reads something else.

  onMount(() => {
    const subscriptions = [
      ipc.on('doc:changed', ({ id }) => {
        void workspace.changed(id);
      }),
      ipc.on("tree:progress", ({ docId, generation, bytesDone, bytesTotal }) => {
        const tab = workspace.tab(docId, generation);
        if (tab) tab.indexing = { done: bytesDone, total: bytesTotal };
      }),
      ipc.on("tree:ready", ({ docId, generation, stats }) => {
        const tab = workspace.tab(docId, generation);
        if (!tab) return;
        tab.treeStats = stats;
        tab.indexing = null;
        tab.error = null;
      }),
      ipc.on("tree:error", ({ docId, generation, error }) => {
        const tab = workspace.tab(docId, generation);
        if (!tab) return;
        tab.error = ipc.errorMessage(error);
        tab.indexing = null;
      }),
      // Batches from a search the reader has already replaced are dropped
      // rather than appended: cancelling does not unsend what is in flight.
      ipc.on("tree:search-batch", ({ docId, generation, seq, hits }) => {
        const tab = workspace.tab(docId, generation);
        if (!tab || seq !== tab.search.seq) return;
        tab.search.hits = [...tab.search.hits, ...hits];
      }),
      ipc.on("tree:search-done", ({ docId, generation, seq, summary }) => {
        const tab = workspace.tab(docId, generation);
        if (!tab || seq !== tab.search.seq) return;
        tab.search.running = false;
        tab.search.summary = summary;
      }),
      ipc.on("tree:search-error", ({ docId, generation, seq, error }) => {
        const tab = workspace.tab(docId, generation);
        if (!tab || seq !== tab.search.seq) return;
        tab.search.running = false;
        tab.search.error = ipc.errorMessage(error);
      }),
      ipc.on("table:progress", ({ docId, generation, bytesDone, bytesTotal }) => {
        const tab = workspace.tab(docId, generation);
        if (tab) tab.indexing = { done: bytesDone, total: bytesTotal };
      }),
      ipc.on("table:ready", ({ docId, generation, stats, header }) => {
        const tab = workspace.tab(docId, generation);
        if (!tab) return;
        tab.tableStats = stats;
        tab.header = header;
        tab.indexing = null;
        tab.error = null;
      }),
      ipc.on("table:error", ({ docId, generation, error }) => {
        const tab = workspace.tab(docId, generation);
        if (!tab) return;
        tab.error = ipc.errorMessage(error);
        tab.indexing = null;
      }),
      // A second `dviewer` handed its arguments to this window.
      ipc.on("open-request", (request) => {
        // In a self-check the arrival *is* the thing being checked — only this
        // process can say the hand-off worked, because the other one has
        // already exited.
        if (smoking) void reportDelivery(request);
        else void session.receive(request);
      }),
    ];

    void Promise.all(subscriptions).then(initialize)
      .catch(err => console.warn('[dviewer] could not initialize:', err));

    return () => {
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  });

  // --- drag and drop ------------------------------------------------------

  onMount(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        dropActive = true;
      } else if (event.payload.type === "drop") {
        dropActive = false;
        // One at a time, not all at once: `openPath` marks the workspace busy
        // for the duration, so the first to finish would clear that while the
        // rest are still loading — and two of them would race for the same
        // blank tab to fill. This is what a command-line launch already does.
        const paths = event.payload.paths;
        void (async () => {
          for (const path of paths) await workspace.openPath(path);
        })();
      } else {
        dropActive = false;
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  });

  // --- keyboard -----------------------------------------------------------

  function addBookmark() {
    const target = bookmarkTarget(active);
    if (!bookmarks.ready || !target) return;
    bookmarkDraft = target;
    bookmarksOpen = true;
  }

  function toggleBookmarks() {
    bookmarksOpen = !bookmarksOpen;
    if (!bookmarksOpen) { bookmarkDraft = null; main?.focus(); }
  }

  function changeFocus(key: 'F11' | 'Escape', handled = false) {
    const next = nextFocusMode(focusMode, key, handled);
    if (next === focusMode) return;
    const focused = document.activeElement;
    if (next) returnFocus = focused instanceof HTMLElement && focused.closest('[data-focus-chrome]')
      ? { element: focused, tab: workspace.activeId } : null;
    focusMode = next;
    document.body.toggleAttribute('data-focus', next);
    if (next) {
      toasts.show(t('focus.exitHint'), 'info', 3000);
      if (returnFocus) {
        const target = [...(main?.querySelectorAll<HTMLElement>('iframe, [role="grid"], [role="tree"], .text-raw-view, .scroller') ?? [])]
          .find(element => element.getClientRects().length > 0);
        (target ?? main)?.focus({ preventScroll: true });
      }
    } else {
      if (returnFocus?.element.isConnected && returnFocus.tab === workspace.activeId) {
        returnFocus.element.focus({ preventScroll: true });
      } else if (focused instanceof HTMLElement && focused.matches('[data-action="focus-exit"]')) {
        main?.focus({ preventScroll: true });
      }
      returnFocus = null;
    }
  }

  function onFamilyKey(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || !["PageDown", "PageUp"].includes(event.key)) return;
    if (!family(workspace.tabs, workspace.activeId)?.children.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const next = nextSubtab(workspace.tabs, workspace.activeId, event.key === "PageDown" ? 1 : -1);
    if (next !== null) workspace.activate(next);
  }

  function onKeydown(event: KeyboardEvent) {
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && !event.altKey
      && ((!event.shiftKey && shortcutKey(event) === 'd') || (event.shiftKey && shortcutKey(event) === 'b'))) {
      event.preventDefault();
      if (!event.repeat) { if (event.shiftKey) toggleBookmarks(); else addBookmark(); }
      return;
    }
    if (event.key === 'F11' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (!event.repeat) changeFocus('F11');
      return;
    }
    const inField =
      event.target instanceof HTMLElement &&
      ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);

    if (event.ctrlKey || event.metaKey) {
      switch (shortcutKey(event)) {
        case "o":
          event.preventDefault();
          void pickFiles();
          return;
        case "t":
          event.preventDefault();
          workspace.newTab();
          return;
        case "w":
          if (active) {
            event.preventDefault();
            void workspace.close(active.id);
          }
          return;
        case "f":
          if (active) {
            event.preventDefault();
            searchBarFocus?.();
          }
          return;
        case "e":
          if (active && supportsRaw(active.view, active.kind)) {
            event.preventDefault();
            active.mode = active.mode === "rendered" ? "raw" : "rendered";
          }
          return;
        case "+":
        case "=":
          event.preventDefault();
          settings.stepScale(1);
          return;
        case "-":
          event.preventDefault();
          settings.stepScale(-1);
          return;
        case "0":
          event.preventDefault();
          settings.uiScale = 1;
          settings.save();
          return;
        case "Tab": {
          if (workspace.tabs.length < 2) return;
          event.preventDefault();
          const next = nextMainTab(workspace.tabs, workspace.activeId, event.shiftKey ? -1 : 1);
          if (next !== null) workspace.activate(next);
          return;
        }
      }
    }

    if (event.key === 'Escape') {
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
      if (settingsOpen) {
        if (!inField && !event.defaultPrevented) settingsOpen = false;
        return;
      }
      const before = focusMode;
      changeFocus('Escape', event.defaultPrevented);
      if (focusMode !== before) event.preventDefault();
    }
  }
</script>

<svelte:window onkeydowncapture={onFamilyKey} onkeydown={onKeydown} />

<ThemeStyles />

<div class="app" class:dropping={dropActive}>
  <div class="focus-chrome" data-focus-chrome>
  {#if workspace.tabs.length > 0}
    <TabBar onNew={() => workspace.newTab()} />
    <SubTabBar />
  {/if}

  {#if active && active.status !== "blank" && active.status !== 'error'}
    <Toolbar
      tab={active}
      showToc={showToc && !bookmarksOpen}
      {focusMode}
      {bookmarksOpen}
      onAddBookmark={addBookmark}
      onToggleBookmarks={toggleBookmarks}
      onToggleFocus={() => changeFocus('F11')}
      onToggleToc={() => { showToc = bookmarksOpen || !showToc; bookmarksOpen = false; bookmarkDraft = null; }}
      onOpenSettings={() => (settingsOpen = true)}
      onSearch={() => searchBarFocus?.()}
    />
  {/if}

  </div>
  <div class="workspace">
  {#if !active || active.status === 'blank' || active.status === 'error'}
    <button class="empty-bookmarks btn" data-focus-chrome onclick={toggleBookmarks} aria-pressed={bookmarksOpen}
      title={t('bookmarks.toggle')}><Icon name="bookmark" />{t('bookmarks.title')}</button>
  {/if}
  <main bind:this={main} tabindex="-1">
    {#if !active || active.status === "blank"}
      <StartPane onOpenSettings={() => (settingsOpen = true)} />
    {:else}
      <!-- Keyed so switching tabs rebuilds the view against the right document
           instead of reusing another tab's DOM and scroll state. -->
      {#key `${active.id}:${active.meta.generation ?? 0}`}
        {#if active.status === "opening"}
          <!-- The tab is on screen before the backend has answered, so this is
               what fills it until the document exists. -->
          <div class="opening">
            <div class="spinner" aria-hidden="true"></div>
            <p>{t("app.opening", { title: active.meta.title })}</p>
          </div>
        {:else if active.status === 'error'}
          <div class="opening"><p class="error" role="alert">{active.error}</p></div>
        {:else if active.mode === "raw" && supportsRaw(active.view, active.kind)}
          {#if active.kind === 'text' || active.kind === 'html'}
            <TextRawView tab={active} bind:focusSearch={searchBarFocus} />
          {:else}
            <RawView tab={active} bind:focusSearch={searchBarFocus} />
          {/if}
        {:else if active.view === "frame"}
          <FrameView tab={active} showToc={showToc && !bookmarksOpen} probe={smoking} bind:focusSearch={searchBarFocus}
            onShortcut={key => {
              if (key === 'bookmark') addBookmark();
              else if (key === 'bookmarks') toggleBookmarks();
              else changeFocus(key === 'focus' ? 'F11' : 'Escape');
            }} />
        {:else if active.view === "tree"}
          <TreeView tab={active} bind:focusSearch={searchBarFocus} />
        {:else if active.view === "collection"}
          <CollectionView tab={active} bind:focusSearch={searchBarFocus} />
        {:else if active.view === "table"}
          <TableView tab={active} bind:focusSearch={searchBarFocus} />
        {:else if active.view === "archive"}
          <ArchiveView tab={active} bind:focusSearch={searchBarFocus} />
        {:else}
          <MarkdownView tab={active} showToc={showToc && !bookmarksOpen} bind:focusSearch={searchBarFocus} />
        {/if}
      {/key}
    {/if}
  </main>
  {#if bookmarksOpen}
    <BookmarksPanel tab={active} draft={bookmarkDraft} onDone={() => { bookmarkDraft = null; }}
      onClose={() => { bookmarksOpen = false; bookmarkDraft = null; main?.focus(); }} />
  {/if}
  </div>
  {#if positionRestored}<div class="position-status" role="status">{t('session.positionRestored')}</div>{/if}

  {#if dropActive}
    <div class="dropzone">
      <div class="dropzone-inner">
        <Icon name="file" size={24} />
        <p>{t("app.drop")}</p>
      </div>
    </div>
  {/if}
</div>

<button class="focus-exit" data-action="focus-exit" onclick={() => changeFocus('Escape')}
  title={t('focus.exitHint')}>
  <Icon name="close" size={12} />{t('focus.exitLabel')}
</button>

{#if settingsOpen}
  <SettingsPanel onClose={() => (settingsOpen = false)} />
{/if}

<Toast />
{#if updates.dialogOpen && updates.status?.available}<UpdateDialog />{/if}

<style>
  .position-status { flex: none; padding: 0.2rem 0.75rem; color: var(--text-muted); background: var(--bg); font-size: 0.8rem; }
  :global(body[data-focus] [data-focus-chrome]) { display: none !important; }
  :global(body[data-focus] [data-focus-toc]) { grid-template-columns: minmax(0, 1fr) !important; }
  .focus-chrome { display: contents; }
  .focus-exit {
    display: none;
    position: fixed;
    top: 0.5rem;
    right: 0.75rem;
    z-index: 20;
    align-items: center;
    gap: 0.35rem;
    min-height: 2rem;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);
    color: var(--text);
    font-size: 0.8rem;
    cursor: pointer;
  }
  :global(body[data-focus]) .focus-exit { display: inline-flex; }
  .focus-exit:hover, .focus-exit:focus-visible { background: var(--bg-elevated); }
  .focus-exit:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .app {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  main {
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .workspace { position:relative; display:flex; flex:1; min-height:0; }
  .empty-bookmarks { position:absolute; top:0.5rem; left:0.75rem; z-index:1; }

  .dropzone {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 80%, transparent);
    pointer-events: none;
  }

  .dropzone-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    padding: 2rem 3rem;
    border: 2px dashed var(--accent);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    color: var(--accent);
    box-shadow: var(--shadow-md);
  }

  .dropzone-inner p {
    margin: 0;
    font-weight: 600;
  }

  .opening {
    display: flex;
    height: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.9rem;
    color: var(--text-muted);
  }

  .opening p {
    margin: 0;
  }

  .spinner {
    width: 1.5rem;
    height: 1.5rem;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2.4s;
    }
  }
</style>
