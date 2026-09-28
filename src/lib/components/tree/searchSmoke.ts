/**
 * Enter in the tree's search box, typed the way a reader types it.
 *
 * Two defects shipped here. Enter started a search but did not go to its first
 * hit — a second Enter did — and once there were hits, Enter stepped through
 * them without looking at the box, so an edited query walked the old one's
 * matches. Both live between the component, the event stream and the view's
 * row, which is why this drives the real input rather than the state.
 *
 * It waits on what the reader would see — the search finished and the selected
 * row holds the match — never on a number of frames, and it reads nothing from
 * the settings store, so a saved scope or case choice cannot decide the result.
 */
import type { DocTab } from "../../state/docs.svelte";

const DEADLINE_MS = 60_000;
const POLL_MS = 16;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkTreeSearchEnter(tab: DocTab) {
  const root = document.querySelector<HTMLElement>("div.json");
  const input = root?.querySelector<HTMLInputElement>("form.search input[type=search]");
  if (!root || !input) throw new Error("tree search box not found");
  // Conditions a leftover run or a stored default could have changed.
  tab.search.caseSensitive = false;
  tab.search.how = "literal";
  tab.search.scope = "all";

  const selected = () =>
    root.querySelector('[role="tree"] [role="treeitem"][aria-selected="true"]')?.textContent ?? "";
  const enter = async (query: string, total: number) => {
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const before = tab.search.seq;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const deadline = Date.now() + DEADLINE_MS;
    const done = () =>
      tab.search.seq !== before &&
      !tab.search.running &&
      tab.search.summary !== null &&
      tab.search.current === 0 &&
      tab.pendingRow === null &&
      selected().toLowerCase().includes(query.toLowerCase());
    while (!done()) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Enter on "${query}": seq ${tab.search.seq === before ? "unchanged" : "new"}, ` +
            `hits ${tab.search.hits.length}, current ${tab.search.current}, selected "${selected().trim().slice(0, 60)}"`,
        );
      }
      await sleep(POLL_MS);
    }
    if (tab.search.summary!.total !== total) {
      throw new Error(`Enter on "${query}" found ${tab.search.summary!.total}, expected ${total}`);
    }
  };

  try {
    // One match, then three: the counts differ so the second answer cannot be
    // the first one's hits stepped through.
    await enter("Alpha", 1);
    await enter("keep", 3);
    return { alpha: 1, keep: tab.search.summary!.total };
  } finally {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  }
}
