export interface SourcePosition { startLine: number; startColumn: number; endLine: number; endColumn: number }
export interface CopyBlock { position: string | null; level: number }

export function parseSourcePosition(value: string | null): SourcePosition | null {
  const match = value?.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
  if (!match) return null;
  const [startLine, startColumn, endLine, endColumn] = match.slice(1).map(Number);
  if (![startLine, startColumn, endLine, endColumn].every((n) => Number.isSafeInteger(n) && n > 0)
      || endLine < startLine || (endLine === startLine && endColumn < startColumn)) return null;
  return { startLine, startColumn, endLine, endColumn };
}

/** Offsets point into the original string, including CRLF, lone CR and final newline. */
export function lineOffsets(raw: string): number[] {
  const starts = [0];
  for (const match of raw.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}

export function validPositions(raw: string, blocks: CopyBlock[]): (SourcePosition | null)[] {
  const offsets = lineOffsets(raw);
  const encoder = new TextEncoder();
  const line = (n: number) => raw.slice(offsets[n - 1], offsets[n] ?? raw.length).replace(/[\r\n]+$/, '');
  const invalid = new Set<number>();
  const positions = blocks.map(({ position }, index) => {
    const p = parseSourcePosition(position);
    if (!p || p.endLine > offsets.length) return null;
    const first = encoder.encode(line(p.startLine));
    const last = encoder.encode(line(p.endLine));
    if (p.startColumn > first.length || p.endColumn > last.length) return null;
    // A line shared with another raw HTML element cannot be copied as a block.
    if (new TextDecoder().decode(first.slice(0, p.startColumn - 1)).trim().length) invalid.add(index);
    return p;
  });
  let previous = -1;
  positions.forEach((position, index) => {
    if (!position) return;
    if (previous >= 0 && position.startLine <= positions[previous]!.endLine) {
      invalid.add(previous);
      invalid.add(index);
    }
    previous = index;
  });
  return positions.map((position, index) => invalid.has(index) ? null : position);
}

/** The exclusive DOM end of a heading's section, or one block for other elements. */
export function sectionEnd(blocks: CopyBlock[], index: number): number {
  const level = blocks[index]?.level;
  if (!level) return index + 1;
  for (let next = index + 1; next < blocks.length; next++) {
    if (blocks[next].level > 0 && blocks[next].level <= level) return next;
  }
  return blocks.length;
}

export function rawBlock(raw: string, blocks: CopyBlock[], index: number, children = false): string | null {
  const positions = validPositions(raw, blocks);
  const position = positions[index];
  if (!position) return null;
  const starts = lineOffsets(raw);
  if (children && blocks[index].level) {
    const end = sectionEnd(blocks, index);
    if (end === blocks.length) return raw.slice(starts[position.startLine - 1]);
    const boundary = positions[end];
    return boundary ? raw.slice(starts[position.startLine - 1], starts[boundary.startLine - 1]) : null;
  }
  return raw.slice(starts[position.startLine - 1], starts[position.endLine] ?? raw.length);
}
