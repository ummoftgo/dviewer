import { expect, test } from 'vitest';
import { localSvgCss, rasterSize } from './imageCopy';

test('raster copies use twice the displayed dimensions', () => {
  expect(rasterSize(320, 180)).toEqual({ width: 640, height: 360, reduced: false });
});
test('either edge caps the image while retaining its aspect ratio', () => {
  expect(rasterSize(5000, 1000)).toEqual({ width: 4096, height: 819, reduced: true });
  expect(rasterSize(500, 2500)).toEqual({ width: 819, height: 4096, reduced: true });
  expect(rasterSize(2048, 2048)).toEqual({ width: 4096, height: 4096, reduced: false });
});
test('hidden and non-finite dimensions cannot produce a clipboard image', () => {
  for (const dimensions of [[0, 10], [10, -1], [Infinity, 10], [10, NaN]]) {
    expect(() => rasterSize(dimensions[0], dimensions[1])).toThrow();
  }
});
test('exported CSS keeps local arrowheads and embedded fonts but drops network URLs', () => {
  expect(localSvgCss('@import "https://example.org/fonts.css"; marker-end:url(#arrow);fill:url("https://example.org/a.svg");src:url(data:font/woff2;base64,AAAA)'))
    .toBe(' marker-end:url("#arrow");fill:none;src:url("data:font/woff2;base64,AAAA")');
});
