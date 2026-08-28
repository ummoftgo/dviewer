/**
 * Scroll geometry for the virtualised tree and grid.
 *
 * Both views size a spacer to `rows × rowHeight` and position rows inside it by
 * index. That works until the spacer hits the browser's maximum element height
 * — measured at **33,554,428px** in this WebView (Chromium), which a 26px row
 * reaches after about 1.29 million rows. Past that the element silently stops
 * growing: the scrollbar can no longer address the rest of the document, and a
 * 38-million-node file becomes a 3%-of-it file with no indication that anything
 * is missing.
 *
 * So beyond the cap the spacer stops growing and the scroll position is mapped
 * proportionally onto the row range instead. One pixel of scrollbar then covers
 * several rows, which is the right trade — at 38 million rows a pixel was never
 * going to mean one row — and the wheel, the keyboard and search jumps all
 * still move exactly one row at a time.
 *
 * Below the cap every function here reduces to the plain `row × rowHeight`
 * arithmetic, so the common case is unchanged.
 */

/** Comfortably under the measured 33,554,428px ceiling. */
export const MAX_SPACER_PX = 32_000_000;

export interface ScrollMetrics {
  rowHeight: number;
  totalRows: number;
  viewportHeight: number;
}

function contentHeight({ rowHeight, totalRows }: ScrollMetrics): number {
  return totalRows * rowHeight;
}

export function isCompressed(metrics: ScrollMetrics): boolean {
  return contentHeight(metrics) > MAX_SPACER_PX;
}

/** Height to give the spacer element. */
export function spacerHeight(metrics: ScrollMetrics): number {
  return Math.min(contentHeight(metrics), MAX_SPACER_PX);
}

/** Rows that fit in the viewport, fractional. */
function pageRows(metrics: ScrollMetrics): number {
  return metrics.rowHeight > 0 ? metrics.viewportHeight / metrics.rowHeight : 0;
}

/** How far the spacer can actually be scrolled. */
function scrollRange(metrics: ScrollMetrics): number {
  return Math.max(1, spacerHeight(metrics) - metrics.viewportHeight);
}

/** Highest row that can sit at the top of the viewport. */
function maxAnchor(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.totalRows - pageRows(metrics));
}

/**
 * The row at the top of the viewport for a given scroll position — fractional,
 * so a partly scrolled row still counts as part of itself.
 */
export function anchorRow(metrics: ScrollMetrics, scrollTop: number): number {
  if (!isCompressed(metrics)) {
    return metrics.rowHeight > 0 ? scrollTop / metrics.rowHeight : 0;
  }
  return (scrollTop / scrollRange(metrics)) * maxAnchor(metrics);
}

/** The scroll position that puts `row` at the top of the viewport. */
export function scrollTopForRow(metrics: ScrollMetrics, row: number): number {
  if (!isCompressed(metrics)) return row * metrics.rowHeight;
  const highest = maxAnchor(metrics);
  if (highest <= 0) return 0;
  return (Math.min(row, highest) / highest) * scrollRange(metrics);
}

/**
 * Where to draw a row inside the spacer.
 *
 * Uncompressed this is exactly `row × rowHeight`: the anchor is `scrollTop /
 * rowHeight`, so the two `scrollTop` terms cancel and sub-pixel scrolling stays
 * smooth. Compressed, rows are drawn relative to wherever the scroll currently
 * is, because their true position no longer fits in the spacer.
 */
export function rowTop(metrics: ScrollMetrics, scrollTop: number, row: number): number {
  return scrollTop + (row - anchorRow(metrics, scrollTop)) * metrics.rowHeight;
}
