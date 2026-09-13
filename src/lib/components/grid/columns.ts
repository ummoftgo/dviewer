/**
 * Column widths for the grid: guessing them, and letting the reader fix the
 * guess.
 *
 * Separate from the view because none of it touches the viewport — it reads a
 * page of cells and writes `tab.columnWidths`, which is where the grid gets
 * its layout from.
 */
import type { TableRow } from "../../ipc";
import type { DocTab } from "../../state/docs.svelte";
import { fillWidths, resizeWidths, widthRatios, type TableMode } from "../markdown/tables";

/** A new collection must not inherit the previous collection's drag ratios. */
export function resetColumns(tab: Pick<DocTab, "columnWidths" | "tableFillRatios">): void {
  tab.columnWidths = [];
  tab.tableFillRatios = null;
}

type ColumnView = Pick<DocTab, 'columnOrder' | 'hiddenColumns'>;
export function visibleColumns(tab: ColumnView, count: number): number[] {
  const hidden = new Set(tab.hiddenColumns);
  const order = tab.columnOrder.length === count ? tab.columnOrder : Array.from({ length: count }, (_, i) => i);
  return order.filter(column => !hidden.has(column));
}

export function hideColumn(tab: DocTab, column: number, count: number): boolean {
  const visible = visibleColumns(tab, count);
  if (visible.length <= 1 || !visible.includes(column)) return false;
  tab.hiddenColumns = [...tab.hiddenColumns, column];
  tab.tableFillRatios = null;
  tab.revealedColumn = null;
  if (tab.selectedCell?.column === column) tab.selectedCell = null;
  if (tab.pendingCell?.column === column) tab.pendingCell = null;
  return true;
}

export function revealColumn(tab: DocTab, column: number, searched = false): void {
  if (!tab.hiddenColumns.includes(column)) return;
  tab.hiddenColumns = tab.hiddenColumns.filter(hidden => hidden !== column);
  tab.tableFillRatios = null;
  tab.revealedColumn = searched ? column : null;
}

export function moveColumn(tab: DocTab, column: number, delta: -1 | 1, count: number): void {
  const visible = visibleColumns(tab, count);
  const at = visible.indexOf(column);
  const neighbor = visible[at + delta];
  if (at < 0 || neighbor === undefined) return;
  const order = tab.columnOrder.length === count ? [...tab.columnOrder] : Array.from({ length: count }, (_, i) => i);
  const left = order.indexOf(column), right = order.indexOf(neighbor);
  [order[left], order[right]] = [order[right], order[left]];
  tab.columnOrder = order;
  tab.revealedColumn = null;
}

/** Widths/ratios stay indexed by source column even when the display is projected. */
export function projectLayout(tab: DocTab, columns: readonly number[], viewport: number, gutter: number, mode: TableMode): ColumnLayout {
  return { ...layoutColumns(columns.map(column => columnWidth(tab, column)),
    tab.tableFillRatios && columns.map(column => tab.tableFillRatios![column] ?? columnWidth(tab, column)), viewport, gutter, mode), columns };
}

function storeWidths(tab: DocTab, values: readonly number[], columns?: readonly number[], ratios = false) {
  if (!columns) {
    if (ratios) tab.tableFillRatios = [...values];
    else tab.columnWidths = [...values];
    return;
  }
  const next = [...(ratios ? tab.tableFillRatios ?? tab.columnWidths : tab.columnWidths)];
  values.forEach((value, at) => { next[columns?.[at] ?? at] = value; });
  if (ratios) tab.tableFillRatios = next;
  else tab.columnWidths = next;
}

export const MIN_COLUMN = 64;
export const MAX_AUTO_COLUMN = 420;
export const MAX_FIT_COLUMN = 8000;
export const automaticColumnLimit = (mode?: TableMode): number => mode === "scroll" ? MAX_FIT_COLUMN : MAX_AUTO_COLUMN;
/** Used until a page has arrived and the real widths can be measured. */
const FALLBACK_COLUMN = 140;

/** Hangul and CJK occupy two columns in a monospaced face; Latin one. */
/**
 * Whether a character occupies two columns in a monospaced font.
 *
 * The ranges are the East Asian Wide and Fullwidth blocks. Treating everything
 * past Hangul Jamo as wide was close enough for CJK and wrong for the things
 * that sit between: arrows, dashes, bullets and maths signs are one column
 * each, and a table of them came out with columns twice the width they needed.
 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, CJK punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, Hangul compatibility, CJK marks
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions B and beyond
  );
}

export function visualLength(text: string): number {
  let total = 0;
  for (const ch of text) total += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return total;
}

/**
 * A first guess at each column's width, from the header and one page of rows.
 *
 * Measuring every row would mean reading the whole file, which is the one thing
 * the grid exists to avoid. A page gets the common case right, and anything it
 * misses the reader can drag.
 */
