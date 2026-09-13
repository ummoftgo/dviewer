import { expect, test } from 'vitest';
import { nextFocusMode } from './focusMode';
import { i18n, t } from './i18n';

test('F11 toggles the window state and an unhandled Escape exits', () => {
  expect(nextFocusMode(false, 'F11')).toBe(true);
  expect(nextFocusMode(true, 'F11')).toBe(false);
  expect(nextFocusMode(true, 'Escape')).toBe(false);
  expect(nextFocusMode(false, 'Escape')).toBe(false);
});

test('the view consumes its first Escape before the app may exit on the next one', () => {
  let focused = nextFocusMode(false, 'F11');
  focused = nextFocusMode(focused, 'Escape', true);
  expect(focused).toBe(true);
  expect(nextFocusMode(focused, 'Escape')).toBe(false);
});

test('unrelated and consumed keys leave focus mode unchanged', () => {
  expect(nextFocusMode(true, 'f')).toBe(true);
  expect(nextFocusMode(false, 'F11', true)).toBe(false);
});

test('the entry hint is a complete sentence', () => {
  const locale = i18n.setting; i18n.setting = 'ko';
  try { expect(t('focus.exitHint')).toBe('Esc로 집중 모드를 나갑니다.'); }
  finally { i18n.setting = locale; }
});
