<script lang="ts">
  /**
   * Key/value table for the level the selection sits on.
   *
   * The tree answers "where am I"; this answers "what is here". Selecting a
   * container shows its own entries, and selecting a scalar shows the entries
   * around it — Rust decides which, so the panel never has to know a node's
   * parent (see `TreeIndex::table_target`).
   */
  import ContextMenu from "../ContextMenu.svelte";
  import Icon from "../Icon.svelte";
  import Splitter from "../Splitter.svelte";
  import EscapedText from "../EscapedText.svelte";
  import {
    errorMessage,
    treeChildren,
    treeReveal,
    type ChildrenPage,
    type TreeRow,
  } from "../../ipc";
  import { copyMenuItems } from "./actions";
  import type { MenuItem } from "../menu";
  import type { DocTab } from "../../state/docs.svelte";
  import { settings } from "../../state/settings.svelte";

  interface Props {
    tab: DocTab;
    onClose: () => void;
  }

  let { tab, onClose }: Props = $props();

  /** Enough to fill the panel; a wide array pages in on demand. */
  const PAGE = 100;

  let page = $state<ChildrenPage | null>(null);
  let loaded = $state<TreeRow[]>([]);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let requestSeq = 0;
  let menu = $state<{ x: number; y: number; row: TreeRow } | null>(null);

  // The same entries the tree offers, from the same code — see actions.ts.
  const menuItems = $derived.by((): MenuItem[] => (menu ? copyMenuItems(tab.id, menu.row) : []));

  function openMenu(event: MouseEvent, row: TreeRow) {
    event.preventDefault();
    menu = { x: event.clientX, y: event.clientY, row };
  }

  $effect(() => {
    const node = tab.selectedNode;
    if (node === null || !tab.treeStats) {
      page = null;
      loaded = [];
      return;
    }
    const seq = ++requestSeq;
    treeChildren(tab.id, node, 0, PAGE)
      .then((result) => {
        if (seq !== requestSeq) return;
        page = result;
        loaded = result?.rows ?? [];
        error = null;
      })
      .catch((err) => {
        if (seq !== requestSeq) return;
        error = errorMessage(err);
      });
  });

  async function loadMore() {
    if (!page || loadingMore) return;
    loadingMore = true;
    const seq = requestSeq;
    try {
      const next = await treeChildren(tab.id, page.target, loaded.length, PAGE);
      if (seq !== requestSeq || !next) return;
      loaded = [...loaded, ...next.rows];
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loadingMore = false;
    }
  }

  /** Follow a nested container: same effect as clicking it in the tree. */
  async function drillInto(row: TreeRow) {
    try {
      const result = await treeReveal(tab.id, row.id);
      tab.treeStats = result.stats;
      tab.selectedNode = row.id;
      if (result.row !== null) tab.pendingRow = result.row;
    } catch (err) {
      error = errorMessage(err);
    }
  }

  /** The same labels the tree uses, so the two never disagree about a node. */
  function label(row: TreeRow): string {
    switch (row.kind) {
      case "element":
      case "elementText":
        return `<${row.key ?? ""}>`;
      case "attribute":
        return `@${row.key ?? ""}`;
      case "text":
        return "#text";
      case "comment":
        return "#comment";
      case "cdata":
        return "#cdata";
      case "directive":
        return "#directive";
    }
    if (row.key !== null) return row.key;
    return row.index !== null ? `[${row.index}]` : "";
  }

  function summary(row: TreeRow): string {
    if (row.kind === "element") return row.childCount === 0 ? "< >" : "< … >";
    if (row.kind === "array") return row.childCount === 0 ? "[ ]" : "[ … ]";
    return row.childCount === 0 ? "{ }" : "{ … }";
  }

  const remaining = $derived(page ? page.total - loaded.length : 0);

  /**
   * The key column and its divider are both sized from one pixel value.
   *
   * A percentage would not line them up: the table fills the scroller's content
   * box while the divider is positioned against the panel, and a vertical
   * scrollbar makes those differ by its width.
   */
  let scroller = $state<HTMLElement>();
  let tableWidth = $state(0);

  $effect(() => {
    const node = scroller;
    if (!node) return;
    const observer = new ResizeObserver(() => (tableWidth = node.clientWidth));
    observer.observe(node);
    tableWidth = node.clientWidth;
    return () => observer.disconnect();
  });

  const keyColumnPx = $derived(Math.round(settings.inspectorKeyRatio * tableWidth));
</script>

<aside
  class="inspector"
  aria-label="선택한 항목의 키와 값"
  style="--key-col: {keyColumnPx}px"
