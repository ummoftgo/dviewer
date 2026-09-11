import { expect, test } from 'vitest';
import { inlineStyles, limitStyledHtml, rootThemeStyles, STYLED_HTML_LIMIT } from './styledCopy';

test('the export root keeps theme tokens even when measured styles equal browser defaults', () => {
  const measured = { color: 'rgb(0, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)', 'font-family': 'serif' };
  const tokens: Record<string, string> = { '--text': ' #16191d ', '--bg': ' #ffffff ', '--font-body': ' "Pretendard", sans-serif ' };
  const theme = rootThemeStyles({ getPropertyValue: property => tokens[property] ?? '' });
  expect(inlineStyles(measured, measured) + theme)
    .toBe('color:#16191d;background-color:#ffffff;font-family:"Pretendard", sans-serif;');
  expect(inlineStyles(measured, measured)).toBe('');
});

test('copy includes only selected styles and drops defaults', () => {
  expect(inlineStyles({ color: 'red', padding: '0px', position: 'fixed', display: 'none' }, { color: 'black', padding: '0px' }))
    .toBe('color:red;');
});
test('inherited theme font and color survive when browser defaults differ', () => {
  expect(inlineStyles({ color: 'rgb(240, 240, 240)', 'font-family': 'Segoe UI', 'font-size': '15px' },
    { color: 'rgb(0, 0, 0)', 'font-family': 'Times New Roman', 'font-size': '16px' }))
    .toBe('color:rgb(240, 240, 240);font-family:Segoe UI;font-size:15px;');
});
test('a colored code span does not need invisible border colors', () => {
  expect(inlineStyles({ color: 'red', 'border-top': '0px none red' }, { color: 'black', 'border-top': '0px none black' }))
    .toBe('color:red;');
});
test('visible cell borders and header backgrounds survive copying', () => {
  expect(inlineStyles({ 'border-top': '1px solid gray', 'background-color': 'rgb(245, 246, 248)' },
    { 'border-top': '0px none black', 'background-color': 'rgba(0, 0, 0, 0)' }))
    .toBe('background-color:rgb(245, 246, 248);border-top:1px solid gray;');
});
test('the styled HTML limit counts UTF-8 bytes, including emoji', () => {
  expect(limitStyledHtml('가😀', 'original', 7)).toEqual({ html: '가😀', limited: false });
  expect(limitStyledHtml('가😀', 'original', 6)).toEqual({ html: 'original', limited: true });
  expect(STYLED_HTML_LIMIT).toBe(4194304);
});
