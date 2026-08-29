<script lang="ts">
  import { untrack } from "svelte";
  import { t } from "../../i18n";
  import type { DocTab } from "../../state/docs.svelte";
  import { docSourceText, errorMessage } from "../../ipc";

  interface Props {
    tab: DocTab;
  }

  let { tab }: Props = $props();
  let scroller = $state<HTMLElement>();

  $effect(() => {
    const target = tab;
    if (target.raw !== null) return;
    target.busy = true;
    docSourceText(target.id)
      .then((text) => {
        target.raw = text;
      })
      .catch((err) => {
        target.error = errorMessage(err);
      })
      .finally(() => {
        target.busy = false;
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

<div
  class="scroller"
  bind:this={scroller}
  onscroll={(e) => (tab.rawScrollTop = e.currentTarget.scrollTop)}
>
  {#if tab.raw === null}
    <p class="status">{tab.busy ? t("markdown.rawLoading") : t("markdown.rawUnavailable")}</p>
  {:else}
    <div class="raw-view">
      <div class="gutter" aria-hidden="true">{gutter}</div>
      <pre class="source">{tab.raw}</pre>
    </div>
  {/if}
</div>

<style>
  .scroller {
    height: 100%;
    overflow: auto;
    padding: 1rem 1.25rem;
  }

  .status {
    color: var(--text-muted);
  }
</style>
