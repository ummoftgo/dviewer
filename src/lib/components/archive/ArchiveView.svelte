<script lang="ts">
  /**
   * What an archive holds, as a list to pick from.
   *
   * The one view that is not a way of looking at this document — it is a way of
   * reaching another. So there is no grid, no index and no search over content
   * here: the rows are the archive's own table of contents, read from the
   * central directory and nothing else.
   *
   * The list is virtualised through the same geometry the tree and the grid
   * use. A zip with a hundred thousand entries is unusual but not rare — a
   * dependency cache or a build output reaches that — and a plain list of them
   * would build a hundred thousand DOM nodes to show forty.
   */
  import Icon from "../Icon.svelte";
  import { formatBytes } from "../../format";
  import { archiveEntries, errorMessage, kindBadge, kindLabel } from "../../ipc";
  import { n, t } from "../../i18n";
  import { anchorRow, rowTop, spacerHeight, type ScrollMetrics } from "../../virtual";
  import type { DocTab } from "../../state/docs.svelte";

  interface Props {
    tab: DocTab;
  }

  let { tab }: Props = $props();

  /** Matches the row height in the stylesheet below. */
  const ROW_HEIGHT = 26;
  /** Drawn above and below the viewport so a fast scroll does not show gaps. */
  const OVERSCAN = 8;

  let viewport = $state<HTMLDivElement>();
  let viewportHeight = $state(0);
  let loading = $state(false);

  const metrics = $derived<ScrollMetrics>({
    rowHeight: ROW_HEIGHT,
    totalRows: tab.entries.length,
    viewportHeight,
  });

  const first = $derived(Math.max(0, Math.floor(anchorRow(metrics, tab.archiveScrollTop)) - OVERSCAN));
  const last = $derived(
    Math.min(
      tab.entries.length,
      first + Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2,
    ),
  );
  const visible = $derived(tab.entries.slice(first, last));

  $effect(() => {
    if (tab.entries.length > 0 || loading) return;
    loading = true;
    archiveEntries(tab.id)
      .then((listing) => {
        tab.entries = listing.entries;
        tab.nameEncoding = listing.nameEncoding;
        tab.namesGuessed = listing.namesGuessed;
        tab.hiddenEntries = listing.hidden;
        tab.error = null;
      })
      // The archive tab is where this failure belongs. `workspace.notice` is
      // only ever drawn by the start pane, so a message sent there from a tab
      // that is on screen would go nowhere.
      .catch((err) => (tab.error = errorMessage(err)))
      .finally(() => (loading = false));
  });

  function onScroll() {
    if (viewport) tab.archiveScrollTop = viewport.scrollTop;
  }
</script>

<div class="archive">
  {#if tab.error}
    <p class="banner error" role="alert">
      <Icon name="warning" />
      {tab.error}
    </p>
  {/if}

  {#if tab.entries.length === 0 && !loading}
    <p class="empty">{t("archive.empty")}</p>
  {:else}
    <div
      class="viewport"
      role="list"
      aria-label={t("archive.label", { title: tab.meta.title })}
      bind:this={viewport}
      bind:clientHeight={viewportHeight}
      onscroll={onScroll}
    >
      <div class="spacer" style:height="{spacerHeight(metrics)}px">
        {#each visible as entry, offset (entry.index)}
          <div
            class="row"
            role="listitem"
            style:top="{rowTop(metrics, tab.archiveScrollTop, first + offset)}px"
          >
            <span class="badge" title={kindLabel(entry.kind)}>{kindBadge(entry.kind)}</span>
            <span class="name">{entry.name}</span>
            {#if entry.encrypted}
              <span class="locked" title={t("archive.locked")}>🔒</span>
            {/if}
            <span class="size">{formatBytes(entry.size)}</span>
          </div>
        {/each}
      </div>
    </div>

    <div class="status">
      <span>{t("archive.status.entries", { count: n(tab.entries.length) })}</span>
      {#if tab.hiddenEntries > 0}
        <span class="warn">{t("archive.status.hidden", { count: n(tab.hiddenEntries) })}</span>
      {/if}
      {#if tab.nameEncoding}
        <span class="spacer-fill"></span>
        <span class:warn={tab.namesGuessed}>
          {t(tab.namesGuessed ? "archive.status.namesGuessed" : "archive.status.names", {
            encoding: tab.nameEncoding,
          })}
        </span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .archive {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .viewport {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .spacer {
    position: relative;
  }

  .row {
    position: absolute;
    left: 0;
    right: 0;
    /* Same 26px `ROW_HEIGHT` the geometry above is computed from. */
    height: 26px;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.7rem;
    font-size: 0.9em;
    white-space: nowrap;
  }

  .row:hover {
    background: var(--bg-hover);
  }

  .badge {
    flex: none;
    min-width: 2.4rem;
    text-align: center;
    font-family: var(--font-code);
    font-size: 0.85em;
    color: var(--text-muted);
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .locked {
    flex: none;
  }

  .size {
    flex: none;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  .empty {
    margin: auto;
    color: var(--text-muted);
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    padding: 0.4rem 0.8rem;
    font-size: 0.9em;
  }

  .banner.error {
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--danger);
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    padding: 0.25rem 0.7rem;
    border-top: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .status .warn {
    color: var(--warning);
  }

  .spacer-fill {
    flex: 1;
  }
</style>
