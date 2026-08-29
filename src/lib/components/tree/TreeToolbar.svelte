<script lang="ts">
  /**
   * Shape controls for the tree: how much of it is open, and what to do with
   * the selected node.
   *
   * It owns the depth control because that is the only state here — the rest
   * are actions the view hands down. `expandDepth` lives with the control that
   * sets it rather than in the view, which never reads it.
   */
  import Icon from "../Icon.svelte";
  import { t } from "../../i18n";
  import { errorMessage, treeCollapseAll, treeExpandAll, treeSetExpandDepth } from "../../ipc";
  import type { TreeRow } from "../../ipc";
  import { copyPath, copyValue } from "./actions";
  import type { DocTab } from "../../state/docs.svelte";

  interface Props {
    tab: DocTab;
    /** The row the copy buttons act on, or null when nothing is selected. */
    selected: TreeRow | null;
    /** Called after collapsing everything, so the view can return to the top. */
    onCollapsed: () => void;
  }

  let { tab, selected, onCollapsed }: Props = $props();

  /** Matches MAX_EXPAND_DEPTH in src-tauri/src/tree/index.rs. */
  const MAX_EXPAND_DEPTH = 9;

  let expandDepth = $state(MAX_EXPAND_DEPTH);

  const depthOptions = $derived(
    Array.from(
      { length: Math.min(tab.treeStats?.maxDepth ?? 0, MAX_EXPAND_DEPTH) + 1 },
      (_, i) => i,
    ),
  );

  /**
   * The default of 9 means "as deep as it goes". A document shallower than that
   * has no option to match it, so show the depth that is actually in effect —
   * otherwise the control renders blank.
   */
  const shownDepth = $derived(Math.min(expandDepth, tab.treeStats?.maxDepth ?? expandDepth));

  async function expandAll() {
    try {
      tab.treeStats = await treeExpandAll(tab.id);
      expandDepth = MAX_EXPAND_DEPTH;
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  async function collapseAll() {
    try {
      tab.treeStats = await treeCollapseAll(tab.id);
      expandDepth = 0;
      onCollapsed();
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }

  /** Expand every container down to `depth`, collapse everything below. */
  async function applyDepth(depth: number) {
    expandDepth = depth;
    try {
      tab.treeStats = await treeSetExpandDepth(tab.id, depth);
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }
</script>

<div class="toolbar">
  <button class="btn btn-ghost" onclick={expandAll} title={t("tree.expandAll")}>
    <Icon name="expand" size={13} />
    {t("tree.expandAll")}
  </button>
  <button class="btn btn-ghost" onclick={collapseAll} title={t("tree.collapseAll")}>
    <Icon name="collapse" size={13} />
    {t("tree.collapseAll")}
  </button>

  <label class="depth">
    {t("tree.depth")}
    <select
      value={shownDepth}
      onchange={(e) => applyDepth(Number(e.currentTarget.value))}
      title={t("tree.depth.title", { max: MAX_EXPAND_DEPTH })}
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
    <Icon name="copy" size={13} />
    {t("tree.copyValue")}
  </button>
  <button
    class="btn btn-ghost"
    onclick={() => selected && copyPath(tab.id, selected)}
    disabled={!selected}
  >
    {t("tree.copyPath")}
  </button>

  <!-- Last in the row and carrying its own label: an unlabelled icon in the
       middle of the toolbar gave no clue what it did or whether it was on. -->
  <button
    class="btn toggle"
    class:on={tab.showInspector}
    aria-pressed={tab.showInspector}
    title={t("tree.inspector.toggle", {
      action: tab.showInspector ? t("state.hide") : t("state.show"),
    })}
    onclick={() => (tab.showInspector = !tab.showInspector)}
  >
    <Icon name="list" size={13} />
    {t("tree.inspector")}
    <span class="state">{tab.showInspector ? t("state.on") : t("state.off")}</span>
  </button>
</div>

<style>
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
</style>
