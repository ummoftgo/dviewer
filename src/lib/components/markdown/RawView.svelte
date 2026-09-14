<script lang="ts">
  import { tick, untrack } from "svelte";
  import { t } from "../../i18n";
  import type { DocTab } from "../../state/docs.svelte";
  import { errorMessage } from "../../ipc";
  import MarkdownSearchBar from './MarkdownSearchBar.svelte';

  interface Props {
    tab: DocTab;
    focusSearch?: (() => void) | null;
  }

  let { tab, focusSearch = $bindable(null) }: Props = $props();
  let scroller = $state<HTMLElement>();
  let source = $state<HTMLElement>();
  let error = $state<string | null>(null);

  $effect(() => {
    const target = tab;
    if (target.raw !== null) return;
    const revision = target.markdownRevision;
    error = null;
    target.busy = true;
    target.loadRaw()
      .then((text) => {
        if (target.markdownRevision === revision) target.raw = text;
      })
      .catch((err) => {
        if (target.markdownRevision === revision) error = errorMessage(err);
      })
      .finally(() => {
        if (target.markdownRevision === revision) target.busy = false;
      });
  });

  // Line numbers are one long text node in a sticky gutter — cheaper than a
  // span per line, and it stays aligned because both sides share a line-height.
  const lines = $derived(tab.raw === null ? [] : tab.raw.split("\n"));
  const gutter = $derived(lines.map((_, i) => i + 1).join("\n"));

  /**
   * Put the reader back where they were, once.
   *
   * Reading `rawScrollTop` in a tracked effect made scrolling retrigger the
   * effect that restores the scroll — every frame of every scroll, to assign
   * the value it already had.
   */
  let restored = false;
  function capture() {
    if (!scroller || !source || tab.raw === null) return;
    const height = parseFloat(getComputedStyle(source).lineHeight);
    const inset = source.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    tab.rawScrollTop = scroller.scrollTop;
    tab.rememberPosition({kind:'raw',line:Math.max(0,Math.min(lines.length - 1,Math.floor((scroller.scrollTop - inset + 1) / height)))});
  }
  $effect(() => {
    if (restored || tab.raw === null || !scroller || !source) return;
    restored = true;
    let live = true;
    void tick().then(() => {
      if (!live || !scroller || !source) return;
      const pos = untrack(() => tab.pendingPosition);
      const height = parseFloat(getComputedStyle(source).lineHeight);
      const inset = source.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = pos?.kind === 'raw' ? (pos.line > 0 && pos.line < lines.length ? inset + pos.line * height : 0) : untrack(() => tab.rawScrollTop);
      if (pos) tab.finishPosition(scroller.scrollTop > 0);
      capture();
    });
    return () => { live = false; };
  });
</script>

<div class="layout" class:with-search={tab.markdownSearch.open}>
<MarkdownSearchBar {tab} root={source} {scroller} ready={tab.raw !== null} bind:focusSearch />
<div
  class="scroller"
  tabindex="-1"
  bind:this={scroller}
  onscroll={capture}
>
  {#if error}
    <p class="status error" role="alert">{error}</p>
  {:else if tab.raw === null}
    <p class="status">{tab.busy ? t("markdown.rawLoading") : t("markdown.rawUnavailable")}</p>
  {:else}
    <div class="raw-view">
      <div class="gutter" aria-hidden="true">{gutter}</div>
      <pre class="source" bind:this={source}>{tab.raw}</pre>
    </div>
  {/if}
</div>
</div>

<style>
  .layout { display: grid; grid-template-rows: minmax(0, 1fr); height: 100%; min-height: 0; }
  .layout.with-search { grid-template-rows: auto minmax(0, 1fr); }
  .scroller {
    height: 100%;
    overflow: auto;
    padding: 1rem 1.25rem;
  }

  .status {
    color: var(--text-muted);
  }
  .status.error { color: var(--danger); }
</style>
