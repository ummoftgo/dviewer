import { expect, test } from "vitest";
import type { DocSource } from "./ipc";
import { family, mainTabs, nextMainTab, nextSubtab, subtabLabel } from "./subtabs";

const root = (id: number) => ({ id, meta: { source: { type: "text" } as DocSource } });
const child = (id: number, parent: number) => ({ id, meta: { source: {
  type: "treeSlice", parent, generation: 0, node: id, path: "$.items",
} as DocSource } });
const tabs = [root(1), child(2, 1), root(3), child(4, 1), child(5, 99), child(-1, 3)];

test("parent and active child share one family in opening order", () => {
  expect(family(tabs, 2)).toEqual({ parent: tabs[0], children: [tabs[1], tabs[3]] });
  expect(family(tabs, 1)).toEqual(family(tabs, 4));
  expect(family(tabs, null)).toBeNull();
});

test("main tabs retain orphans and hide opening children only with a parent", () => {
  expect(mainTabs(tabs).map((tab) => tab.id)).toEqual([1, 3, 5]);
  expect(family(tabs, 5)).toEqual({ parent: tabs[4], children: [] });
  expect(family(tabs, -1)?.parent.id).toBe(3);
});

test("main cycling starts from the active child's parent", () => {
  expect(nextMainTab(tabs, 2, 1)).toBe(3);
  expect(nextMainTab(tabs, 4, -1)).toBe(5);
  expect(nextMainTab(tabs, 5, 1)).toBe(1);
  expect(nextMainTab([], null, 1)).toBeNull();
});

test("subtab cycling wraps both ways and a single tab stays put", () => {
  expect(nextSubtab(tabs, 1, 1)).toBe(2);
  expect(nextSubtab(tabs, 1, -1)).toBe(4);
  expect(nextSubtab(tabs, 4, 1)).toBe(1);
  expect(nextSubtab(tabs, 2, -1)).toBe(1);
  expect(nextSubtab(tabs, 5, 1)).toBe(5);
  expect(nextSubtab([], null, -1)).toBeNull();
});

test("labels use node identity and kind, never parse a displayed path", () => {
  expect(subtabLabel({ key: "items", index: null, kind: "array" })).toBe("items[]");
  expect(subtabLabel({ key: "settings", index: null, kind: "object" })).toBe("settings{}");
  expect(subtabLabel({ key: 'a.b[3]."c"', index: null, kind: "array" })).toBe('a.b[3]."c"[]');
  expect(subtabLabel({ key: "", index: null, kind: "object" })).toBe("{}");
  expect(subtabLabel({ key: null, index: 3, kind: "array" })).toBe("[3][]");
  expect(subtabLabel({ key: null, index: null, kind: "object" })).toBe("${}");
});
