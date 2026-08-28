/**
 * Copy actions for a JSON node, shared by the tree and the key/value table.
 *
 * Both surfaces offer the same context menu, and "the same" has to mean the
 * same code — otherwise the two drift and one of them quietly copies the wrong
 * thing.
 */
import { errorMessage, treeNodeText, treePath, type TreeRow } from "../../ipc";
import { copyText } from "../../clipboard";
import { toasts } from "../../state/toast.svelte";
import type { MenuItem } from "../menu";

/** Paths never change for a given node, so each one is fetched once. */
const paths = new Map<string, string>();

export async function pathOf(docId: number, nodeId: number): Promise<string> {
  const key = `${docId}:${nodeId}`;
  const cached = paths.get(key);
  if (cached !== undefined) return cached;
  const path = await treePath(docId, nodeId);
  paths.set(key, path);
  return path;
}

/** Drop a closed document's paths rather than hold them for the session. */
export function forgetDoc(docId: number) {
  const prefix = `${docId}:`;
  for (const key of [...paths.keys()]) {
    if (key.startsWith(prefix)) paths.delete(key);
  }
}

export async function copyPath(docId: number, row: TreeRow) {
  try {
    await copyText(await pathOf(docId, row.id));
    toasts.show("경로를 복사했습니다.");
  } catch (err) {
    toasts.show(errorMessage(err), "error");
  }
}

export async function copyKey(row: TreeRow) {
  if (row.key === null) return;
  try {
    await copyText(row.key);
    toasts.show("키를 복사했습니다.");
  } catch (err) {
    toasts.show(errorMessage(err), "error");
  }
}

export async function copyValue(docId: number, row: TreeRow) {
  try {
    const node = await treeNodeText(docId, row.id);
    await copyText(node.text);
    toasts.show(node.truncated ? "값이 너무 커서 앞부분만 복사했습니다." : "값을 복사했습니다.");
  } catch (err) {
    toasts.show(errorMessage(err), "error");
  }
}

export function copyMenuItems(docId: number, row: TreeRow): MenuItem[] {
  return [
    { label: "경로 복사", action: () => void copyPath(docId, row) },
    // Array elements have an index, not a key, so there is nothing to copy.
    { label: "키 복사", action: () => void copyKey(row), disabled: row.key === null },
    { label: "값 복사", action: () => void copyValue(docId, row), hint: "Ctrl C" },
  ];
}