export function measureColumns(
  tab: DocTab,
  sample: TableRow[],
  columnCount: number,
  fontPx: number,
  columnName: (column: number) => string,
  maximum = MAX_AUTO_COLUMN,
  columns = Array.from({ length: columnCount }, (_, column) => column),
): void {
  tab.tableFillRatios = null;
  const widths = Array.from({ length: columnCount }, (_, column) => columnWidth(tab, column));
  for (const column of columns) widths[column] = measuredWidth(sample, column, fontPx, columnName(column), maximum);
  tab.columnWidths = widths;
}

function measuredWidth(sample: TableRow[], column: number, fontPx: number, name: string, maximum: number): number {
  const char = Math.max(6, fontPx * 0.62);
  let widest = visualLength(name);
  for (const row of sample) widest = Math.max(widest, visualLength(row.cells[column]?.text ?? ""));
  return Math.round(Math.min(maximum, Math.max(MIN_COLUMN, widest * char + 26)));
}

export function fitColumn(tab: DocTab, sample: TableRow[], column: number, fontPx: number, name: string, maximum = MAX_AUTO_COLUMN, layout?: ColumnLayout): void {
  const at = layout?.columns ? layout.columns.indexOf(column) : column;
  if (at < 0) return;
  const content = measuredWidth(sample, column, fontPx, name, maximum);
  if (layout?.mode === 'fill' && content <= layout.widths.reduce((sum, width) => sum + width, 0)) {
    resizeColumn(tab, layout.widths, at, content - layout.widths[at], 'fill', layout.columns);
  } else {
    if (layout) storeWidths(tab, layout.widths, layout.columns);
    tab.tableFillRatios = null;
    tab.columnWidths[column] = content;
  }
}

export function columnWidth(tab: Pick<DocTab, 'columnWidths'>, column: number): number {
  return tab.columnWidths[column] ?? FALLBACK_COLUMN;
}

/** Total width of the columns plus the row-number gutter. */
export function totalWidth(tab: Pick<DocTab, 'columnWidths'>, numberWidth: number): number {
  return numberWidth + tab.columnWidths.reduce((sum, width) => sum + width, 0);
}

/** Left edge of a column, in the same coordinates as `scrollLeft`. */
export function columnLeft(tab: Pick<DocTab, 'columnWidths'>, column: number, numberWidth: number): number {
  let left = numberWidth;
  for (let i = 0; i < column; i++) left += columnWidth(tab, i);
  return left;
}

/**
 * Drag a column edge.
 *
 * Listeners go on the handle rather than the window because the pointer is
 * captured to it: the drag then survives the pointer leaving the element, and
 * there is nothing to clean up if the component disappears mid-drag.
 */
export function startResize(event: PointerEvent, tab: DocTab, column: number, layout?: ColumnLayout): void {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLElement;
  const startX = event.clientX;
  const widths = [...(layout?.widths ?? tab.columnWidths)];
  const mode = layout?.mode ?? "scroll";
  const at = layout?.columns ? layout.columns.indexOf(column) : column;

  const move = (moved: PointerEvent) => {
    resizeColumn(tab, widths, at, Math.round(moved.clientX - startX), mode, layout?.columns);
  };
  const stop = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
  };
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // Capture is an optimisation; dragging still works without it.
  }
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}

export interface ColumnLayout { widths: number[]; mode: TableMode; columns?: readonly number[] }

/** The viewport never becomes the next layout's baseline. */
export function layoutColumns(base: readonly number[], ratios: readonly number[] | null, viewport: number, gutter: number, mode: TableMode): ColumnLayout {
  const available = Math.max(0, viewport - gutter);
  const sum = base.reduce((total, width) => total + width, 0);
  if (mode !== 'fill' || !base.length || available < sum) return { widths: [...base], mode: 'scroll' };
  const weights = ratios && ratios.length === base.length ? ratios : base;
  const widths = fillWidths(weights, available, MIN_COLUMN);
  return { widths, mode: 'fill' };
}

export function resizeColumn(tab: DocTab, widths: readonly number[], column: number, delta: number, mode: TableMode, columns?: readonly number[]): void {
  const next = resizeWidths(widths, column, delta, mode, MIN_COLUMN);
  if (mode === 'fill') storeWidths(tab, widthRatios(next), columns, true);
  else { storeWidths(tab, next, columns); tab.tableFillRatios = null; }
}


export function resizeColumnKey(tab: DocTab, layout: ColumnLayout, column: number, key: string, shift = false): boolean {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return false;
  const step = shift ? 24 : 8;
  const at = layout.columns ? layout.columns.indexOf(column) : column;
  if (at < 0) return false;
  resizeColumn(tab, layout.widths, at, key === 'ArrowLeft' ? -step : step, layout.mode, layout.columns);
  return true;
}
