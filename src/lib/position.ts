/** Durable coordinates; pixels and transient node ids belong only to a mounted view. */
export type Position =
  | { kind: 'prose'; heading?: string; ratio: number }
  | { kind: 'grid'; row: number; collection?: string }
  | { kind: 'tree'; path: string }
  | { kind: 'raw'; line: number }
  | { kind: 'pdf'; page: number; rotation?: number }
  | { kind: 'frame'; ratio: number };

const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const ratio = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const name = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 65536;
export const clampRatio = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export function readPosition(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return;
  const pos = value as Record<string, unknown>;
  switch (pos.kind) {
    case 'prose': return ratio(pos.ratio) && (pos.heading === undefined || name(pos.heading))
      ? {kind:'prose', ratio:pos.ratio, ...(pos.heading === undefined ? {} : {heading:pos.heading})} : undefined;
    case 'frame': return ratio(pos.ratio) ? {kind:'frame',ratio:pos.ratio} : undefined;
    case 'pdf': return natural(pos.page) && pos.page >= 1 && (pos.rotation === undefined || isPdfRotation(pos.rotation))
      ? {kind:'pdf',page:pos.page,...(pos.rotation === undefined ? {} : {rotation:pos.rotation as number})} : undefined;
    case 'raw': return natural(pos.line) ? {kind:'raw',line:pos.line} : undefined;
    case 'grid': return natural(pos.row) && (pos.collection === undefined || name(pos.collection))
      ? {kind:'grid',row:pos.row,...(pos.collection === undefined ? {} : {collection:pos.collection})} : undefined;
    case 'tree': return name(pos.path) ? {kind:'tree',path:pos.path} : undefined;
  }
}

export const isPdfRotation = (value: unknown): value is number => value === 0 || value === 90 || value === 180 || value === 270;

export interface HeadingPosition { id: string; top: number }
export function prosePosition(headings: readonly HeadingPosition[], top: number, max: number): Extract<Position,{kind:'prose'}> {
  let low = 0, high = headings.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (headings[mid].top <= top + 1) low = mid + 1;
    else high = mid;
  }
  const at = low - 1;
  if (at < 0) return {kind:'prose',ratio:clampRatio(top / max)};
  const heading = headings[at];
  const end = headings[at + 1]?.top ?? max;
  return {kind:'prose',heading:heading.id,ratio:clampRatio((top - heading.top) / (end - heading.top))};
}

export function proseTop(pos: Extract<Position,{kind:'prose'}>, headings: readonly HeadingPosition[], max: number): number {
  if (!pos.heading) return Math.max(0, max) * clampRatio(pos.ratio);
  const at = headings.findIndex(heading => heading.id === pos.heading);
  if (at < 0) return 0;
  const top = headings[at].top;
  return Math.max(0, Math.min(max, top + Math.max(0,(headings[at + 1]?.top ?? max) - top) * clampRatio(pos.ratio)));
}

export function originalRow(rows: readonly {index:number}[], windowStart: number, first: number): number | undefined {
  return rows[first - windowStart]?.index;
}

export function compatiblePosition(pos: Position | undefined, view: string, raw: boolean, docKind?: string): Position | undefined {
  const kind = raw ? 'raw' : view === 'frame' && docKind === 'pdf' ? 'pdf' : view === 'table' || view === 'collection' ? 'grid' : view;
  return pos?.kind === kind ? pos : undefined;
}
