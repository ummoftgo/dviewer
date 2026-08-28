<script lang="ts">
  import Icon from "../Icon.svelte";
  import {
    errorMessage,
    treeClearFilter,
    treeClearSearch,
    treeFilterMatches,
    treeHitRow,
    treeSearch,
    treeSearchCancel,
    type SearchScope,
  } from "../../ipc";
  import type { DocTab } from "../../state/docs.svelte";

  interface Props {
    tab: DocTab;
  }

  let { tab }: Props = $props();
  let input = $state<HTMLInputElement>();

  // Whether the tree is filtered is decided by Rust; mirroring it in a second
  // flag is how the UI and the backend drift apart.
  const filtered = $derived(tab.treeStats?.filtered ?? false);

  const SCOPES: { value: SearchScope; label: string; title: string }[] = [
    { value: "all", label: "전체", title: "키와 값에서 찾기" },
    { value: "keys", label: "키", title: "키에서만 찾기" },
    { value: "values", label: "값", title: "값에서만 찾기" },
    { value: "paths", label: "경로", title: "$.items[3].name 같은 경로에서 찾기" },
  ];

  const placeholder = $derived(
    tab.search.scope === "paths" ? "경로에서 찾기 — 예: items[3].name" : "키와 값에서 찾기 (Ctrl+F)",
  );

  export function focus() {
    input?.select();
  }

  async function run(event?: SubmitEvent) {
    event?.preventDefault();
    const search = tab.search;
    if (!search.query.trim()) {
      await clear();
      return;
    }
    search.reset();
    search.running = true;
    try {
      await treeSearch(tab.id, {
        query: search.query,
        caseSensitive: search.caseSensitive,
        scope: search.scope,
      });
    } catch (err) {
      search.running = false;
      search.error = errorMessage(err);
    }
  }

  async function clear() {
    const search = tab.search;
    try {
      await treeSearchCancel(tab.id);
      tab.treeStats = await treeClearSearch(tab.id);
    } catch (err) {
      tab.error = errorMessage(err);
    }
    search.query = "";
    search.reset();
  }

  async function jump(delta: number) {
    const search = tab.search;
    if (search.hits.length === 0) return;
    const next = (search.current + delta + search.hits.length) % search.hits.length;
    search.current = next;
    try {
      const result = await treeHitRow(tab.id, next);
      tab.treeStats = result.stats;
      if (result.row !== null) tab.pendingRow = result.row;
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  async function toggleFilter() {
    try {
      tab.treeStats = filtered ? await treeClearFilter(tab.id) : await treeFilterMatches(tab.id);
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (tab.search.hits.length > 0) void jump(event.shiftKey ? -1 : 1);
      else void run();
    }
    if (event.key === "Escape") void clear();
  }

  const status = $derived.by(() => {
    const search = tab.search;
    if (search.error) return search.error;
    if (search.running) return `찾는 중… ${search.hits.length.toLocaleString()}건`;
    if (search.summary) {
      const position = search.current >= 0 ? `${search.current + 1} / ` : "";
      const capped = search.summary.capped ? " (상한 도달)" : "";
      return `${position}${search.summary.total.toLocaleString()}건${capped}`;
    }
    return null;
  });
</script>

<form class="search" onsubmit={run}>
  <div class="box">
    <Icon name="search" size={13} />
    <input
      bind:this={input}
      bind:value={tab.search.query}
      onkeydown={onKeydown}
      type="search"
      {placeholder}
      spellcheck="false"
      autocomplete="off"
    />
    {#if status}<span class="count" class:error={!!tab.search.error}>{status}</span>{/if}
  </div>

  <div class="segmented">
    {#each SCOPES as scope (scope.value)}
      <button
        type="button"
        title={scope.title}
        aria-pressed={tab.search.scope === scope.value}
        onclick={() => {
          tab.search.scope = scope.value;
          void run();
        }}>{scope.label}</button
      >
    {/each}
  </div>

  <button
    type="button"
    class="icon-btn"
    class:on={tab.search.caseSensitive}
    title="대소문자 구분"
    aria-pressed={tab.search.caseSensitive}
    onclick={() => {
      tab.search.caseSensitive = !tab.search.caseSensitive;
      void run();
    }}
  >
    <span class="aa">Aa</span>
  </button>

  <button
    type="button"
    class="icon-btn"
    title="이전 결과 (Shift+Enter)"
    aria-label="이전 결과"
    disabled={tab.search.hits.length === 0}
    onclick={() => jump(-1)}
  >
    <Icon name="chevron-up" size={13} />
  </button>
  <button
    type="button"
    class="icon-btn"
    title="다음 결과 (Enter)"
    aria-label="다음 결과"
    disabled={tab.search.hits.length === 0}
    onclick={() => jump(1)}
  >
    <Icon name="chevron-down" size={13} />
  </button>

  <button
    type="button"
    class="icon-btn"
    class:on={filtered}
    title="결과만 남기기"
    aria-pressed={filtered}
    disabled={tab.search.hits.length === 0 && !filtered}
    onclick={toggleFilter}
  >
    <Icon name="filter" size={13} />
  </button>

  {#if tab.search.query || filtered}
    <button type="button" class="icon-btn" title="검색 지우기" aria-label="검색 지우기" onclick={clear}>
      <Icon name="close" size={13} />
    </button>
  {/if}
</form>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-subtle);
  }

  .box {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    min-width: 0;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text-muted);
  }

  .box:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    outline: none;
    color: var(--text);
  }

  /* The native search-field clear button duplicates our own. */
  input::-webkit-search-cancel-button {
    display: none;
  }

  .count {
    flex: none;
    font-size: 0.92em;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  .count.error {
    color: var(--danger);
  }

  .icon-btn.on {
    background: var(--accent-subtle);
    color: var(--accent);
  }

  .icon-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .aa {
    font-size: 0.85em;
    font-weight: 650;
    line-height: 1;
  }
</style>
