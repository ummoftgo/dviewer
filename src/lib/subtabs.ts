import type { DocSource, TreeRow } from "./ipc";

interface Tab {
  id: number;
  meta: { source: DocSource };
}

export function family<T extends Tab>(tabs: readonly T[], activeId: number | null) {
  const active = tabs.find((tab) => tab.id === activeId);
  if (!active) return null;
  const source = active.meta.source;
  const parent = (source.type === "treeSlice" && tabs.find((tab) => tab.id === source.parent)) || active;
  const children = tabs.filter((tab) => tab.meta.source.type === "treeSlice" && tab.meta.source.parent === parent.id);
  return { parent, children };
}

export function mainTabs<T extends Tab>(tabs: readonly T[]): T[] {
  const ids = new Set(tabs.map((tab) => tab.id));
  return tabs.filter((tab) => tab.meta.source.type !== "treeSlice" || !ids.has(tab.meta.source.parent));
}

function cycle(tabs: readonly Tab[], activeId: number | null, step: number): number | null {
  if (!tabs.length) return null;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  return tabs[(index + step + tabs.length) % tabs.length].id;
}

export function nextMainTab(tabs: readonly Tab[], activeId: number | null, step: number) {
  return cycle(mainTabs(tabs), family(tabs, activeId)?.parent.id ?? activeId, step);
}

export function nextSubtab(tabs: readonly Tab[], activeId: number | null, step: number) {
  const group = family(tabs, activeId);
  return group ? cycle([group.parent, ...group.children], activeId, step) : null;
}

export function subtabLabel(row: Pick<TreeRow, "key" | "index" | "kind">): string {
  return `${row.key ?? (row.index === null ? "$" : `[${row.index}]`)}${row.kind === "array" ? "[]" : "{}"}`;
}