>
  <header>
    <div class="target">
      <span class="path" title={page?.targetPath}><bdi>{page?.targetPath ?? ""}</bdi></span>
      {#if page}
        <span class="count">{page.total.toLocaleString()}개 항목</span>
      {/if}
    </div>
    <button class="icon-btn" onclick={onClose} aria-label="표 닫기" title="표 닫기">
      <Icon name="close" />
    </button>
  </header>

  <div class="body">
    <div class="scroll" bind:this={scroller}>
      {#if error}
        <p class="note error">{error}</p>
      {:else if tab.selectedNode === null}
        <p class="note">트리에서 항목을 선택하면 이 자리에 키와 값이 표로 나옵니다.</p>
      {:else if !page}
        <p class="note">이 값에는 하위 항목이 없습니다.</p>
      {:else if loaded.length === 0}
        <p class="note">비어 있습니다.</p>
      {:else}
        <table>
          <thead>
            <tr><th scope="col">키</th><th scope="col">값</th></tr>
          </thead>
          <tbody>
            {#each loaded as row (row.id)}
              <tr
                class:selected={row.id === tab.selectedNode}
                oncontextmenu={(e) => openMenu(e, row)}
              >
                <th scope="row" title={label(row)}><EscapedText text={label(row)} /></th>
                <td>
                  {#if row.container}
                    <!-- Containers cannot be shown inline, so they become a way in. -->
                    <button class="drill" onclick={() => drillInto(row)} title="이 항목으로 이동">
                      {summary(row)}
                      <span class="children">{row.childCount.toLocaleString()}</span>
                    </button>
                  {:else}
                    <span class="value" data-kind={row.kind} title={row.value ?? ""}>
                      {#if row.kind === "string"}"<EscapedText
                          text={row.value ?? ""}
                        />"{:else}<EscapedText text={row.value ?? ""} />{/if}{#if row.truncated}…{/if}
                    </span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        {#if remaining > 0}
          <button class="btn more" onclick={loadMore} disabled={loadingMore}>
            {loadingMore ? "불러오는 중…" : `${remaining.toLocaleString()}개 더 보기`}
          </button>
        {/if}
      {/if}
    </div>

    {#if page && loaded.length > 0}
      <Splitter
        class="column-divider"
        bind:value={settings.inspectorKeyRatio}
        measure={(event) => {
          // Measured against the table, not the panel, so the edge lands under
          // the pointer even when a scrollbar makes the two differ.
          const rect = scroller?.getBoundingClientRect();
          return rect && tableWidth > 0
            ? (event.clientX - rect.left) / tableWidth
            : settings.inspectorKeyRatio;
        }}
        bounds={() => ({ min: 0.15, max: 0.75 })}
        step={0.02}
        reset={0.4}
        label="키 열 너비"
        onCommit={() => settings.save()}
      />
    {/if}
  </div>
</aside>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => (menu = null)} />
{/if}

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--bg-subtle);
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.35rem 0.35rem 0.35rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .target {
    flex: 1;
    min-width: 0;
  }

  .path {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Truncate long paths from the left; <bdi> keeps the text itself LTR. */
    direction: rtl;
    text-align: left;
    font-family: var(--font-code);
    font-size: 0.92em;
    color: var(--text-secondary);
  }

  .count {
    font-size: 0.85em;
    color: var(--text-muted);
  }

  .body {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .scroll {
    height: 100%;
    overflow: auto;
  }

  /* Spans the panel, not the scrolled content, so it stays put while the rows
     move under it. */
  .body :global(.column-divider) {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--key-col);
    width: 1px;
    background: transparent;
  }

  .body :global(.column-divider:hover),
  .body :global(.column-divider:focus-visible),
  .body :global(.column-divider.dragging) {
    background: var(--accent);
  }

  .note {
    margin: 0;
    padding: 1rem 0.75rem;
    color: var(--text-muted);
    font-size: 0.92em;
  }

  .note.error {
    color: var(--danger);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-code);
    font-size: var(--doc-font-size);
    table-layout: fixed;
  }

  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: 0.85em;
    font-weight: 600;
    text-align: left;
  }

  thead th:first-child {
    width: var(--key-col);
  }

  tbody th,
  tbody td {
    padding: 0.25rem 0.6rem;
    /* No row rules — the stripes already separate rows, and both together
       makes the table noisier than the data in it. */
    text-align: left;
    font-weight: normal;
    vertical-align: top;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  tbody th {
    color: var(--json-key);
  }

  /* Zebra striping: with two narrow columns the eye loses the row on the way
     across, and a stripe is cheaper to follow than a rule. */
  tbody tr:nth-child(even) {
    background: var(--bg-inset);
  }

  tbody tr:hover {
    background: var(--bg-hover);
  }

  tbody tr.selected {
    background: var(--accent-subtle);
  }

  .drill {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
  }

  .drill:hover {
    text-decoration: underline;
  }

  .children {
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .value[data-kind="string"] { color: var(--json-string); }
  .value[data-kind="number"] { color: var(--json-number); }
  .value[data-kind="bool"] { color: var(--json-bool); }
  .value[data-kind="null"] { color: var(--json-null); font-style: italic; }
  .value[data-kind="comment"] { color: var(--xml-comment); font-style: italic; }
  .value[data-kind="directive"] { color: var(--xml-meta); }

  .more {
    width: calc(100% - 1.2rem);
    justify-content: center;
    margin: 0.6rem;
  }
</style>
