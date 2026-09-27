<script lang="ts">
  /**
   * The grid, and the cell detail panel beside it when it is open.
   *
   * Laid out the way the tree docks its key/value table, and the width is the
   * same setting: one side panel, one width, whichever view it is beside.
   */
  import type { Snippet } from "svelte";
  import Splitter from "../Splitter.svelte";
  import CellDetail from "./CellDetail.svelte";
  import { t } from "../../i18n";
  import { settings } from "../../state/settings.svelte";
  import type { DocTab } from "../../state/docs.svelte";

  interface Props {
    tab: DocTab;
    columnName: (column: number) => string;
    firstRowNumber?: 0 | 1;
    children: Snippet;
  }

  let { tab, columnName, firstRowNumber = 1, children }: Props = $props();
</script>

<div class="dock" class:open={tab.showCellDetail} style="--inspector-width: {settings.inspectorWidth}px">
  {@render children()}
  {#if tab.showCellDetail}
    <Splitter
      class="dock-splitter"
      bind:value={settings.inspectorWidth}
      measure={(event, parent) => parent.right - event.clientX}
      bounds={(parent) => ({ min: 200, max: Math.max(200, parent.width - 280) })}
      step={16}
      keyDirection={-1}
      reset={320}
      label={t("cellDetail.width")}
      onCommit={() => settings.save()}
    />
    <CellDetail {tab} {columnName} {firstRowNumber} onClose={() => (tab.showCellDetail = false)} />
  {/if}
</div>

<style>
  .dock {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }

  .dock.open {
    grid-template-columns: minmax(0, 1fr) 1px var(--inspector-width);
  }

  /* Placed rather than flowed: a filter that matches nothing hides the grid,
     and the panel must not slide into the column it leaves. */
  .dock :global(.dock-splitter) {
    grid-column: 2;
  }

  .dock :global(.cell-detail) {
    grid-column: 3;
  }
</style>
