<script lang="ts">
  import { untrack } from "svelte";
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

  $effect(() => {
    const target = tab;
    if (target.raw !== null) return;
    const revision = target.markdownRevision;
    target.busy = true;
    target.loadRaw()
      .then((text) => {
        if (target.markdownRevision === revision) target.raw = text;
      })
      .catch((err) => {
        if (target.markdownRevision === revision) target.error = errorMessage(err);
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
  $effect(() => {
    if (restored || tab.raw === null || !scroller) return;
    restored = true;
    scroller.scrollTop = untrack(() => tab.rawScrollTop);
  });
</script>

<div class="layout" class:with-search={tab.markdownSearch.open}>
<MarkdownSearchBar {tab} root={source} {scroller} ready={tab.raw !== null} bind:focusSearch />
<div
  class="scroller"
  tabindex="-1"
  bind:this={scroller}
  onscroll={(e) => (tab.rawScrollTop = e.currentTarget.scrollTop)}
>
  {#if tab.raw === null}
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
</style>
