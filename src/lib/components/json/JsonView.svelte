<script lang="ts">
  import { untrack } from "svelte";
  import Icon from "../Icon.svelte";
  import ContextMenu from "../ContextMenu.svelte";
  import Splitter from "../Splitter.svelte";
  import JsonInspector from "./JsonInspector.svelte";
  import JsonText from "./JsonText.svelte";
  import JsonSearchBar from "./JsonSearchBar.svelte";
  import {
    errorMessage,
    jsonCollapseAll,
    jsonExpandAll,
    jsonOpen,
    jsonRows,
    jsonSetExpandDepth,
    jsonToggle,
    type JsonRow,
  } from "../../ipc";
  import { copyMenuItems, copyPath, copyValue, pathOf } from "./actions";
  import type { MenuItem } from "../menu";
  import type { DocTab } from "../../state/docs.svelte";
  import { settings } from "../../state/settings.svelte";

  interface Props {
    tab: DocTab;
    /** Exposed upward so the global Ctrl+F shortcut can reach the search box. */
    focusSearch?: (() => void) | null;
  }

  let { tab, focusSearch = $bindable(null) }: Props = $props();
  let searchBar = $state<ReturnType<typeof JsonSearchBar>>();

  $effect(() => {
    focusSearch = searchBar ? () => searchBar?.focus() : null;
    return () => {
      focusSearch = null;
    };
  });

  /** Extra rows fetched above and below the viewport to hide scroll latency. */
  const OVERSCAN = 24;
  /** Matches MAX_EXPAND_DEPTH in src-tauri/src/json/index.rs. */
  const MAX_EXPAND_DEPTH = 9;
  /** Long enough that skimming the tree does not fire a request per row. */
  const HOVER_DELAY_MS = 350;
  /** Room the popover needs above a key before it has to flip below it. */
  const POPOVER_CLEARANCE = 46;

  let viewport = $state<HTMLElement>();
  let rows = $state<JsonRow[]>([]);
  let windowStart = $state(0);
  let selectedRow = $state<number | null>(null);
  let expandDepth = $state(MAX_EXPAND_DEPTH);
  let requestSeq = 0;

  let menu = $state<{ x: number; y: number; row: JsonRow } | null>(null);
  let hover = $state<{
    path: string;
    left: number;
    /** Distance from the viewport edge named by `above`. */
    offset: number;
    above: boolean;
    maxWidth: number;
  } | null>(null);
  /** Path of the selected row, shown in the status bar. */
  let selectedPath = $state("");
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  // Row height is computed here rather than read from CSS so the spacer maths
  // and the rendered rows can never drift apart.
  const rowHeight = $derived(
    Math.max(18, Math.round(settings.docFontPx * settings.uiScale * 1.7)),
  );
  const totalRows = $derived(tab.stats?.visibleRows ?? 0);
  const selected = $derived(
    selectedRow === null ? null : (rows[selectedRow - windowStart] ?? null),
  );
  const depthOptions = $derived(
    Array.from({ length: Math.min(tab.stats?.maxDepth ?? 0, MAX_EXPAND_DEPTH) + 1 }, (_, i) => i),
  );
  /**
   * The default of 9 means "as deep as it goes". A document shallower than that
   * has no option to match it, so show the depth that is actually in effect —
   * otherwise the control renders blank.
   */
  const shownDepth = $derived(Math.min(expandDepth, tab.stats?.maxDepth ?? expandDepth));

  /**
   * The guide column to highlight, and the rows it spans.
   *
   * In a pre-order listing a block is contiguous: it runs from its header row
   * down through every following row deeper than it. So walking the loaded
   * window outward from the selection until the depth drops below it gives the
   * exact extent of the sibling group — no extra data from Rust required.
   */
  const activeGuide = $derived.by(() => {
    if (!selected || selected.depth === 0 || selectedRow === null) return null;
    const here = selectedRow - windowStart;
    let first = here;
    while (first > 0 && rows[first - 1].depth >= selected.depth) first--;
    let last = here;
    while (last < rows.length - 1 && rows[last + 1].depth >= selected.depth) last++;
    return { level: selected.depth - 1, from: windowStart + first, to: windowStart + last };
  });

  // Keyboard parity for the hover popover: arrowing through the tree keeps the
  // status bar showing where you are, without touching the mouse.
  $effect(() => {
    const row = selected;
    if (!row) {
      selectedPath = "";
      return;
    }
    let cancelled = false;
    // Debounced so holding an arrow key resolves the row you land on, not
    // every row you passed over.
    const timer = setTimeout(() => {
      pathOf(tab.id, row.id)
        .then((path) => {
          if (!cancelled) selectedPath = path;
        })
        .catch(() => {
          if (!cancelled) selectedPath = "";
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  // Written only when a row is actually loaded, so scrolling the selection out
  // of the window never blanks the inspector.
  $effect(() => {
    if (selected) tab.selectedNode = selected.id;
  });

  function guideActive(rowIndex: number, level: number): boolean {
    const guide = activeGuide;
    return guide !== null && level === guide.level && rowIndex >= guide.from && rowIndex <= guide.to;
  }

  // Kick off indexing the first time a JSON tab is shown.
  $effect(() => {
    const target = tab;
    if (target.stats || target.indexing || target.error) return;
    target.indexing = { done: 0, total: target.meta.byteLen };
    jsonOpen(target.id).catch((err) => {
      target.error = errorMessage(err);
      target.indexing = null;
    });
  });

  // Any change to the tree shape (indexing finished, a toggle, a filter) makes
  // the cached window stale. The dependencies are listed explicitly and the
  // call is untracked, so editing ensureWindow can never widen them by accident
  // — reading `rows` in there would otherwise make this effect retrigger itself.
  $effect(() => {
    void tab.stats;
    void rowHeight;
    void viewport;
    untrack(() => void ensureWindow(true));
  });

  $effect(() => {
    const row = tab.pendingRow;
    if (row === null || !viewport || !tab.stats) return;
    tab.pendingRow = null;
    // Park the target a third of the way down rather than at the very top.
    viewport.scrollTop = Math.max(0, (row - Math.floor(visibleCount() / 3)) * rowHeight);
    selectedRow = row;
    void ensureWindow(true);
  });

  function visibleCount() {
    return Math.ceil((viewport?.clientHeight ?? 0) / rowHeight) + 1;
  }

  async function ensureWindow(force = false) {
    const stats = tab.stats;
    if (!stats || !viewport) return;

    const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeight));
    const last = Math.min(stats.visibleRows, first + visibleCount());
    if (!force && first >= windowStart && last <= windowStart + rows.length) return;

    const start = Math.max(0, first - OVERSCAN);
    const count = Math.min(stats.visibleRows - start, visibleCount() + OVERSCAN * 2);
    if (count <= 0) {
      rows = [];
      windowStart = 0;
      return;
    }

    const seq = ++requestSeq;
    try {
      const fetched = await jsonRows(tab.id, start, count);
      // A later scroll has already superseded this request.
      if (seq !== requestSeq) return;
      windowStart = start;
      rows = fetched;
    } catch (err) {
      if (seq === requestSeq) tab.error = errorMessage(err);
    }
  }

  function onScroll(event: Event) {
    tab.jsonScrollTop = (event.currentTarget as HTMLElement).scrollTop;
    closeOverlays();
    void ensureWindow();
  }

  // --- tree shape ---------------------------------------------------------

  async function toggle(row: JsonRow) {
    if (!row.container) return;
    try {
      tab.stats = await jsonToggle(tab.id, row.id);
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  async function expandAll() {
    try {
      tab.stats = await jsonExpandAll(tab.id);
      expandDepth = MAX_EXPAND_DEPTH;
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  async function collapseAll() {
    try {
      tab.stats = await jsonCollapseAll(tab.id);
      expandDepth = 0;
      if (viewport) viewport.scrollTop = 0;
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  /** Expand every container down to `depth`, collapse everything below. */
  async function applyDepth(depth: number) {
    expandDepth = depth;
    try {
      tab.stats = await jsonSetExpandDepth(tab.id, depth);
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  // --- hover popover ------------------------------------------------------

  /** The label the pointer is currently over, so re-entry does not restart the timer. */
  let hoverAnchor: HTMLElement | null = null;

  function onRowPointerOver(event: MouseEvent, row: JsonRow) {
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLElement>(".label") ?? null;
    if (anchor === hoverAnchor) return;

    hoverAnchor = anchor;
    clearTimeout(hoverTimer);
    hover = null;
    if (!anchor) return;

    hoverTimer = setTimeout(async () => {
      try {
        const path = await pathOf(tab.id, row.id);
        // The pointer may have moved on while the path was in flight.
        if (hoverAnchor !== anchor) return;
        const rect = anchor.getBoundingClientRect();
        // Above the key by default so it never covers the rows below, which is
        // where the eye goes next. Near the top edge there is no room, so flip.
        const above = rect.top > POPOVER_CLEARANCE;
        hover = {
          path,
          left: rect.left,
          above,
          offset: above ? window.innerHeight - rect.top + 6 : rect.bottom + 6,
          maxWidth: Math.max(120, window.innerWidth - rect.left - 12),
        };
      } catch {
        // A path we cannot resolve is not worth interrupting the reader for.
      }
    }, HOVER_DELAY_MS);
  }

  function onRowPointerLeave() {
    hoverAnchor = null;
    clearTimeout(hoverTimer);
    hover = null;
  }

  function closeOverlays() {
    hoverAnchor = null;
    clearTimeout(hoverTimer);
    hover = null;
    menu = null;
  }

  function openMenu(event: MouseEvent, row: JsonRow, rowIndex: number) {
    event.preventDefault();
    hoverAnchor = null;
    clearTimeout(hoverTimer);
    hover = null;
    selectedRow = rowIndex;
    menu = { x: event.clientX, y: event.clientY, row };
  }

  const menuItems = $derived.by((): MenuItem[] =>
    menu ? copyMenuItems(tab.id, menu.row) : [],
  );

  // --- keyboard -----------------------------------------------------------

  function moveSelection(delta: number) {
    const next = Math.min(totalRows - 1, Math.max(0, (selectedRow ?? -1) + delta));
    selectedRow = next;
    scrollRowIntoView(next);
  }

  function scrollRowIntoView(row: number) {
    if (!viewport) return;
    const top = row * rowHeight;
    const bottom = top + rowHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = bottom - viewport.clientHeight;
    }
    void ensureWindow();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.ctrlKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (selected) void copyValue(tab.id, selected);
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        break;
      case "PageDown":
        event.preventDefault();
        moveSelection(visibleCount() - 2);
        break;
      case "PageUp":
        event.preventDefault();
        moveSelection(-(visibleCount() - 2));
        break;
      case "Home":
        event.preventDefault();
        selectedRow = 0;
        scrollRowIntoView(0);
        break;
      case "End":
        event.preventDefault();
        selectedRow = totalRows - 1;
        scrollRowIntoView(totalRows - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (selected?.container && selected.collapsed) void toggle(selected);
        else moveSelection(1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (selected?.container && !selected.collapsed) void toggle(selected);
        else moveSelection(-1);
        break;
      case "Enter":
      case " ":
        if (selected?.container) {
          event.preventDefault();
          void toggle(selected);
        }
        break;
    }
  }

  // --- formatting ---------------------------------------------------------

  function summarize(row: JsonRow): string {
    if (row.kind === "array") {
      return row.childCount === 0 ? "[ ]" : `[ ${row.childCount.toLocaleString()} ]`;
    }
    return row.childCount === 0 ? "{ }" : `{ ${row.childCount.toLocaleString()} }`;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  const progressPercent = $derived(
    tab.indexing && tab.indexing.total > 0
      ? Math.min(100, Math.round((tab.indexing.done / tab.indexing.total) * 100))
      : 0,
  );
</script>

<div class="json">
  <JsonSearchBar {tab} bind:this={searchBar} />

  {#if tab.error}
    <p class="banner error" role="alert">
      <Icon name="warning" />
      {tab.error}
    </p>
  {/if}

  {#if !tab.stats && !tab.error}
    <div class="loading">
      <p>
        JSON 구조를 읽는 중… {formatBytes(tab.indexing?.done ?? 0)} / {formatBytes(tab.meta.byteLen)}
      </p>
      <div class="bar"><div class="fill" style="width: {progressPercent}%"></div></div>
    </div>
  {/if}

  {#if tab.stats}
    <div class="toolbar">
      <button class="btn btn-ghost" onclick={expandAll} title="전체 펼치기">
        <Icon name="expand" size={13} /> 전체 펼치기
      </button>
      <button class="btn btn-ghost" onclick={collapseAll} title="전체 접기">
        <Icon name="collapse" size={13} /> 전체 접기
      </button>

      <label class="depth">
        깊이
        <select
          value={shownDepth}
          onchange={(e) => applyDepth(Number(e.currentTarget.value))}
          title="이 깊이까지 펼친 상태로 되돌립니다 (최대 {MAX_EXPAND_DEPTH})"
        >
          {#each depthOptions as depth (depth)}
            <option value={depth}>{depth}</option>
          {/each}
        </select>
      </label>

      <span class="spacer"></span>
      <button
        class="btn btn-ghost"
        onclick={() => selected && copyValue(tab.id, selected)}
        disabled={!selected}
      >
        <Icon name="copy" size={13} /> 값 복사
      </button>
      <button
        class="btn btn-ghost"
        onclick={() => selected && copyPath(tab.id, selected)}
        disabled={!selected}
      >
        경로 복사
      </button>

      <!-- Last in the row and carrying its own label: an unlabelled icon in the
           middle of the toolbar gave no clue what it did or whether it was on. -->
      <button
        class="btn toggle"
        class:on={tab.showInspector}
        aria-pressed={tab.showInspector}
        title="키 / 값 표 {tab.showInspector ? '숨기기' : '보기'}"
        onclick={() => (tab.showInspector = !tab.showInspector)}
      >
        <Icon name="list" size={13} />
        키 / 값 표
        <span class="state">{tab.showInspector ? "켜짐" : "꺼짐"}</span>
      </button>
    </div>
  {/if}

  <div
    class="split"
    class:with-inspector={tab.showInspector && !!tab.stats}
    style="--inspector-width: {settings.inspectorWidth}px"
  >
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <div
    class="viewport"
    bind:this={viewport}
    onscroll={onScroll}
    onkeydown={onKeydown}
    tabindex="0"
    role="tree"
    aria-label="JSON 트리"
    style="--row-height: {rowHeight}px"
  >
    <div class="spacer-box" style="height: {totalRows * rowHeight}px">
      {#each rows as row, i (row.id)}
        {@const rowIndex = windowStart + i}
        <!-- The mouseover popover has no focus counterpart by design: keyboard
             users get the same path in the status bar, which needs no pointer. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_mouse_events_have_key_events -->
        <div
          class="row"
          class:selected={rowIndex === selectedRow}
          role="treeitem"
          aria-selected={rowIndex === selectedRow}
          aria-expanded={row.container ? !row.collapsed : undefined}
          aria-level={row.depth + 1}
          tabindex="-1"
          style="top: {rowIndex * rowHeight}px"
          onclick={() => (selectedRow = rowIndex)}
          ondblclick={() => toggle(row)}
          oncontextmenu={(e) => openMenu(e, row, rowIndex)}
          onmouseover={(e) => onRowPointerOver(e, row)}
          onmouseleave={onRowPointerLeave}
        >
          <!-- One vertical rule per ancestor level: the eye traces the line
               straight up to the parent, which is the question deep JSON
               actually raises. Colour could only say "how deep", not "whose". -->
          {#each { length: row.depth } as _, level (level)}
            <span class="guide" class:active={guideActive(rowIndex, level)}></span>
          {/each}

          {#if row.container}
            <button
              class="twisty"
              aria-label={row.collapsed ? "펼치기" : "접기"}
              onclick={(e) => {
                e.stopPropagation();
                selectedRow = rowIndex;
                void toggle(row);
              }}
            >
              <Icon name={row.collapsed ? "chevron-right" : "chevron-down"} size={12} />
            </button>
          {:else}
            <span class="twisty placeholder"></span>
          {/if}

          {#if row.key !== null}
            <span class="label key"><JsonText text={row.key} /></span><span class="punct">:</span>
          {:else if row.index !== null}
            <span class="label index">{row.index}</span><span class="punct">:</span>
          {/if}

          {#if row.container}
            <span class="summary">{summarize(row)}</span>
          {:else}
            <span class="value" data-kind={row.kind}>
              {#if row.kind === "string"}"<JsonText text={row.value ?? ""} />"{:else}<JsonText
                  text={row.value ?? ""}
                />{/if}{#if row.truncated}<span class="ellipsis" title="값이 길어 일부만 표시합니다"
                  >…</span
                >{/if}
            </span>
          {/if}
        </div>
      {/each}
    </div>
  </div>

    {#if tab.showInspector && tab.stats}
      <Splitter
        bind:value={settings.inspectorWidth}
        measure={(event, parent) => parent.right - event.clientX}
        bounds={(parent) => ({ min: 200, max: Math.max(200, parent.width - 280) })}
        step={16}
        keyDirection={-1}
        reset={320}
        label="키 / 값 표 너비"
        onCommit={() => settings.save()}
      />
      <JsonInspector {tab} onClose={() => (tab.showInspector = false)} />
    {/if}
  </div>

  {#if tab.stats}
    <footer class="status">
      <span>{tab.stats.nodeCount.toLocaleString()}개 노드</span>
      <span>깊이 {tab.stats.maxDepth}</span>
      <span>{formatBytes(tab.stats.byteLen)}</span>
      <span title="색인이 차지하는 메모리">색인 {formatBytes(tab.stats.indexBytes)}</span>
      {#if tab.stats.filtered}<span class="tag">검색 결과만 표시 중</span>{/if}
      {#if tab.stats.syntheticRoot}<span class="tag">여러 문서를 배열로 묶어 표시</span>{/if}
      <span class="path" title={selectedPath}><bdi>{selectedPath}</bdi></span>
      <span>{totalRows.toLocaleString()}행</span>
    </footer>
  {/if}
</div>

{#if hover}
  <div
    class="path-popover"
    style="left: {hover.left}px; {hover.above ? 'bottom' : 'top'}: {hover.offset}px; max-width: {hover.maxWidth}px"
    role="tooltip"
  >
    {hover.path}
  </div>
{/if}

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => (menu = null)} />
{/if}

<style>
  .json {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--danger);
  }

  .loading {
    padding: 1.5rem;
    color: var(--text-secondary);
  }

  .loading p {
    margin: 0 0 0.6rem;
    font-variant-numeric: tabular-nums;
  }

  .bar {
    height: 4px;
    max-width: 22rem;
    border-radius: 999px;
    background: var(--bg-inset);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease-out;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .toolbar .btn {
    padding: 0.2rem 0.45rem;
    font-size: 0.92em;
    color: var(--text-secondary);
  }

  .spacer {
    flex: 1;
  }

  /* Filled when on, outlined when off — a tinted icon button was too quiet to
     read as a state at a glance. */
  .toggle {
    gap: 0.4rem;
    padding: 0.2rem 0.5rem;
    font-size: 0.92em;
  }

  .toggle.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }

  .toggle .state {
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .toggle.on .state {
    background: color-mix(in srgb, var(--accent-fg) 22%, transparent);
    color: var(--accent-fg);
  }

  .depth {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    margin-left: 0.4rem;
    color: var(--text-secondary);
    font-size: 0.92em;
  }

  .depth select {
    padding: 0.1rem 0.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    /* `inherit`, not another em — the label already shrank it once. */
    font-size: inherit;
  }

  .split {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }

  .split.with-inspector {
    grid-template-columns: minmax(0, 1fr) 1px var(--inspector-width);
  }

  .viewport {
    min-height: 0;
    overflow: auto;
    outline: none;
    font-family: var(--font-code);
    font-size: var(--doc-font-size);
  }

  .viewport:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .spacer-box {
    position: relative;
  }

  .row {
    position: absolute;
    left: 0;
    display: flex;
    align-items: center;
    gap: 0.3ch;
    /* Sized to its content rather than stretched to the viewport, so a long
       value makes the tree scroll sideways instead of being cut off. The
       minimum keeps short rows full-width for hover and selection. */
    width: max-content;
    min-width: 100%;
    height: var(--row-height);
    padding: 0 2rem 0 0.35rem;
    white-space: pre;
    cursor: default;
  }

  .row:hover {
    background: var(--bg-hover);
  }

  .row.selected {
    background: var(--accent-subtle);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .guide {
    flex: none;
    align-self: stretch;
    width: 1.1em;
    /* Cancel the row's flex gap so the guides tile into an unbroken ladder. */
    margin-right: -0.3ch;
    border-left: 1px solid var(--guide-color, var(--guide-1));
  }

  /* Guides are always the leading children of a row, so nth-child indexes the
     nesting level directly, and the cycle repeats past nine levels. Each rule
     sets a variable rather than the colour itself, so the emphasis below can
     build on the level's own hue instead of replacing it. */
  .guide:nth-child(9n + 1) { --guide-color: var(--guide-1); }
  .guide:nth-child(9n + 2) { --guide-color: var(--guide-2); }
  .guide:nth-child(9n + 3) { --guide-color: var(--guide-3); }
  .guide:nth-child(9n + 4) { --guide-color: var(--guide-4); }
  .guide:nth-child(9n + 5) { --guide-color: var(--guide-5); }
  .guide:nth-child(9n + 6) { --guide-color: var(--guide-6); }
  .guide:nth-child(9n + 7) { --guide-color: var(--guide-7); }
  .guide:nth-child(9n + 8) { --guide-color: var(--guide-8); }
  .guide:nth-child(9n + 9) { --guide-color: var(--guide-9); }

  /* Emphasis keeps the level's own hue and pushes it toward the text colour,
     which darkens it on a light theme and lightens it on a dark one. A uniform
     accent would erase the very cue the reader is following. box-sizing:
     border-box means the extra pixel costs no layout shift. */
  .guide.active {
    border-left: 2px solid color-mix(in oklab, var(--guide-color) 78%, var(--text));
  }

  .twisty {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1em;
    height: 1.1em;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
  }

  .twisty:hover {
    background: var(--bg-active);
    color: var(--text);
  }

  .twisty.placeholder {
    pointer-events: none;
  }

  .label:hover {
    text-decoration: underline dotted;
    text-underline-offset: 0.2em;
  }

  .key {
    color: var(--json-key);
  }

  .index {
    color: var(--text-muted);
  }

  .punct {
    color: var(--json-punct);
    margin-right: 0.4ch;
  }

  .summary {
    color: var(--json-punct);
  }

  .value {
    /* Deliberately not clipped: the viewport scrolls to reveal the rest. */
    flex: none;
  }

  .value[data-kind="string"] { color: var(--json-string); }
  .value[data-kind="number"] { color: var(--json-number); }
  .value[data-kind="bool"] { color: var(--json-bool); }
  .value[data-kind="null"] { color: var(--json-null); font-style: italic; }

  .ellipsis {
    color: var(--text-muted);
  }

  .path-popover {
    position: fixed;
    z-index: 25;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--popover-border);
    border-radius: var(--radius);
    background: var(--popover-bg);
    color: var(--popover-fg);
    box-shadow: var(--shadow-lg);
    font-family: var(--font-code);
    font-size: 0.92em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* Informational only — never steals the hover it is describing. */
    pointer-events: none;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.25rem 0.75rem;
    border-top: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .status .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
    font-family: var(--font-code);
    color: var(--text-secondary);
  }

  .status .tag {
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
    color: var(--accent);
  }
</style>
