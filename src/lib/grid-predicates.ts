import type { GridPredicate, GridPredicateOp } from './ipc';

export const predicateOps: GridPredicateOp[] = ['equals', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'null', 'missing'];
export const numericOps = new Set<GridPredicateOp>(['gt', 'gte', 'lt', 'lte']);
export function needsPredicateValue(op: GridPredicateOp): boolean {
  return !['empty', 'null', 'missing'].includes(op);
}
export function validNumericPredicate(value: string): boolean {
  const trimmed = value.trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) && Number.isFinite(Number(trimmed));
}
export function validPredicates(predicates: GridPredicate[], columnCount: number): boolean {
  return predicates.length <= 32 && predicates.every(p => Number.isInteger(p.column) && p.column >= 0 && p.column < columnCount
    && predicateOps.includes(p.op) && (numericOps.has(p.op) ? validNumericPredicate(p.value) : true)
    && (needsPredicateValue(p.op) || p.value === ''));
}
