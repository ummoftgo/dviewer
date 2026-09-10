export type TableMode = "scroll" | "fill";

export interface TableState {
  mode: TableMode;
  scrollWidths?: number[];
  fillRatios?: number[];
}

/** HTML collections satisfy this shape without copying the document's cells. */
export function rectangularColumns(rows: Iterable<{ cells: Iterable<{ colSpan: number; rowSpan: number }> }>): number {
  let columns = 0;
  for (const row of rows) {
    let count = 0;
    for (const cell of row.cells) {
      if (cell.colSpan !== 1 || cell.rowSpan !== 1) return 0;
      count++;
    }
    if (count === 0 || (columns !== 0 && count !== columns)) return 0;
    columns = count;
  }
  return columns;
}

/** Allocate the measured proportions, fixing undersized columns first. */
export function fillWidths(weights: readonly number[], available: number, minimum: number): number[] {
  const sorted = weights.map((weight, index) => ({
    index,
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
  })).sort((a, b) => a.weight - b.weight);
  let remaining = Math.max(available, weights.length * minimum);
  let weightSum = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  const widths = Array<number>(weights.length);
  for (const { index, weight } of sorted) {
    const width = Math.max(minimum, remaining * weight / weightSum);
    widths[index] = width;
    remaining -= width;
    weightSum -= weight;
  }
  return widths;
}

export interface ColumnMeasure { min: number; max: number }

/** Reserve word widths first; long sentences share spare room on a square-root curve. */
export function recommendWidths(columns: readonly ColumnMeasure[], available: number, minimum: number): number[] {
  const widths = columns.map((column) => Math.max(minimum, column.min));
  let remaining = available - widths.reduce((sum, width) => sum + width, 0);
  if (remaining <= 0 || !columns.length) return widths;
  const growing = columns.map((column, index) => ({ index, capacity: Math.max(0, column.max - widths[index]) }))
    .filter(({ capacity }) => capacity > 0).sort((a, b) => a.capacity - b.capacity);
  let weightSum = growing.reduce((sum, { capacity }) => sum + Math.sqrt(capacity), 0);
  for (const { index, capacity } of growing) {
    const weight = Math.sqrt(capacity);
    const added = Math.min(capacity, remaining * weight / weightSum);
    widths[index] += added;
    remaining -= added;
    weightSum -= weight;
  }
  // max-content is a saturation point: a full page still uses all its width.
  if (remaining > 0) return widths.map((width) => width + remaining / widths.length);
  return widths;
}

export function widthRatios(widths: readonly number[]): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  let remaining = 100;
  return widths.map((width, index) => {
    const ratio = index === widths.length - 1 ? remaining : width / total * 100;
    remaining -= ratio;
    return ratio;
  });
}

/** Dragging and fitting share the same bounds and neighbor compensation. */
export function resizeWidths(widths: readonly number[], column: number, delta: number, mode: TableMode, minimum: number): number[] {
  const next = [...widths];
  if (column < 0 || column >= widths.length || (mode === "fill" && widths.length === 1)) return next;
  const neighbor = column === widths.length - 1 ? column - 1 : column + 1;
  let change = Math.max(minimum - widths[column], delta);
  if (mode === "fill") {
    change = Math.min(change, widths[neighbor] - minimum);
    next[neighbor] -= change;
  }
  next[column] += change;
  return next;
}
