import { expect, test } from 'vitest';
import { containsCell, moveRange, rangeBounds, rangeColumns } from './range';
const reversed = { anchor: { row: 8, column: 2 }, focus: { row: 2, column: 0 } };
test('reverse drag normalizes both axes', () => {
  expect(rangeBounds(reversed)).toEqual({ firstRow: 2, lastRow: 8, firstColumn: 0, lastColumn: 2 });
  expect(containsCell(reversed, 6, 1)).toBe(true);
  expect(containsCell(reversed, 9, 1)).toBe(false);
  expect(containsCell(null, 2, 0)).toBe(false);
});
test('range projection preserves displayed order and excludes hidden columns', () => {
  expect(rangeColumns(reversed, [4, 0, 2])).toEqual([4, 0, 2]);
});
test('shift extends from anchor and regular navigation collapses the range', () => {
  expect(moveRange(reversed, -99, 99, 12, 4, true)).toEqual({ anchor: reversed.anchor, focus: { row: 0, column: 3 } });
  expect(moveRange(reversed, 1, 0, 12, 4, false)).toEqual({ anchor: { row: 3, column: 0 }, focus: { row: 3, column: 0 } });
});
