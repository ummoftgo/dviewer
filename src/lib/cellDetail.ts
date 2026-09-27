import type { CellText } from './ipc';

/** Rust's `MAX_CELL_TEXT_BYTES`: what copying a cell has always been held to. */
export const MAX_CELL_BYTES = 8 * 1024 * 1024;
/**
 * Enough to read. A value past this is a document, not a field — the tree's
 * key/value table stops at the same place, and copying still takes the whole.
 */
export const SHOWN_CHARS = 20_000;

/**
 * Four things an empty-looking cell can be, and the panel has to say which:
 * a stored empty string, a database NULL, or a field the row does not have
 * (a short CSV row, a JSON object without the key). The grid draws all but
 * NULL as nothing.
 */
export type DetailKind = 'value' | 'empty' | 'null' | 'missing';

export interface CellDetail {
  kind: DetailKind;
  /** The value, up to the ceiling — what the copy button takes. */
  text: string;
  /** What the panel draws: the first `SHOWN_CHARS` characters of `text`. */
  shown: string;
  /** Characters, counted as code points so an emoji is one. */
  chars: number;
  lines: number;
  /** The value itself is longer than `text`: the ceiling cut it. */
  truncated: boolean;
  /** `shown` is shorter than `text`. */
  clipped: boolean;
  /** A whole JSON object or array — worth opening as a tree. */
  json: boolean;
}

export function cellDetail(cell: CellText): CellDetail {
  const kind: DetailKind = cell.null ? 'null' : cell.missing ? 'missing' : cell.text === '' ? 'empty' : 'value';
  const { text, cut } = capped(cell.text);
  const truncated = cell.truncated || cut;
  let chars = 0, lines = text ? 1 : 0;
  for (const character of text) {
    chars += 1;
    if (character === '\n') lines += 1;
  }
  const shown = chars > SHOWN_CHARS ? text.slice(0, endOf(text, SHOWN_CHARS)) : text;
  return { kind, text, shown, chars, lines, truncated, clipped: shown.length < text.length,
    json: kind === 'value' && !truncated && isContainer(text) };
}

/** The ceiling again, in case a reader ever hands back more: past it the panel
 *  would be laying out a document, and the clipboard would get what copying
 *  never gave. `encodeInto` stops before a character it cannot finish. */
function capped(text: string): { text: string; cut: boolean } {
  if (text.length * 3 <= MAX_CELL_BYTES) return { text, cut: false };
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(MAX_CELL_BYTES));
  return read < text.length ? { text: text.slice(0, read), cut: true } : { text, cut: false };
}

/** Where the first `count` code points end, in UTF-16 units. */
function endOf(text: string, count: number): number {
  let at = 0;
  for (let taken = 0; taken < count; taken += 1) at += text.codePointAt(at)! > 0xffff ? 2 : 1;
  return at;
}

function isContainer(text: string): boolean {
  if (!/^\s*[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
