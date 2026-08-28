/**
 * Splitting a preview string into plain text and escape sequences.
 *
 * Rust hands previews over as a JSON string body — see `json/text.rs` — so a
 * backslash always begins an escape and never stands for itself. That is what
 * makes this split unambiguous: `a\nb` is text-escape-text, and a literal
 * backslash arrives as `\\`, which is an escape of its own.
 */

export interface Segment {
  text: string;
  escape: boolean;
}

const HEX = /^[0-9a-fA-F]{4}$/;

/** Length of the escape starting at `i`, or 0 if there is not one. */
function escapeLength(text: string, i: number): number {
  if (text[i] !== "\\") return 0;
  const next = text[i + 1];
  // A trailing lone backslash is malformed input; mark it rather than let it
  // slip into the run of plain text.
  if (next === undefined) return 1;
  if (next === "u" && HEX.test(text.slice(i + 2, i + 6))) return 6;
  // Two characters covers both the known short escapes and the unknown ones
  // (`\q`), which reach us verbatim and are still not plain text.
  return 2;
}

/**
 * Adjacent runs of the same kind are merged, so a 500-character value with no
 * escapes yields exactly one segment rather than one per character.
 */
export function splitEscapes(text: string): Segment[] {
  const segments: Segment[] = [];
  let plainFrom = 0;
  let i = 0;

  const flushPlain = (until: number) => {
    if (until > plainFrom) segments.push({ text: text.slice(plainFrom, until), escape: false });
  };

  while (i < text.length) {
    const length = escapeLength(text, i);
    if (length === 0) {
      i++;
      continue;
    }
    flushPlain(i);
    const escape = text.slice(i, i + length);
    const last = segments.at(-1);
    if (last?.escape) last.text += escape;
    else segments.push({ text: escape, escape: true });
    i += length;
    plainFrom = i;
  }

  flushPlain(text.length);
  return segments;
}
