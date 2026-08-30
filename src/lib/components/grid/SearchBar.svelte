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
  import { n, t } from "../../i18n";
  import { errorMessage, gridSearch } from "../../ipc";
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
    // Starting a search cancels the one before it, so the earlier call comes
    // back as a cancellation — an answer to a question nobody is asking any
    // more. Without this it would clear the hits and show that cancellation as
    // an error while the search the reader is waiting for is still running.
    const seq = search.begin();
    const mine = () => seq === search.seq;
    try {
      const result = await gridSearch(tab.id, query, search.caseSensitive, search.how);
      if (!mine()) return;
      search.hits = result.hits;
      search.capped = result.capped;
      search.current = result.hits.length > 0 ? 0 : -1;
      if (result.hits.length > 0) tab.pendingCell = result.hits[0];
    } catch (err) {
      if (!mine()) return;
      search.error = errorMessage(err);
      search.hits = [];
      search.current = -1;
    } finally {
      if (mine()) search.running = false;
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
    placeholder={t("table.search.placeholder")}
    aria-label={t("table.search.placeholder")}
    onkeydown={(e) => {
      if (e.key === "Escape") clearSearch();
    }}
  />
  <!-- Beside the case toggle, because the two answer the same question in
       sequence: how should the box read what I typed. -->
  <label class="case" title={t("search.regex.title")}>
    <input
      type="checkbox"
      checked={tab.tableSearch.how === "regex"}
      onchange={(event) =>
        (tab.tableSearch.how = event.currentTarget.checked ? "regex" : "literal")}
    />
    .*
  </label>
  <label class="case" title={t("search.caseSensitive")}>
    <input type="checkbox" bind:checked={tab.tableSearch.caseSensitive} />
    Aa
  </label>
  <button class="btn btn-ghost" type="submit" disabled={tab.tableSearch.running}>
    {tab.tableSearch.running ? t("table.search.running") : t("table.search.run")}
  </button>

  {#if tab.tableSearch.hits.length > 0}
    <span class="count">
      {n(tab.tableSearch.current + 1)} / {n(tab.tableSearch.hits.length)}
      {#if tab.tableSearch.capped}<span class="capped" title={t("table.search.capped")}
          >+</span
        >{/if}
    </span>
    <button class="icon-btn" type="button" onclick={() => step(-1)} aria-label={t("search.prevLabel")}>
      <Icon name="chevron-up" size={13} />
    </button>
    <button class="icon-btn" type="button" onclick={() => step(1)} aria-label={t("search.nextLabel")}>
      <Icon name="chevron-down" size={13} />
    </button>
    <button class="btn btn-ghost" type="button" onclick={clearSearch}>{t("action.clear")}</button>
  {:else if tab.tableSearch.searched && !tab.tableSearch.running}
    <span class="count empty">{t("table.search.empty")}</span>
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
