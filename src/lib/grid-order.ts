import type { GridSort } from "./ipc";

/** A different column always starts ascending; a third click restores source order. */
export function nextSort(current: GridSort | null, column: number): GridSort | null {
  if (current?.column !== column) return { column, descending: false };
  return current.descending ? null : { column, descending: true };
}
