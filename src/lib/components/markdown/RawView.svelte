<script lang="ts">
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

  $effect(() => {
    if (tab.raw !== null && scroller) scroller.scrollTop = tab.rawScrollTop;
  });
</script>

<div
  class="scroller"
  bind:this={scroller}
  onscroll={(e) => (tab.rawScrollTop = e.currentTarget.scrollTop)}
>
  {#if tab.raw === null}
    <p class="status">{tab.busy ? "원문을 읽는 중…" : "원문을 표시할 수 없습니다."}</p>
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
