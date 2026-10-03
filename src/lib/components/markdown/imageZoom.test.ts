import { describe, expect, it } from 'vitest';
import { clampImage, fitImage, MAX_IMAGE_SCALE, MIN_IMAGE_SCALE, validImageSize, zoomImage } from './imageZoom';

describe('image viewport transforms', () => {
  const image = { width: 1200, height: 800 }, viewport = { width: 600, height: 600 };
  it('fits both axes without enlarging small images', () => {
    expect(fitImage(image, viewport)).toEqual({ scale: 0.5, x: 0, y: 0 });
    expect(fitImage({width:100,height:200}, viewport).scale).toBe(1);
    expect(fitImage({width:100,height:2000}, viewport).scale).toBe(0.3);
  });
  it('rejects missing and non-finite image dimensions safely', () => {
    for (const width of [0, -1, NaN, Infinity]) expect(validImageSize({width,height:20})).toBe(false);
    expect(fitImage({width:0,height:20}, viewport)).toEqual({scale:1,x:0,y:0});
  });
  it('clamps panning and never pans an image smaller than the viewport', () => {
    expect(clampImage({scale:1,x:999,y:-999}, image, viewport)).toEqual({scale:1,x:300,y:-100});
    expect(clampImage({scale:0.5,x:200,y:30}, image, viewport)).toEqual({scale:0.5,x:0,y:0});
  });
  it('preserves the pointer anchor during zoom and limits extreme zoom', () => {
    expect(zoomImage({scale:1,x:0,y:0}, 2, image, viewport, {x:50,y:30})).toEqual({scale:2,x:-50,y:-30});
    expect(zoomImage({scale:1,x:0,y:0}, 1e6, image, viewport).scale).toBe(MAX_IMAGE_SCALE);
    expect(zoomImage({scale:1,x:0,y:0}, 1e-6, image, viewport).scale).toBe(MIN_IMAGE_SCALE);
    expect(zoomImage({scale:1,x:0,y:0}, NaN, image, viewport)).toEqual({scale:1,x:0,y:0});
  });
});
