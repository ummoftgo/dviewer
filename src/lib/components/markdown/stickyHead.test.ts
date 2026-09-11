import { expect, test } from 'vitest';
import { scrollTranslate } from './stickyHead';

test('the copied header moves opposite to the viewport scroll, including fractional offsets', () => {
  expect(scrollTranslate(125)).toBe('translateX(-125px)');
  expect(scrollTranslate(0.5)).toBe('translateX(-0.5px)');
  expect(scrollTranslate(-20)).toBe('translateX(20px)');
  expect(scrollTranslate(0)).toBe('translateX(0px)');
});
