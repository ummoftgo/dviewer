import type { DocSource, GridSort, GridPredicate } from './ipc';
import type { TableMode } from './components/markdown/tables';
import { getValue, setValue } from './persist';
import { validPredicates } from './grid-predicates';

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
export const MAX_GRID_STATE_BYTES = 64 * 1024 * 1024;
export type GridStorageNotice = 'pruned' | 'conditionsNotSaved';
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const indices = (v: unknown, count: number): v is number[] => Array.isArray(v) && v.length <= count
  && v.every(c => Number.isInteger(c) && c >= 0 && c < count) && new Set(v).size === v.length;
const widths = (v: unknown, count: number): v is number[] => Array.isArray(v) && (v.length === 0 || v.length === count)
  && v.every(w => typeof w === 'number' && Number.isFinite(w) && w >= 64 && w <= 100000);

/** Exact UTF-8 JSON string size, including escaping and well-formed lone surrogates. */
export function jsonStringBytes(value: string, limit = Infinity): number {
  let bytes = 2;
  for (let at = 0; at < value.length; at++) {
    const unit = value.charCodeAt(at);
    if (unit === 34 || unit === 92 || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) bytes += 2;
    else if (unit < 32) bytes += 6;
    else if (unit < 128) bytes++;
    else if (unit < 2048) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < value.length
      && value.charCodeAt(at + 1) >= 0xdc00 && value.charCodeAt(at + 1) <= 0xdfff) { bytes += 4; at++; }
    else if (unit >= 0xd800 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

/** Count before serialization; oversized conditions never become a giant temporary JSON string. */
export function jsonUtf8Bytes(value: unknown, limit = Infinity): number {
  if (typeof value === 'string') return jsonStringBytes(value, limit);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (!value || typeof value !== 'object') return 4;
  let bytes = 2, count = 0;
  if (Array.isArray(value)) {
    for (let at = 0; at < value.length; at++) {
      if (at) bytes++;
      bytes += jsonUtf8Bytes(value[at], Math.max(0, limit - bytes));
      if (bytes > limit) return limit + 1;
    }
    return bytes;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (count++) bytes++;
    bytes += jsonStringBytes(key) + 1;
    bytes += jsonUtf8Bytes(item, Math.max(0, limit - bytes));
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

const STORE_OVERHEAD = jsonUtf8Bytes({ version: 1, entries: [] });
const withoutConditions = (state: SavedGridState): SavedGridState => ({ ...state, sort: null, filter: '', filterColumn: null, predicates: [] });
const stateKey = (state: SavedGridState) => JSON.stringify([state.identity, state.collection]);

function boundedState(state: SavedGridState, maxBytes: number, notice: (type: GridStorageNotice) => void): SavedGridState | null {
  const available = maxBytes - STORE_OVERHEAD;
  if (jsonUtf8Bytes(state, available) <= available) return state;
  const layout = withoutConditions(state);
  if (jsonUtf8Bytes(layout, available) > available) return null;
  notice('conditionsNotSaved');
  return layout;
}

function newestWithinBudget(entries: SavedGridState[], maxBytes: number): SavedGridState[] {
  let used = STORE_OVERHEAD;
  const kept: SavedGridState[] = [];
  // Keep a contiguous recent history: remove oldest entries until the remainder fits.
  for (let at = entries.length - 1; at >= 0 && kept.length < MAX_ENTRIES; at--) {
    const size = jsonUtf8Bytes(entries[at], maxBytes - used);
    const next = used + size + (kept.length ? 1 : 0);
    if (next > maxBytes) break;
    used = next; kept.push(entries[at]);
  }
  return kept.reverse();
}

function sameState(a: SavedGridState, b: SavedGridState): boolean {
  return a.identity === b.identity && a.collection === b.collection && a.schema === b.schema
    && a.frozen === b.frozen && a.widthMode === b.widthMode && a.filter === b.filter && a.filterColumn === b.filterColumn
    && a.hasHeader === b.hasHeader && a.plain === b.plain && a.expanded === b.expanded && a.formulas === b.formulas
    && a.sort?.column === b.sort?.column && a.sort?.descending === b.sort?.descending
    && [a.widths, a.order, a.hidden].every((values, at) => {
      const other = [b.widths, b.order, b.hidden][at];
      return values.length === other.length && values.every((v, i) => v === other[i]);
    }) && (a.ratios === null ? b.ratios === null : b.ratios !== null && a.ratios.length === b.ratios.length && a.ratios.every((v, i) => v === b.ratios![i]))
    && a.predicates.length === b.predicates.length && a.predicates.every((p, i) => p.column === b.predicates[i].column && p.op === b.predicates[i].op && p.value === b.predicates[i].value);
}

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
    || typeof value.filter !== 'string') return null;
  const column = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < count;
  if (value.filterColumn !== null && !column(value.filterColumn)) return null;
  if (value.sort !== null && (!isRecord(value.sort) || !column(value.sort.column) || typeof value.sort.descending !== 'boolean')) return null;
  const predicates = value.predicates ?? [];
  if (!Array.isArray(predicates) || !predicates.every(p => isRecord(p) && typeof p.value === 'string')
    || !validPredicates(predicates as GridPredicate[], count)) return null;
  for (const name of ['hasHeader', 'plain', 'expanded', 'formulas']) if (value[name] !== undefined && typeof value[name] !== 'boolean') return null;
  // Copy bounded structures; immutable strings need no JSON round trip or duplicate allocation.
  return { identity: value.identity, collection: value.collection, schema: value.schema,
    widths: [...value.widths], order: [...value.order], hidden: [...value.hidden], frozen: value.frozen,
    widthMode: value.widthMode, ratios: value.ratios === null ? null : [...value.ratios],
    sort: value.sort === null ? null : { column: value.sort.column, descending: value.sort.descending },
    filter: value.filter, filterColumn: value.filterColumn,
    predicates: predicates.map(p => ({ column: p.column, op: p.op, value: p.value })),
    ...Object.fromEntries(['hasHeader', 'plain', 'expanded', 'formulas'].filter(name => value[name] !== undefined).map(name => [name, value[name]])) } as SavedGridState;
}

export function readGridStates(value: unknown, maxBytes = MAX_GRID_STATE_BYTES, notice: (type: GridStorageNotice) => void = () => {}): SavedGridState[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return [];
  const seen = new Set<string>();
  const candidates: SavedGridState[] = [];
  const notices = new Set<GridStorageNotice>();
  for (const entry of value.entries.slice(-MAX_ENTRIES).reverse()) {
    const state = readGridState(entry);
    if (!state || seen.has(stateKey(state))) continue;
    seen.add(stateKey(state));
    const bounded = boundedState(state, maxBytes, type => notices.add(type));
    if (bounded) candidates.push(bounded);
    else notices.add('pruned');
  }
  candidates.reverse();
  const kept = newestWithinBudget(candidates, maxBytes);
  if (kept.length < candidates.length || value.entries.length > MAX_ENTRIES) notices.add('pruned');
  notices.forEach(type => notice(type));
  return kept;
}

/** One debounced, serialized queue; in-memory snapshots survive reloads immediately. */
export class GridStateStore {
  private entries: SavedGridState[] = [];
  private loading: Promise<void> | null = null;
  private writing = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warned = new Set<string>();
  constructor(private read = () => getValue('gridStates'), private write = (value: unknown) => setValue('gridStates', value),
    private failed = (error: unknown) => console.warn('[dviewer] could not persist grid state:', error),
    private limited: (type: GridStorageNotice) => void = () => {}, private maxBytes = MAX_GRID_STATE_BYTES) {}

  load(): Promise<void> {
    return this.loading ??= this.read().then(value => { this.entries = readGridStates(value, this.maxBytes, this.limited); }).catch(this.failed);
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
    const checked = readGridState(value);
    if (!checked) { this.failed(new Error('Invalid grid view state')); return; }
    const key = stateKey(checked);
    let limited = false;
    const state = boundedState(checked, this.maxBytes, type => {
      limited = true;
      if (!this.warned.has(key)) {
        if (this.warned.size >= MAX_ENTRIES) this.warned.delete(this.warned.values().next().value!);
        this.warned.add(key); this.limited(type);
      }
    });
    if (!state) this.failed(new Error('Grid view metadata exceeds the storage budget'));
    if (!limited) this.warned.delete(key);
    const at = this.entries.findIndex(e => stateKey(e) === key);
    if (state && at === this.entries.length - 1 && at >= 0 && sameState(this.entries[at], state)) return;
    const next = this.entries.filter(e => stateKey(e) !== key);
    if (state) next.push(state);
    this.entries = newestWithinBudget(next, this.maxBytes);
    if (this.entries.length < next.length) this.limited('pruned');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 300);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await this.load();
    const snapshot = { version: 1, entries: this.entries.map(entry => readGridState(entry)!) };
    this.writing = this.writing.then(() => this.write(snapshot)).catch(this.failed);
    await this.writing;
  }
}
