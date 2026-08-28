<script lang="ts">
  /**
   * Find-in-grid.
   *
   * Simpler than the tree's search bar because the backend answers in one call
   * rather than streaming — the hit list is capped low enough to cross the IPC
   * boundary whole, and a grid has nowhere to show partial results anyway.
   *
   * Stepping through hits works by writing `tab.pendingCell`; the grid watches
   * that and does the scrolling. Keeping the two apart is what lets this be a
   * component at all — it never touches the viewport.
   */
  import Icon from "../Icon.svelte";
  import { errorMessage, tableSearch } from "../../ipc";
  import type { DocTab } from "../../state/docs.svelte";

  interface Props {
    tab: DocTab;
  }

  let { tab }: Props = $props();
  let queryInput = $state<HTMLInputElement>();

  /** Called by the parent for Ctrl+F. */
  export function focus() {
    queryInput?.select();
  }

  async function runSearch(event?: Event) {
    event?.preventDefault();
    const search = tab.tableSearch;
    const query = search.query.trim();
    if (!query) {
      search.reset();
      return;
    }
    search.running = true;
    search.error = null;
    search.searched = true;
    try {
      const result = await tableSearch(tab.id, query, search.caseSensitive);
      search.hits = result.hits;
      search.capped = result.capped;
      search.current = result.hits.length > 0 ? 0 : -1;
      if (result.hits.length > 0) tab.pendingCell = result.hits[0];
    } catch (err) {
      search.error = errorMessage(err);
      search.hits = [];
      search.current = -1;
    } finally {
      search.running = false;
    }
  }

  function step(delta: number) {
    const search = tab.tableSearch;
    if (search.hits.length === 0) return;
    search.current = (search.current + delta + search.hits.length) % search.hits.length;
    tab.pendingCell = search.hits[search.current];
  }

  function clearSearch() {
    tab.tableSearch.reset();
    tab.tableSearch.query = "";
  }
</script>

<form class="searchbar" onsubmit={runSearch}>
  <Icon name="search" size={13} />
  <input
    bind:this={queryInput}
    bind:value={tab.tableSearch.query}
    type="search"
    placeholder="표 안에서 찾기"
    aria-label="표 안에서 찾기"
    onkeydown={(e) => {
      if (e.key === "Escape") clearSearch();
    }}
  />
  <label class="case" title="대소문자 구분">
    <input type="checkbox" bind:checked={tab.tableSearch.caseSensitive} />
    Aa
  </label>
  <button class="btn btn-ghost" type="submit" disabled={tab.tableSearch.running}>
    {tab.tableSearch.running ? "찾는 중…" : "찾기"}
  </button>

  {#if tab.tableSearch.hits.length > 0}
    <span class="count">
      {tab.tableSearch.current + 1} / {tab.tableSearch.hits.length.toLocaleString()}
      {#if tab.tableSearch.capped}<span class="capped" title="결과가 너무 많아 일부만 모았습니다"
          >+</span
        >{/if}
    </span>
    <button class="icon-btn" type="button" onclick={() => step(-1)} aria-label="이전 결과">
      <Icon name="chevron-up" size={13} />
    </button>
    <button class="icon-btn" type="button" onclick={() => step(1)} aria-label="다음 결과">
      <Icon name="chevron-down" size={13} />
    </button>
    <button class="btn btn-ghost" type="button" onclick={clearSearch}>지우기</button>
  {:else if tab.tableSearch.searched && !tab.tableSearch.running}
    <span class="count empty">결과 없음</span>
  {/if}

  {#if tab.tableSearch.error}
    <span class="count error">{tab.tableSearch.error}</span>
  {/if}
</form>

<style>
  .searchbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
  }

  .searchbar input[type="search"] {
    flex: 1;
    min-width: 6rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text);
    font: inherit;
  }

  .case {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.85em;
  }

  .count {
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .count.empty {
    color: var(--text-muted);
  }

  .count.error {
    color: var(--danger);
  }

  .capped {
    color: var(--text-muted);
  }
</style>
