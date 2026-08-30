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

export const MIN_COLUMN = 64;
export const MAX_AUTO_COLUMN = 420;
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
): void {
  const char = Math.max(6, fontPx * 0.62);
  tab.columnWidths = Array.from({ length: columnCount }, (_, column) => {
    let widest = visualLength(tab.header[column] ?? "");
    for (const row of sample) {
      widest = Math.max(widest, visualLength(row.cells[column]?.text ?? ""));
    }
    return Math.round(Math.min(MAX_AUTO_COLUMN, Math.max(MIN_COLUMN, widest * char + 26)));
  });
}

export function columnWidth(tab: DocTab, column: number): number {
  return tab.columnWidths[column] ?? FALLBACK_COLUMN;
}

/** Total width of the columns plus the row-number gutter. */
export function totalWidth(tab: DocTab, numberWidth: number): number {
  return numberWidth + tab.columnWidths.reduce((sum, width) => sum + width, 0);
}

/** Left edge of a column, in the same coordinates as `scrollLeft`. */
export function columnLeft(tab: DocTab, column: number, numberWidth: number): number {
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
export function startResize(event: PointerEvent, tab: DocTab, column: number): void {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLElement;
  const startX = event.clientX;
  const startWidth = columnWidth(tab, column);

  const move = (moved: PointerEvent) => {
    const next = Math.max(MIN_COLUMN, Math.round(startWidth + moved.clientX - startX));
    tab.columnWidths = tab.columnWidths.map((width, i) => (i === column ? next : width));
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
