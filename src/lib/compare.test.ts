import { describe, expect, it } from 'vitest';
import { compareJson, compareLines, sourceLines, checkCompareSize, CompareRequests, COMPARE_MAX_BYTES, COMPARE_MAX_LINES } from './compare';

describe('bounded line comparison', () => {
  it('pairs replacements and retains full values and line numbers', () => {
    const result = compareLines(['first', 'x'.repeat(1000), 'last'], ['first', 'new', 'last']);
    expect(result.changes).toEqual([1]);
    expect(result.rows[1]).toEqual({kind: 'changed', left: 'x'.repeat(1000), right: 'new', leftLine: 2, rightLine: 2});
  });
  it('aligns insertions and deletions without turning the remainder into changes', () => {
    const result = compareLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c']);
    expect(result.rows.map(row => row.kind)).toEqual(['same', 'added', 'same', 'same']);
    expect(compareLines(['a', 'x', 'b'], ['a', 'b']).rows.map(row => row.kind)).toEqual(['same', 'removed', 'same']);
  });
  it('supports truly empty arrays and empty source files', () => {
    expect(compareLines([], []).changes).toEqual([]);
    expect(compareLines([], ['a']).rows[0].kind).toBe('added');
    expect(sourceLines('')).toEqual(['']);
  });
  it('normalizes CRLF only and preserves final bare CR and trailing newlines', () => {
    expect(sourceLines('a\r\nb\r')).toEqual(['a', 'b\r']);
    expect(sourceLines('a\n')).toEqual(['a', '']);
    expect(compareLines(sourceLines('a\r\nb'), sourceLines('a\nb')).changes).toEqual([]);
  });
  it('bounds source bytes, lines and quadratic work', () => {
    expect(() => checkCompareSize(COMPARE_MAX_BYTES + 1)).toThrow('limit');
    expect(() => sourceLines('x\n'.repeat(COMPARE_MAX_LINES))).toThrow('limit');
    expect(() => compareLines(Array(1100).fill('a'), Array(1100).fill('b'))).toThrow('complexity');
    expect(compareLines(Array(9000).fill('a'), [...Array(9000).fill('a'), 'b']).changes).toEqual([9000]);
  });
});

describe('precise JSON structure comparison', () => {
  it('classifies key order separately from value changes, including integer keys', () => {
    expect(compareJson('{"2":2,"1":1}', '{"1":1,"2":2}').rows.map(row => row.kind)).toEqual(['order']);
    expect(compareJson('{"a":1,"b":2}', '{"b":3,"a":1}').rows.map(row => [row.kind, row.path])).toEqual([['order', '$'], ['changed', '$["b"]']]);
  });
  it('ignores whitespace and escaped spelling while retaining scalar types', () => {
    expect(compareJson('{"a":"a"}', '{ "\\u0061": "\\u0061" }').changes).toEqual([]);
    expect(compareJson('[1,null,true]', '["1","null","true"]').rows.map(row => row.kind)).toEqual(['changed', 'changed', 'changed']);
  });
  it('never rounds integers or overflow to equality', () => {
    expect(compareJson('9007199254740992', '9007199254740993').changes).toEqual([0]);
    expect(compareJson('1e400', '2e400').changes).toEqual([0]);
    expect(compareJson('1.00e2', '100').changes).toEqual([]);
    expect(compareJson('-0', '0.000').changes).toEqual([]);
  });
  it('compares arrays by index without inventing movement', () => {
    expect(compareJson('[1,2]', '[2,1,3]').rows.map(row => [row.kind, row.path])).toEqual([['changed', '$[0]'], ['changed', '$[1]'], ['added', '$[2]']]);
  });
  it('marks missing keys separately from null and keeps special keys', () => {
    expect(compareJson('{"a":null,"__proto__":2}', '{"__proto__":3}').rows.map(row => [row.kind, row.path])).toEqual([['removed', '$["a"]'], ['changed', '$["__proto__"]']]);
  });
  it('compares beyond the bounded display preview', () => {
    const a = JSON.stringify('x'.repeat(500) + 'a'), b = JSON.stringify('x'.repeat(500) + 'b');
    expect(compareJson(a, b).changes).toEqual([0]);
    expect(compareJson(a, b).rows[0].left!.length).toBe(181);
  });
  it('bounds display paths without changing key equality', () => {
    const key = 'x'.repeat(2000);
    const a = JSON.stringify({[key]: {child: 1}}), b = JSON.stringify({[key]: {child: 2}});
    const result = compareJson(a, b);
    expect(result.changes).toEqual([0]); expect(result.rows[0].path!.length).toBeLessThanOrEqual(1024);
  });
  it('rejects invalid JSON, trailing commas and duplicate decoded keys', () => {
    for (const text of ['{"a":1,"\\u0061":2}', '[1,]', '01', 'true false', '"x\n"', '']) expect(() => compareJson(text, '{}')).toThrow('json');
  });
  it('bounds depth and nodes before recursion or allocation becomes unbounded', () => {
    expect(() => compareJson('1e' + '9'.repeat(100), '1')).toThrow('limit');
    expect(() => compareJson('['.repeat(130) + '0' + ']'.repeat(130), 'null')).toThrow('limit');
    expect(() => compareJson('[' + Array(20000).fill('0').join(',') + ']', '[]')).toThrow('limit');
  });
});

it('discarded comparison requests never become current again', () => {
  const requests = new CompareRequests(), first = requests.begin(), second = requests.begin();
  expect(requests.current(first)).toBe(false); expect(requests.current(second)).toBe(true);
  requests.cancel(); expect(requests.current(second)).toBe(false);
});
