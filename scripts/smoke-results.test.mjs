import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResults } from './smoke-results.mjs';

test('a listening row is visible only after its newline, at every split position', () => {
  const row = JSON.stringify({ ok: true, step: 'listening', text: '한글😀' }) + '\n';
  for (let split = 0; split < row.length; split++) {
    assert.deepEqual(parseResults(row.slice(0, split), true), { lines: [], summary: null });
  }
  assert.equal(parseResults(row, true).lines[0].step, 'listening');
});

test('a partial summary preserves earlier complete rows until it is committed', () => {
  const first = '{"ok":true,"step":"listening"}\n';
  assert.deepEqual(parseResults(first + '{"summary":', true), { lines: [{ ok: true, step: 'listening' }], summary: null });
  assert.deepEqual(parseResults(first + '{"summary":{"failed":0}}\n', true).summary, { failed: 0 });
});

test('completed malformed lines and a truncated final result are not hidden', () => {
  assert.throws(() => parseResults('{"ok\n', true), SyntaxError);
  assert.throws(() => parseResults('{"ok'), SyntaxError);
  assert.equal(parseResults('{"ok":true}').lines[0].ok, true);
});
