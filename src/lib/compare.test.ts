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

describe('comparison boundary regressions', () => {
  it('accepts exact byte and line limits, counts UTF-8 bytes, and bounds direct line callers', () => {
    const exact = 'x'.repeat(COMPARE_MAX_BYTES);
    expect(sourceLines(exact)).toEqual([exact]);
    expect(compareLines([exact], [exact]).changes).toEqual([]);
    expect(() => compareLines([exact + 'x'], [''])).toThrow('limit');
    expect(() => compareLines(['😀'.repeat(COMPARE_MAX_BYTES / 4) + 'x'], [''])).toThrow('limit');
    expect(sourceLines('\n'.repeat(COMPARE_MAX_LINES - 1)).length).toBe(COMPARE_MAX_LINES);
    for (const value of [NaN, Infinity, -1]) expect(() => checkCompareSize(value)).toThrow('limit');
  });
  it('accepts exactly one million LCS cells and rejects the next square', () => {
    expect(compareLines(Array(999).fill('a'), Array(999).fill('b')).changes.length).toBe(999);
    expect(() => compareLines(Array(1000).fill('a'), Array(1000).fill('b'))).toThrow('complexity');
  });
  it('retains full original strings and detects a change after thousands of identical characters', () => {
    const first = 'x'.repeat(5000) + '\t"original"', second = 'x'.repeat(5000) + '\t"changed"';
    expect(compareLines([first], [second]).rows[0]).toMatchObject({kind:'changed', left:first, right:second});
  });
  it('preserves both source sequences and optimal edit counts with duplicate lines', () => {
    const inputs: string[][] = [[]];
    for (let length = 1; length <= 4; length++) for (let mask = 0; mask < 2 ** length; mask++) inputs.push(Array.from({length},(_,index) => mask & (1 << index) ? 'a' : 'b'));
    for (const left of inputs) for (const right of inputs) {
      const rows = compareLines(left,right).rows;
      expect(rows.flatMap(row => row.left === null ? [] : [row.left])).toEqual(left);
      expect(rows.flatMap(row => row.right === null ? [] : [row.right])).toEqual(right);
      const distance = Array.from({length:left.length+1},() => Array(right.length+1).fill(0));
      for (let i = 0; i <= left.length; i++) distance[i][0] = i;
      for (let j = 0; j <= right.length; j++) distance[0][j] = j;
      for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) distance[i][j] = left[i-1] === right[j-1] ? distance[i-1][j-1] : Math.min(distance[i-1][j]+1,distance[i][j-1]+1);
      expect(rows.reduce((sum,row) => sum+(row.kind === 'same' ? 0 : row.kind === 'changed' ? 2 : 1),0)).toBe(distance[left.length][right.length]);
    }
  });
  it('accepts exact JSON node/depth limits and refuses their first overflow', () => {
    const nodes = '[' + Array(19999).fill('0').join(',') + ']';
    expect(compareJson(nodes, nodes).changes).toEqual([]);
    expect(() => compareJson('[' + Array(20000).fill('0').join(',') + ']', '[]')).toThrow('limit');
    const depth = '['.repeat(128) + '0' + ']'.repeat(128);
    expect(compareJson(depth, depth).changes).toEqual([]);
    expect(() => compareJson('['.repeat(129) + '0' + ']'.repeat(129), 'null')).toThrow('limit');
  });
  it('compares huge internal zero runs in one pass without truncating their last significant digit', () => {
    const prefix = '1' + '0'.repeat(100000);
    expect(compareJson(prefix + '1', prefix + '2').changes).toEqual([0]);
    expect(compareJson(prefix + '10', prefix + '1e1').changes).toEqual([]);
  });
  it('normalizes decimal signs and exponent offsets exactly, including tiny differences', () => {
    for (const [a,b] of [['-1.23400e+4','-12340'],['1e-400','10e-401'],['0e-9999999999','-0.000'],['1e+0000000009','1000000000']]) expect(compareJson(a,b).changes).toEqual([]);
    expect(compareJson('0.123456789012345678901','0.123456789012345678902').changes).toEqual([0]);
    expect(compareJson('1e9999999999','10e9999999998').changes).toEqual([]);
    for (const value of ['1e10000000000','0e10000000000']) expect(() => compareJson(value,'0')).toThrow('limit');
  });
  it('rejects duplicate keys inside nested objects but permits matching keys in separate objects', () => {
    expect(() => compareJson('{"a":{"b":1,"\\u0062":2}}','{}')).toThrow('json');
    expect(compareJson('[{"a":1},{"a":1}]','[{"a":1},{"a":1}]').changes).toEqual([]);
    expect(compareJson('{"é":1,"é":2}','{"é":1,"é":2}').changes).toEqual([]);
  });
  it('distinguishes nested ordering from array position changes and deletion', () => {
    expect(compareJson('[{"a":1,"b":2},3]','[{"b":2,"a":1}]').rows.map(row => [row.kind,row.path])).toEqual([['order','$[0]'],['removed','$[1]']]);
  });
  it('guards both document generations as well as replacement and cancellation tickets', () => {
    const requests = new CompareRequests(); let a: number | undefined = 4, b: number | undefined = 9;
    const ticket = requests.begin(), current = requests.guard(ticket, () => a, () => b);
    expect(current()).toBe(true); a = 5; expect(current()).toBe(false); a = 4; b = 10; expect(current()).toBe(false);
    b = 9; expect(current()).toBe(true); requests.cancel(); expect(current()).toBe(false);
    const replacement = requests.guard(requests.begin(), () => a, () => b);
    expect(replacement()).toBe(true); b = undefined; expect(replacement()).toBe(false);
  });
});
