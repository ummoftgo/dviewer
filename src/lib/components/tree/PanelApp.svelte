<script lang="ts">
  /**
   * A detached key/value table: the whole contents of a panel window.
   *
   * It is pinned to the node it was opened for. Selecting something else in the
   * tree does not move it and switching tabs does not hide it — that fixity is
   * the point, since two of these side by side is the only way to compare two
   * parts of a document at once.
   *
   * Following a container navigates this window rather than opening another,
   * with a way back. Spawning a window per click would bury the desktop after
   * three levels.
   */
  import { onMount, untrack } from "svelte";
  import Icon from "../Icon.svelte";
  import KeyValueTable from "./KeyValueTable.svelte";
  import { sideButton } from "./navigate";
  import { detectSystemLocale } from "../../i18n";
  import { errorMessage, panelInfo, type TreeRow } from "../../ipc";
  import { NodeHistory } from "../../state/history.svelte";
  import { applySettings, settings, watchSystemTheme } from "../../state/settings.svelte";

  interface Props {
    docId: number;
    nodeId: number;
  }

  let { docId, nodeId }: Props = $props();

  /**
   * Where this window has been, so the side buttons have somewhere to go.
   *
   * Seeded once from `nodeId`, which comes from the URL this window was built
   * with and never changes afterwards. The pin is the feature.
   */
  const history = new NodeHistory();
  untrack(() => history.visit(nodeId));

  let error = $state<string | null>(null);
  let path = $state("");
  let title = $state("");

  const current = $derived(history.current ?? nodeId);

  onMount(() => watchSystemTheme());
  onMount(() => detectSystemLocale());
  onMount(() => {
    void settings.load();
  });

  // A panel window has its own document, so it applies the shared settings for
  // itself — theme, scale and fonts all live in the store, not in the DOM.
  $effect(() => {
    void settings.theme;
    void settings.systemDark;
    void settings.uiScale;
    void settings.uiFontPx;
    void settings.docFontPx;
    void settings.fontBody;
    void settings.fontCode;
    applySettings();
  });

  /**
   * Which node the header is being told about.
   *
   * Following two containers quickly asks twice, and the answers need not come
   * back in order — the header would then name a node this window has already
   * left.
   */
  let asked = 0;

  $effect(() => {
    const node = current;
    const seq = ++asked;
    panelInfo(docId, node)
      .then((info) => {
        if (seq !== asked) return;
        path = info.path;
        title = info.title;
        error = null;
      })
      .catch((err) => {
        if (seq !== asked) return;
        error = errorMessage(err);
      });
  });

  function drillInto(row: TreeRow) {
    history.visit(row.id);
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") history.back();
  }}
  onmousedown={(event) => {
    // Cancelled early: left alone, the webview spends the side buttons on page
    // navigation, which in a single-page app means unloading the document.
    if (sideButton(event)) event.preventDefault();
  }}
  onmouseup={(event) => {
    const direction = sideButton(event);
    if (!direction) return;
    event.preventDefault();
    if (direction === "back") history.back();
    else history.forward();
  }}
/>

<div class="panel-window">
  {#if error}
    <p class="banner error" role="alert">
      <Icon name="warning" />
      {error}
    </p>
  {/if}

  <header class="source">
    <span class="file" title={path}>{title}</span>
  </header>

  <KeyValueTable
    docId={docId}
    nodeId={current}
    onDrill={drillInto}
    onBack={() => history.back()}
    onForward={() => history.forward()}
    canBack={history.canBack}
    canForward={history.canForward}
  />
</div>

<style>
  .panel-window {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  /* Which file this came from. Two panels on the same node of two documents
     are otherwise indistinguishable. */
  .source {
    flex: none;
    padding: 0.25rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .file {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--danger);
  }
</style>
