import { expect, test } from 'vitest';
import { htmlClipboardPayload } from './clipboard';
import { i18n, t, type LocaleSetting } from './i18n';

test.each(['<h1>제목</h1><p>한글😀 &amp; text</p>', '<pre><code>&lt;tag&gt;</code></pre>', ''])('HTML copy supplies HTML source to editors: %s', (html) => {
  expect(htmlClipboardPayload(html)).toEqual({ 'text/html': html, 'text/plain': html });
});

test.each([
  ['ko', '원문 복사됨', 'HTML 복사됨'], ['en', 'Source copied', 'HTML copied'],
  ['ja', '原文をコピーしました', 'HTML をコピーしました'], ['zh-Hans', '已复制原文', '已复制 HTML'],
])('copy confirmations distinguish source and HTML in %s', (locale, raw, html) => {
  const previous = i18n.setting;
  try {
    i18n.setting = locale as LocaleSetting;
    expect(t('markdown.copy.rawDone')).toBe(raw);
    expect(t('markdown.copy.htmlDone')).toBe(html);
  } finally { i18n.setting = previous; }
});
