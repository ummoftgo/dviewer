/**
 * Moving the tree's selection to a node the reader did not click on: following
 * a container from the key/value table, or stepping through the history.
 *
 * It lives apart from the components because three of them do the same thing,
 * and "the same" has to mean the same code.
 */
import { errorMessage, treeReveal } from "../../ipc";
import type { DocTab } from "../../state/docs.svelte";

/**
 * Select `nodeId`, expanding its ancestors and scrolling it into view.
 *
 * The selection is what the docked table reads, so this is also how the table
 * changes what it is showing.
 */
export async function goToNode(tab: DocTab, nodeId: number) {
  // Selected before the round trip, not after: the table then follows at once,
  // and — since the history is written from the selection — two quick presses
  // of the back button cannot interleave into a step that never happened.
  tab.selectedNode = nodeId;
  try {
    const result = await treeReveal(tab.id, nodeId);
    tab.treeStats = result.stats;
    if (result.row !== null) tab.pendingRow = result.row;
  } catch (err) {
    tab.error = errorMessage(err);
  }
}

export function goBack(tab: DocTab) {
  const node = tab.history.back();
  if (node !== null) void goToNode(tab, node);
}

export function goForward(tab: DocTab) {
  const node = tab.history.forward();
  if (node !== null) void goToNode(tab, node);
}

/**
 * Which way a mouse's side buttons point, if the event came from one.
 *
 * Buttons 3 and 4 are back and forward on every mouse that has them, and the
 * webview would otherwise spend them on page navigation this app has no use
 * for — so callers should also cancel the default.
 */
export function sideButton(event: MouseEvent): "back" | "forward" | null {
  if (event.button === 3) return "back";
  if (event.button === 4) return "forward";
  return null;
}
