<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import Icon from "./lib/components/Icon.svelte";
  import SettingsPanel from "./lib/components/SettingsPanel.svelte";
  import StartPane from "./lib/components/StartPane.svelte";
  import TabBar from "./lib/components/TabBar.svelte";
  import Toast from "./lib/components/Toast.svelte";
  import ThemeStyles from "./lib/components/ThemeStyles.svelte";
  import Toolbar from "./lib/components/Toolbar.svelte";
  import JsonView from "./lib/components/json/JsonView.svelte";
  import MarkdownView from "./lib/components/markdown/MarkdownView.svelte";
  import RawView from "./lib/components/markdown/RawView.svelte";
  import * as ipc from "./lib/ipc";
  import { pickFiles } from "./lib/open";
  import { workspace } from "./lib/state/docs.svelte";
  import { recents } from "./lib/state/recents.svelte";
  import { applySettings, settings, watchSystemTheme } from "./lib/state/settings.svelte";

  let settingsOpen = $state(false);
  let showToc = $state(true);
  let dropActive = $state(false);
  let searchBarFocus = $state<(() => void) | null>(null);

  const active = $derived(workspace.active);

  // --- settings -----------------------------------------------------------

  onMount(() => watchSystemTheme());

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

  onMount(() => {
    void settings.load();
    void recents.load();
    void ipc
      .startupPaths()
      .then((paths) => Promise.all(paths.map((path) => workspace.openPath(path))))
      .catch((err) => console.warn("[dviewer] 시작 인자를 처리하지 못했습니다:", err));
  });

  // --- backend events -----------------------------------------------------
  //
  // Subscribed once for the whole app and routed by docId, so a background tab
  // keeps indexing and searching while the user reads something else.

  onMount(() => {
    const subscriptions = [
      ipc.on("json:progress", ({ docId, bytesDone, bytesTotal }) => {
        const tab = workspace.tab(docId);
        if (tab) tab.indexing = { done: bytesDone, total: bytesTotal };
      }),
      ipc.on("json:ready", ({ docId, stats }) => {
        const tab = workspace.tab(docId);
        if (!tab) return;
        tab.stats = stats;
        tab.indexing = null;
        tab.error = null;
      }),
      ipc.on("json:error", ({ docId, message }) => {
        const tab = workspace.tab(docId);
        if (!tab) return;
        tab.error = message;
        tab.indexing = null;
      }),
      ipc.on("json:search-batch", ({ docId, hits }) => {
        const tab = workspace.tab(docId);
        if (!tab) return;
        tab.search.hits = [...tab.search.hits, ...hits];
      }),
      ipc.on("json:search-done", ({ docId, summary }) => {
        const tab = workspace.tab(docId);
        if (!tab) return;
        tab.search.running = false;
        tab.search.summary = summary;
      }),
      ipc.on("json:search-error", ({ docId, message }) => {
        const tab = workspace.tab(docId);
        if (!tab) return;
        tab.search.running = false;
        tab.search.error = message;
      }),
    ];

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
        void Promise.all(event.payload.paths.map((path) => workspace.openPath(path)));
      } else {
        dropActive = false;
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  });

  // --- keyboard -----------------------------------------------------------

  function onKeydown(event: KeyboardEvent) {
    const inField =
      event.target instanceof HTMLElement &&
      ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);

    if (event.ctrlKey || event.metaKey) {
      switch (event.key) {
        case "o":
          event.preventDefault();
          void pickFiles();
          return;
        case "w":
          if (active) {
            event.preventDefault();
            void workspace.close(active.id);
          }
          return;
        case "f":
          if (active?.kind === "json") {
            event.preventDefault();
            searchBarFocus?.();
          }
          return;
        case "e":
          if (active?.kind === "markdown") {
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
          const index = workspace.tabs.findIndex((t) => t.id === workspace.activeId);
          const step = event.shiftKey ? -1 : 1;
          const next = (index + step + workspace.tabs.length) % workspace.tabs.length;
          workspace.activate(workspace.tabs[next].id);
          return;
        }
      }
    }

    if (event.key === "Escape" && settingsOpen && !inField) {
      settingsOpen = false;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<ThemeStyles />

<div class="app" class:dropping={dropActive}>
  {#if workspace.tabs.length > 0}
    <TabBar onNew={pickFiles} />
  {/if}

  {#if active}
    <Toolbar
      tab={active}
      {showToc}
      onToggleToc={() => (showToc = !showToc)}
      onOpenSettings={() => (settingsOpen = true)}
    />
  {/if}

  <main>
    {#if !active}
      <StartPane onOpenSettings={() => (settingsOpen = true)} />
    {:else}
      <!-- Keyed so switching tabs rebuilds the view against the right document
           instead of reusing another tab's DOM and scroll state. -->
      {#key active.id}
        {#if active.status === "opening"}
          <!-- The tab is on screen before the backend has answered, so this is
               what fills it until the document exists. -->
          <div class="opening">
            <div class="spinner" aria-hidden="true"></div>
            <p>{active.meta.title} 여는 중…</p>
          </div>
        {:else if active.kind === "json"}
          <JsonView tab={active} bind:focusSearch={searchBarFocus} />
        {:else if active.mode === "raw"}
          <RawView tab={active} />
        {:else}
          <MarkdownView tab={active} {showToc} />
        {/if}
      {/key}
    {/if}
  </main>

  {#if dropActive}
    <div class="dropzone">
      <div class="dropzone-inner">
        <Icon name="file" size={24} />
        <p>여기에 놓으면 문서를 엽니다</p>
      </div>
    </div>
  {/if}
</div>

{#if settingsOpen}
  <SettingsPanel onClose={() => (settingsOpen = false)} />
{/if}

<Toast />

<style>
  .app {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  main {
    flex: 1;
    min-height: 0;
  }

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
