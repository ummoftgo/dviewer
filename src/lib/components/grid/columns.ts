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
): void {
  tab.tableFillRatios = null;
  tab.columnWidths = Array.from({ length: columnCount }, (_, column) => measuredWidth(sample, column, fontPx, columnName(column), maximum));
}

function measuredWidth(sample: TableRow[], column: number, fontPx: number, name: string, maximum: number): number {
  const char = Math.max(6, fontPx * 0.62);
  let widest = visualLength(name);
  for (const row of sample) widest = Math.max(widest, visualLength(row.cells[column]?.text ?? ""));
  return Math.round(Math.min(maximum, Math.max(MIN_COLUMN, widest * char + 26)));
}

export function fitColumn(tab: DocTab, sample: TableRow[], column: number, fontPx: number, name: string, maximum = MAX_AUTO_COLUMN, layout?: ColumnLayout): void {
  const content = measuredWidth(sample, column, fontPx, name, maximum);
  if (layout?.mode === 'fill' && content <= layout.widths.reduce((sum, width) => sum + width, 0)) {
    resizeColumn(tab, layout.widths, column, content - layout.widths[column], 'fill');
  } else {
    if (layout) tab.columnWidths = [...layout.widths];
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

  const move = (moved: PointerEvent) => {
    resizeColumn(tab, widths, column, Math.round(moved.clientX - startX), mode);
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

export interface ColumnLayout { widths: number[]; mode: TableMode }

/** The viewport never becomes the next layout's baseline. */
export function layoutColumns(base: readonly number[], ratios: readonly number[] | null, viewport: number, gutter: number, mode: TableMode): ColumnLayout {
  const available = Math.max(0, viewport - gutter);
  const sum = base.reduce((total, width) => total + width, 0);
  if (mode !== 'fill' || !base.length || available < sum) return { widths: [...base], mode: 'scroll' };
  const weights = ratios && ratios.length === base.length ? ratios : base;
  const widths = fillWidths(weights, available, MIN_COLUMN);
  return { widths, mode: 'fill' };
}

export function resizeColumn(tab: DocTab, widths: readonly number[], column: number, delta: number, mode: TableMode): void {
  const next = resizeWidths(widths, column, delta, mode, MIN_COLUMN);
  if (mode === 'fill') tab.tableFillRatios = widthRatios(next);
  else { tab.columnWidths = next; tab.tableFillRatios = null; }
}


export function resizeColumnKey(tab: DocTab, layout: ColumnLayout, column: number, key: string, shift = false): boolean {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return false;
  const step = shift ? 24 : 8;
  resizeColumn(tab, layout.widths, column, key === 'ArrowLeft' ? -step : step, layout.mode);
  return true;
}
