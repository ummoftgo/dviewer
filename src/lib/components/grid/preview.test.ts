import { expect, test } from 'vitest';
import { i18n } from '../../i18n';
import { cellTitle, previewBadge, selectedCell } from './preview';

test('preview hints name the real limit and only Text offers source view', () => {
  const old = i18n.setting; i18n.setting = 'ko';
  try {
    expect(cellTitle({ text: 'short', truncated: false }, 'text')).toBe('short');
    expect(cellTitle({ null: true, truncated: false }, 'sqlite')).toBe('NULL');
    expect(cellTitle({ truncated: true }, 'text')).toBe('미리보기는 1000자까지입니다. 값 복사(최대 8 MiB)나 원문 보기로 더 많은 내용을 확인할 수 있습니다.');
    for (const kind of ['csv', 'jsonl', 'sqlite', 'xlsx', 'parquet', 'treeTable'] as const) {
      expect(cellTitle({ truncated: true }, kind)).toBe('미리보기는 1000자까지입니다. 값 복사(최대 8 MiB)로 더 많은 내용을 확인할 수 있습니다.');
    }
    expect(cellTitle({ truncated: true, previewBytes: 16 }, 'sqlite')).toBe('바이너리 미리보기는 16바이트까지입니다. 값 복사(최대 8 MiB)로 더 많은 내용을 확인할 수 있습니다.');
  } finally { i18n.setting = old; }
});

test('only a truncated selection has a badge with its own unit', () => {
  const old = i18n.setting; i18n.setting = 'ko';
  try {
    expect(previewBadge()).toBeNull();
    expect(previewBadge({ truncated: false })).toBeNull();
    expect(previewBadge({ truncated: true })).toBe('잘린 미리보기 · 1000자');
    expect(previewBadge({ truncated: true, previewBytes: 16 })).toBe('잘린 미리보기 · 16바이트');
  } finally { i18n.setting = old; }
});

test('selection retains offscreen preview metadata but refreshes or clears it for new data', () => {
  const first = selectedCell(null, 2, 0, { index: 15, cells: [{ text: 'long', truncated: true, previewBytes: 16 }] });
  expect(selectedCell(first, 2, 0)).toEqual(first);
  const refreshed = selectedCell(first, 2, 0, { index: 8, cells: [{ text: 'short', truncated: false }] });
  expect(refreshed.sourceRow).toBe(8); expect(previewBadge(refreshed.preview)).toBeNull();
  expect(selectedCell(first, 3, 0).preview).toBeUndefined();
  expect(selectedCell(first, 2, 1).preview).toBeUndefined();
});
