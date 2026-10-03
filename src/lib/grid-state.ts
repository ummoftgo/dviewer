import type { DocSource, GridSort, GridPredicate } from './ipc';
import type { TableMode } from './components/markdown/tables';
import { getValue, setValue } from './persist';

/** Persist stable source identity, never a runtime document or node number. */
export function gridSourceKey(source: DocSource, parent?: DocSource): string | null {
  if (source.type === 'file') return JSON.stringify(['file', source.path.replace(/\\/g, '/')]);
  if (source.type === 'url') return JSON.stringify(['url', source.url]);
  if (source.type === 'archiveEntry') {
    const root = gridSourceKey(source.root);
    return root && JSON.stringify(['archive', root, source.entries.map(e => [e.index, e.name])]);
  }
  if (source.type === 'treeSlice' && parent && source.path) {
    const root = gridSourceKey(parent);
    return root && JSON.stringify(['tree', root, source.path]);
  }
  return null;
}

export interface SavedGridState {
  identity: string;
  collection: string | null;
  schema: string;
  widths: number[];
  order: number[];
  hidden: number[];
  frozen: number;
  widthMode: TableMode;
  ratios: number[] | null;
  sort: GridSort | null;
  filter: string;
  filterColumn: number | null;
  predicates: GridPredicate[];
  hasHeader?: boolean;
  plain?: boolean;
  expanded?: boolean;
  formulas?: boolean;
}

const MAX_COLUMNS = 10000;
const MAX_ENTRIES = 200;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const indices = (v: unknown, count: number): v is number[] => Array.isArray(v) && v.length <= count
  && v.every(c => Number.isInteger(c) && c >= 0 && c < count) && new Set(v).size === v.length;
const widths = (v: unknown, count: number): v is number[] => Array.isArray(v) && (v.length === 0 || v.length === count)
  && v.every(w => typeof w === 'number' && Number.isFinite(w) && w >= 64 && w <= 100000);
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Reject a whole corrupt entry instead of silently attaching controls to new columns. */
export function readGridState(value: unknown): SavedGridState | null {
  if (!isRecord(value) || typeof value.identity !== 'string' || !value.identity || value.identity.length > 32768
    || typeof value.schema !== 'string' || value.schema.length > 1048576
    || (value.collection !== null && typeof value.collection !== 'string')) return null;
  let schema: unknown;
  try { schema = JSON.parse(value.schema); } catch { return null; }
  if (!Array.isArray(schema) || schema.length === 0 || schema.length > MAX_COLUMNS) return null;
  const count = schema.length;
  if (!widths(value.widths, count) || !indices(value.order, count) || (value.order.length !== 0 && value.order.length !== count)
    || !indices(value.hidden, count) || value.hidden.length >= count
    || !Number.isInteger(value.frozen) || (value.frozen as number) < 0 || (value.frozen as number) > count - value.hidden.length
    || (value.widthMode !== 'fill' && value.widthMode !== 'scroll')
    || (value.ratios !== null && (!Array.isArray(value.ratios) || value.ratios.length !== count
      || !value.ratios.every(w => typeof w === 'number' && Number.isFinite(w) && w > 0)
      || !Number.isFinite(value.ratios.reduce((sum, w) => sum + w, 0))))
    || typeof value.filter !== 'string' || value.filter.length > 1048576) return null;
  const column = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < count;
  if (value.filterColumn !== null && !column(value.filterColumn)) return null;
  if (value.sort !== null && (!isRecord(value.sort) || !column(value.sort.column) || typeof value.sort.descending !== 'boolean')) return null;
  const predicates = value.predicates ?? [];
  if (!Array.isArray(predicates) || predicates.length > 32 || !predicates.every(p => isRecord(p) && column(p.column)
    && ['equals', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'null', 'missing'].includes(p.op as string)
    && typeof p.value === 'string' && p.value.length <= 1048576
    && (!['empty', 'null', 'missing'].includes(p.op as string) || p.value === '')
    && (!['gt', 'gte', 'lt', 'lte'].includes(p.op as string) || (numeric.test(p.value.trim()) && Number.isFinite(Number(p.value)))))) return null;
  for (const name of ['hasHeader', 'plain', 'expanded', 'formulas']) if (value[name] !== undefined && typeof value[name] !== 'boolean') return null;
  // A deep copy also breaks aliases to mutable rune arrays supplied by callers.
  return JSON.parse(JSON.stringify({ ...value, predicates })) as SavedGridState;
}

export function readGridStates(value: unknown): SavedGridState[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return [];
  const seen = new Set<string>();
  return value.entries.slice(-MAX_ENTRIES).flatMap(v => {
    const state = readGridState(v);
    const key = state && JSON.stringify([state.identity, state.collection]);
    if (!state || !key || seen.has(key)) return [];
    seen.add(key); return [state];
  });
}

/** One debounced, serialized queue; in-memory snapshots survive reloads immediately. */
export class GridStateStore {
  private entries: SavedGridState[] = [];
  private loading: Promise<void> | null = null;
  private writing = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private read = () => getValue('gridStates'), private write = (value: unknown) => setValue('gridStates', value),
    private failed = (error: unknown) => console.warn('[dviewer] could not persist grid state:', error)) {}

  load(): Promise<void> {
    return this.loading ??= this.read().then(value => { this.entries = readGridStates(value); }).catch(this.failed);
  }
  async get(identity: string, collection: string | null): Promise<SavedGridState | null> {
    await this.load();
    return readGridState(this.entries.find(e => e.identity === identity && e.collection === collection));
  }
  async preferredCollection(identity: string): Promise<string | null> {
    await this.load();
    for (let at = this.entries.length - 1; at >= 0; at--) if (this.entries[at].identity === identity) return this.entries[at].collection;
    return null;
  }
  async remember(value: SavedGridState): Promise<void> {
    await this.load();
    const state = readGridState(value);
    if (!state) return;
    const at = this.entries.findIndex(e => e.identity === state.identity && e.collection === state.collection);
    if (at === this.entries.length - 1 && at >= 0 && JSON.stringify(this.entries[at]) === JSON.stringify(state)) return;
    if (at >= 0) this.entries.splice(at, 1);
    this.entries.push(state);
    this.entries = this.entries.slice(-MAX_ENTRIES);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 300);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await this.load();
    const snapshot = JSON.parse(JSON.stringify({ version: 1, entries: this.entries }));
    this.writing = this.writing.then(() => this.write(snapshot)).catch(this.failed);
    await this.writing;
  }
}
