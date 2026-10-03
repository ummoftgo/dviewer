import { expect, test } from 'vitest';
import { needsPredicateValue, validNumericPredicate, validPredicates, MAX_PREDICATE_VALUE_BYTES } from './grid-predicates';
test('numeric condition consumes the complete finite decimal value', () => {
  for (const value of ['-2.5', ' .5 ', '+4e-2', '9007199254740993']) expect(validNumericPredicate(value)).toBe(true);
  for (const value of ['', ' ', '12x', 'Infinity', 'NaN', '0x10', '1e999']) expect(validNumericPredicate(value)).toBe(false);
});
test('condition builder validates columns, operators and fixed-value predicates', () => {
  expect(validPredicates([{ column: 0, op: 'null', value: '' }, { column: 1, op: 'contains', value: 'a' }], 2)).toBe(true);
  expect(validPredicates([{ column: 2, op: 'empty', value: '' }], 2)).toBe(false);
  expect(validPredicates([{ column: 0, op: 'empty', value: 'ignored' }], 2)).toBe(false);
  expect(validPredicates(Array.from({ length: 33 }, () => ({ column: 0, op: 'null' as const, value: '' })), 1)).toBe(false);
  expect(needsPredicateValue('null')).toBe(false);
  expect(needsPredicateValue('equals')).toBe(true);
});

test('finite numeric grammar accepts exact decimal inputs and shares whitespace semantics', () => {
  for (const value of ['9007199254740993.0', '170141183460469231731687303715884105729', '1e-999999999999999999999', '0e999999999999999999999', '\ufeff1\ufeff', '\u00a0-.5\u2028', '1.']) expect(validNumericPredicate(value)).toBe(true);
  for (const value of ['\u00851\u0085', '1_000', '1e309', '1 2', '.']) expect(validNumericPredicate(value)).toBe(false);
});
test('condition value ceiling measures actual UTF-8 bytes', () => {
  const exact = '😀'.repeat(MAX_PREDICATE_VALUE_BYTES / 4);
  expect(validPredicates([{ column: 0, op: 'equals', value: exact }], 1)).toBe(true);
  expect(validPredicates([{ column: 0, op: 'equals', value: exact + 'x' }], 1)).toBe(false);
});
