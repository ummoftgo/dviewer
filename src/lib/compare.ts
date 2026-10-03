/** Bounded source comparison; display previews are never used for equality. */
export const COMPARE_MAX_BYTES = 2 * 1024 * 1024;
export const COMPARE_MAX_LINES = 10_000;
export const COMPARE_MAX_CELLS = 1_000_000;
export const COMPARE_MAX_NODES = 20_000;
export const COMPARE_MAX_DEPTH = 128;
export type CompareFailure = 'limit' | 'complexity' | 'json';
export class CompareError extends Error {
  constructor(public reason: CompareFailure) { super(reason); }
}
export function checkCompareSize(byteLen: number) {
  if (!Number.isFinite(byteLen) || byteLen < 0 || byteLen > COMPARE_MAX_BYTES) throw new CompareError('limit');
}
export function sourceLines(text: string): string[] {
  // UTF-8 is never shorter than the UTF-16 code-unit count. Refuse huge inputs before allocating encoded copies.
  checkCompareSize(text.length);
  checkCompareSize(new TextEncoder().encode(text).length);
  const lines = text.split('\n').map((line, index, all) => index < all.length - 1 && line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines.length > COMPARE_MAX_LINES) throw new CompareError('limit');
  return lines;
}
export interface DiffRow {
  kind: 'same' | 'changed' | 'added' | 'removed' | 'order';
  left: string | null;
  right: string | null;
  leftLine?: number;
  rightLine?: number;
  path?: string;
}
export interface Comparison { rows: DiffRow[]; changes: number[] }
function comparison(rows: DiffRow[]): Comparison {
  return { rows, changes: rows.flatMap((row, index) => row.kind === 'same' ? [] : [index]) };
}
/** Exact line LCS with unchanged prefix/suffix removed before allocating. */
export function compareLines(left: readonly string[], right: readonly string[]): Comparison {
  for (const lines of [left, right]) {
    if (lines.length > COMPARE_MAX_LINES) throw new CompareError('limit');
    let bytes = Math.max(0, lines.length - 1);
    for (const line of lines) {
      checkCompareSize(bytes + line.length);
      bytes += new TextEncoder().encode(line).length;
      checkCompareSize(bytes);
    }
  }
  let prefix = 0;
  while (prefix < Math.min(left.length, right.length) && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(left.length, right.length) - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  const a = left.length - prefix - suffix, b = right.length - prefix - suffix;
  if ((a + 1) * (b + 1) > COMPARE_MAX_CELLS) throw new CompareError('complexity');
  const width = b + 1;
  const lcs = new Uint32Array((a + 1) * width);
  for (let i = a - 1; i >= 0; i--) for (let j = b - 1; j >= 0; j--) {
    lcs[i * width + j] = left[prefix + i] === right[prefix + j]
      ? 1 + lcs[(i + 1) * width + j + 1] : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
  }
  const rows: DiffRow[] = [];
  const same = (i: number, j: number) => rows.push({kind: 'same', left: left[i], right: right[j], leftLine: i + 1, rightLine: j + 1});
  for (let i = 0; i < prefix; i++) same(i, i);
  let i = 0, j = 0;
  while (i < a || j < b) {
    if (i < a && j < b && left[prefix + i] === right[prefix + j]) { same(prefix + i++, prefix + j++); continue; }
    const removed: number[] = [], added: number[] = [];
    while (i < a || j < b) {
      if (i < a && j < b && left[prefix + i] === right[prefix + j]) break;
      if (i < a && (j === b || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) removed.push(prefix + i++);
      else added.push(prefix + j++);
    }
    for (let n = 0; n < Math.max(removed.length, added.length); n++) {
      const l = removed[n], r = added[n];
      rows.push({kind: l === undefined ? 'added' : r === undefined ? 'removed' : 'changed', left: l === undefined ? null : left[l], right: r === undefined ? null : right[r], leftLine: l === undefined ? undefined : l + 1, rightLine: r === undefined ? undefined : r + 1});
    }
  }
  for (let n = suffix; n > 0; n--) same(left.length - n, right.length - n);
  return comparison(rows);
}
interface JsonNode { type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'; scalar?: string; entries?: [string, JsonNode][]; items?: JsonNode[]; raw: string }
function numberIdentity(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  const exponentToken = (match[4] ?? '0').replace(/^([+-]?)0+/, '$1') || '0';
  if (exponentToken.replace(/^[+-]/, '').length > 10) throw new CompareError('limit');
  if (!digits) return '0';
  let exponent = BigInt(exponentToken === '+' || exponentToken === '-' ? '0' : exponentToken) - BigInt((match[3] ?? '').length);
  // An unanchored /0+$/ can retry a long internal zero run quadratically. Scan once from the right.
  let end = digits.length;
  while (end > 0 && digits[end - 1] === '0') end--;
  exponent += BigInt(digits.length - end); digits = digits.slice(0, end);
  return `${match[1]}${digits}e${exponent}`;
}
/** Preserves number precision, original key order and string escape semantics. Duplicate keys are ambiguous and refused. */
function parseJson(source: string): JsonNode {
  checkCompareSize(source.length);
  checkCompareSize(new TextEncoder().encode(source).length);
  let at = 0, count = 0;
  const fail = (): never => { throw new CompareError('json'); };
  const space = () => { while (/[\x20\t\r\n]/.test(source[at] ?? '') && at < source.length) at++; };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue; }
      if (source[at++] === '"') { try { return JSON.parse(source.slice(start, at)) as string; } catch { return fail(); } }
    }
    return fail();
  };
  const value = (depth: number): JsonNode => {
    space();
    if (++count > COMPARE_MAX_NODES || depth > COMPARE_MAX_DEPTH) throw new CompareError('limit');
    const start = at;
    let node: Omit<JsonNode, 'raw'>;
    if (source[at] === '{') {
      at++; space(); const entries: [string, JsonNode][] = [], keys = new Set<string>();
      if (source[at] !== '}') while (true) {
        if (source[at] !== '"') fail();
        const key = string(); if (keys.has(key)) fail(); keys.add(key); space();
        if (source[at++] !== ':') fail();
        entries.push([key, value(depth + 1)]); space();
        if (source[at] !== ',') break; at++; space();
      }
      if (source[at++] !== '}') fail(); node = {type: 'object', entries};
    } else if (source[at] === '[') {
      at++; space(); const items: JsonNode[] = [];
      if (source[at] !== ']') while (true) {
        items.push(value(depth + 1)); space(); if (source[at] !== ',') break; at++; space();
      }
      if (source[at++] !== ']') fail(); node = {type: 'array', items};
    } else if (source[at] === '"') node = {type: 'string', scalar: string()};
    else {
      const token = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(source.slice(at))?.[0];
      if (!token) return fail(); at += token.length;
      const type = token === 'null' ? 'null' : token === 'true' || token === 'false' ? 'boolean' : 'number';
      node = {type, scalar: type === 'number' ? numberIdentity(token) : token};
    }
    // Container previews are bounded: nested documents never copy their full raw source into every ancestor.
    return {...node, raw: source.slice(start, Math.min(at, start + 180)) + (at - start > 180 ? '…' : '')};
  };
  const result = value(0); space(); if (at !== source.length) fail(); return result;
}
export function compareJson(left: string, right: string): Comparison {
  const rows: DiffRow[] = [];
  // Display paths also have a budget: a long ancestor key must not be copied into thousands of descendants.
  const childPath = (path: string, key: string | number) => {
    const segment = typeof key === 'number' ? String(key) : JSON.stringify(key.slice(0, 512)) + (key.length > 512 ? '…' : '');
    const joined = `${path}[${segment}]`;
    return joined.length > 1024 ? joined.slice(0, 1023) + '…' : joined;
  };
  const visit = (a: JsonNode | undefined, b: JsonNode | undefined, path: string) => {
    const add = (kind: DiffRow['kind']) => rows.push({kind, path, left: a?.raw ?? null, right: b?.raw ?? null});
    if (!a) { add('added'); return; } if (!b) { add('removed'); return; }
    if (a.type !== b.type) { add('changed'); return; }
    if (a.type === 'object') {
      const l = a.entries!, r = b.entries!, lm = new Map(l), rm = new Map(r);
      if (l.length === r.length && l.every(([key]) => rm.has(key)) && l.some(([key], index) => key !== r[index][0])) add('order');
      for (const [key, node] of l) visit(node, rm.get(key), childPath(path, key));
      for (const [key, node] of r) if (!lm.has(key)) visit(undefined, node, childPath(path, key));
    } else if (a.type === 'array') {
      for (let index = 0; index < Math.max(a.items!.length, b.items!.length); index++) visit(a.items![index], b.items![index], childPath(path, index));
    } else if (a.scalar !== b.scalar) add('changed');
  };
  visit(parseJson(left), parseJson(right), '$');
  return comparison(rows);
}
/** Pending IPC batches must not publish into a replaced or closed comparison. */
export class CompareRequests {
  private generation = 0;
  begin(): number { return ++this.generation; }
  cancel() { this.generation++; }
  guard(ticket: number, ...generations: (() => number | undefined)[]): () => boolean {
    const snapshots = generations.map(read => read());
    return () => this.current(ticket) && generations.every((read, index) => read() === snapshots[index]);
  }
  current(ticket: number): boolean { return ticket === this.generation; }
}
