/** Reader-injected comparison preparation, kept independent of Svelte and IPC for lifecycle tests. */
import { checkCompareSize, compareJson, compareLines, CompareError, COMPARE_MAX_LINES, sourceLines, type Comparison } from './compare';
export interface CompareDocument { id: number; byteLen: number; pagedLines: boolean }
export interface CompareReader {
  lines(docId: number, start: number, count: number): Promise<{total: number; lines: string[]}>;
  sourceText(docId: number): Promise<string>;
}

export async function loadComparison(a: CompareDocument, b: CompareDocument, asJson: boolean, current: () => boolean, reader: CompareReader): Promise<Comparison> {
  const checkCurrent = () => { if (!current()) throw new Error('cancelled'); };
  checkCurrent(); checkCompareSize(a.byteLen); checkCompareSize(b.byteLen);
  if (asJson) {
    const [one, two] = await Promise.all([reader.sourceText(a.id), reader.sourceText(b.id)]);
    checkCurrent();
    return compareJson(one, two);
  }
  const lines = async (tab: CompareDocument) => {
    checkCurrent();
    // doc_lines accepts plain text, not Markdown or JSON. Their existing
    // source-text IPC is bounded again by sourceLines before diff allocation.
    if (!tab.pagedLines) {
      const source = await reader.sourceText(tab.id);
      checkCurrent();
      return sourceLines(source);
    }
    const first = await reader.lines(tab.id, 0, 1000);
    checkCurrent();
    if (!Number.isInteger(first.total) || first.total < 0 || first.total > COMPARE_MAX_LINES || first.lines.length > first.total) throw new CompareError('limit');
    const all = [...first.lines];
    let bytes = 0;
    const countBytes = (values: string[]) => {
      for (const value of values) {
        checkCompareSize(bytes + value.length);
        bytes += new TextEncoder().encode(value).length + 1;
        checkCompareSize(Math.max(0, bytes - 1));
      }
    };
    countBytes(first.lines);
    while (all.length < first.total) {
      checkCurrent();
      const page = await reader.lines(tab.id, all.length, 1000);
      checkCurrent();
      if (page.total !== first.total || !page.lines.length || page.lines.length > first.total - all.length) throw new CompareError('limit');
      countBytes(page.lines); all.push(...page.lines);
    }
    return all;
  };
  const [one, two] = await Promise.all([lines(a), lines(b)]);
  checkCurrent();
  return compareLines(one, two);
}
