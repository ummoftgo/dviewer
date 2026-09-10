import { describe, expect, it } from 'vitest';
import { lineOffsets, parseSourcePosition, rawBlock, sectionEnd, validPositions, type CopyBlock } from './blocks';
import { favoriteLanguages, languageLabel } from './code';
const block = (position: string | null, level = 0): CopyBlock => ({ position, level });

describe('original Markdown block ranges', () => {
  it('parses inclusive positions', () => expect(parseSourcePosition('1:2-3:4')).toEqual({ startLine: 1, startColumn: 2, endLine: 3, endColumn: 4 }));
  it('rejects malformed and reversed positions', () => {
    for (const pos of [null, '', '0:1-1:1', '2:1-1:1', '1:3-1:2', '1:1-1:1x', '999999999999999999:1-999999999999999999:2']) expect(parseSourcePosition(pos)).toBeNull();
  });
  it('indexes mixed line endings without changing them', () => expect(lineOffsets('a\r\nb\rc\n')).toEqual([0, 3, 5, 7]));
  it('preserves CRLF and final newline', () => expect(rawBlock('a\r\nb\r\n', [block('1:1-2:1')], 0)).toBe('a\r\nb\r\n'));
  it('preserves lone CR and no final newline', () => expect(rawBlock('a\rb', [block('2:1-2:1')], 0)).toBe('b'));
  it('rejects positions outside the document', () => expect(validPositions('a', [block('1:1-2:1'), block('1:1-1:9')])).toEqual([null, null]));
  it('validates byte columns for non-ASCII source', () => expect(rawBlock('한글😀\n', [block('1:1-1:10')], 0)).toBe('한글😀\n'));
  it('rejects overlapping sibling positions', () => expect(validPositions('abc\ndef', [block('1:1-2:3'), block('2:1-2:3')])).toEqual([null, null]));
  it('rejects backwards sibling order', () => expect(validPositions('a\nb', [block('2:1-2:1'), block('1:1-1:1')])).toEqual([null, null]));
  it('rejects HTML elements sharing a line', () => expect(validPositions('<h1>A</h1><p>B</p>', [block('1:1-1:10'), block('1:11-1:18')])).toEqual([null, null]));
  it('ends before a heading at the same level', () => expect(sectionEnd([block(null, 2), block(null), block(null, 2)], 0)).toBe(2));
  it('includes deeper headings until a shallower heading', () => expect(sectionEnd([block(null, 2), block(null, 3), block(null), block(null, 1)], 0)).toBe(3));
  it('copies reference definitions and blank lines before next heading', () => {
    const raw = '# A\r\nx\r\n\r\n[ref]: /a\r\n\r\n# B\r\n';
    expect(rawBlock(raw, [block('1:1-1:3', 1), block('2:1-2:1'), block('6:1-6:3', 1)], 0, true)).toBe('# A\r\nx\r\n\r\n[ref]: /a\r\n\r\n');
  });
  it('includes trailing unrendered text to end of document', () => expect(rawBlock('# A\nx\n\n[r]: /x\n', [block('1:1-1:3', 1), block('2:1-2:1')], 0, true)).toBe('# A\nx\n\n[r]: /x\n'));
  it('refuses a heading section with an unknown boundary', () => expect(rawBlock('# A\nx\n# B', [block('1:1-1:3', 1), block(null, 1)], 0, true)).toBeNull());
  it('copies lists whole without a section question', () => expect(rawBlock('- a\n- b\n\nx', [block('1:1-2:3')], 0, true)).toBe('- a\n- b\n'));
  it('labels an explicit unsupported language', () => expect(languageLabel({name: 'Plain Text', unknown: 'foo'}, (name) => `알 수 없음: ${name}`)).toBe('알 수 없음: foo'));
  it('offers only supported favorites in the agreed order', () => expect(favoriteLanguages([{ name: 'Rust', tokens: ['rs'] }, { name: 'JSON', tokens: ['json'] }, { name: 'Other', tokens: [] }]).map((x) => x.name)).toEqual(['JSON', 'Rust']));
  it('includes the added grammars in the quick language list', () => {
    const names = ['Dockerfile', 'TypeScriptReact', 'TypeScript', 'TOML'];
    expect(favoriteLanguages(names.map((name) => ({ name, tokens: [] }))).map((x) => x.name))
      .toEqual(['TOML', 'TypeScript', 'TypeScriptReact', 'Dockerfile']);
  });
});
