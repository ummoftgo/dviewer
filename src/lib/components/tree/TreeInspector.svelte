<script lang="ts">
  /**
   * The key/value table, docked beside the tree.
   *
   * All it adds to `KeyValueTable` is the tab: which node to show (whatever the
   * tree has selected) and what "follow this container" means here — move the
   * tree's selection, so the two panels stay in step. Stepping back moves the
   * tree too, for the same reason.
   *
   * The same table can also be detached into a window of its own, which is why
   * it is a separate component. See `PanelApp.svelte`.
   */
  import Icon from "../Icon.svelte";
  import KeyValueTable from "./KeyValueTable.svelte";
  import { t } from "../../i18n";
  import { errorMessage, openPanel, type TreeRow } from "../../ipc";
  import { goBack, goForward, goToNode } from "./navigate";
  import type { DocTab } from "../../state/docs.svelte";

  interface Props {
    tab: DocTab;
    onClose: () => void;
  }

  let { tab, onClose }: Props = $props();

  /** Follow a nested container: same effect as clicking it in the tree. */
  function drillInto(row: TreeRow) {
    void goToNode(tab, row.id);
  }

  async function detach() {
    if (tab.selectedNode === null) return;
    try {
      await openPanel(tab.id, tab.selectedNode);
    } catch (err) {
      tab.error = errorMessage(err);
    }
  }
</script>

<KeyValueTable
  docId={tab.id}
  nodeId={tab.selectedNode}
  selected={tab.selectedNode}
  onDrill={drillInto}
  onBack={() => goBack(tab)}
  onForward={() => goForward(tab)}
  canBack={tab.history.canBack}
  canForward={tab.history.canForward}
>
  {#snippet actions()}
    <button
      class="icon-btn"
      onclick={detach}
      disabled={tab.selectedNode === null}
      aria-label={t("inspector.detach")}
      title={t("inspector.detach")}
    >
      <Icon name="external" />
    </button>
    <button
      class="icon-btn"
      onclick={onClose}
      aria-label={t("inspector.close")}
      title={t("inspector.close")}
    >
      <Icon name="close" />
    </button>
  {/snippet}
</KeyValueTable>
