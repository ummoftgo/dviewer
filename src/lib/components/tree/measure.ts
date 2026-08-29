/**
 * Deciding which values are wider than the cell they are drawn in.
 *
 * The obvious way — asking each cell whether `scrollWidth > clientWidth` —
 * forces a layout on every pass. Measured in this table's own markup that is
 * 0.8ms for 100 rows but 22ms for 2000 and 105ms for 10000, and the column
 * divider re-checks on every drag frame, where the budget is 16ms.
 *
 * So the string is measured against the same font on a canvas instead. The
 * result depends only on the text, which means it can be cached per row: the
 * drag then compares numbers and costs 0.1ms at 2000 rows and 0.5ms at 10000.
 * Measuring 100 rows costs 0.2ms, so the common case is free either way.
 *
 * Checked against real layout over 4000 rows of escapes, CJK, emoji, Arabic and
 * ASCII at six column widths — 24000 comparisons, no disagreement.
 */
import { splitEscapes } from "../escapes";

/** One canvas for the whole app; it is never attached or drawn to. */
const gauge = document.createElement("canvas").getContext("2d");

/**
 * A function measuring preview strings as `reference` would draw them.
 *
 * The font is resolved once per pass rather than per row — assigning
 * `context.font` is the expensive part of using a canvas this way.
 */
export function measurer(reference: Element): (text: string) => number {
  const style = getComputedStyle(reference);
  const size = Number.parseFloat(style.fontSize) || 0;
  if (gauge) {
    gauge.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  }
  return (text) => {
    if (!gauge) return 0;
    // Trailing whitespace hangs past the end of a line and never makes one
    // overflow, so measuring it costs 32 wrong answers in 24000.
    let width = gauge.measureText(text.replace(/\s+$/, "")).width;
    // Escape chips carry 0.1em of padding on each side (see EscapedText), and
    // a value with many of them overflows sooner than its glyphs alone say.
    for (const segment of splitEscapes(text)) {
      if (segment.escape) width += 0.2 * size;
    }
    return width;
  };
}

/**
 * Whether text of `width` is cut off in `available` pixels.
 *
 * The slack is not a fudge factor. The browser clips when `scrollWidth` exceeds
 * `clientWidth`, and both are integers, so text that runs over by a fraction of
 * a pixel is drawn whole. Comparing exactly instead costs 26 wrong answers in
 * 24000, all of them rows sitting on the boundary.
 */
export function clips(width: number, available: number): boolean {
  return width > available + 0.5;
}

/** Left plus right padding of `el`, which the text does not get to use. */
export function horizontalPadding(el: Element): number {
  const style = getComputedStyle(el);
  return Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
}
