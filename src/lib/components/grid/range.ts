/** A range uses displayed row/column coordinates, independent of source order. */
export interface GridPoint { row: number; column: number }
export interface GridRange { anchor: GridPoint; focus: GridPoint }
export function rangeBounds(range: GridRange) {
  return { firstRow: Math.min(range.anchor.row, range.focus.row), lastRow: Math.max(range.anchor.row, range.focus.row),
    firstColumn: Math.min(range.anchor.column, range.focus.column), lastColumn: Math.max(range.anchor.column, range.focus.column) };
}
export function containsCell(range: GridRange | null, row: number, column: number): boolean {
  if (!range) return false;
  const b = rangeBounds(range);
  return row >= b.firstRow && row <= b.lastRow && column >= b.firstColumn && column <= b.lastColumn;
}
export function moveRange(range: GridRange, rowDelta: number, columnDelta: number, rows: number, columns: number, extend: boolean): GridRange {
  const focus = { row: Math.max(0, Math.min(rows - 1, range.focus.row + rowDelta)),
    column: Math.max(0, Math.min(columns - 1, range.focus.column + columnDelta)) };
  return { anchor: extend ? range.anchor : focus, focus };
}
/** Columns are projected only after normalizing, so hidden columns cannot leak. */
export function rangeColumns(range: GridRange, visible: readonly number[]): number[] {
  const b = rangeBounds(range);
  return visible.slice(b.firstColumn, b.lastColumn + 1);
}
