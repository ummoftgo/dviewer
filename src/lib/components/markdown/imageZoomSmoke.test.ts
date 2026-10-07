import { describe, expect, it } from 'vitest';
import { imageThemeRenderReady } from './imageZoomSmoke';

describe('image zoom theme render readiness', () => {
  it('rejects the old ready node before the theme effect replaces the article', () => {
    const previous = {};
    expect(imageThemeRenderReady(previous, previous, true, false)).toBe(false);
    expect(imageThemeRenderReady(previous, {}, true, false)).toBe(true);
  });

  it('requires post-processing readiness and a closed overlay', () => {
    const previous = {}, replacement = {};
    // The caller only supplies the current SVG beneath data-position-ready.
    // MarkdownView sets that marker after both Mermaid and KaTeX have finished.
    expect(imageThemeRenderReady(previous, null, true, false)).toBe(false);
    expect(imageThemeRenderReady(previous, replacement, true, true)).toBe(false);
    expect(imageThemeRenderReady(previous, replacement, true, false)).toBe(true);
  });

  it('allows restoring an unchanged resolved theme without requiring a rerender', () => {
    const previous = {};
    expect(imageThemeRenderReady(previous, previous, false, false)).toBe(true);
    expect(imageThemeRenderReady(previous, null, false, false)).toBe(false);
    expect(imageThemeRenderReady(previous, previous, false, true)).toBe(false);
  });

  it('does not finish theme restoration between the old ready DOM and async MathML rendering', async () => {
    const previous = {}, replacement = {};
    let ready: object | null = previous;
    let mathml = true;
    let rendered!: () => void;
    const postProcessing = new Promise<void>(resolve => { rendered = resolve; });
    // Match MarkdownView: the theme setter queues an effect, the effect resets
    // innerHTML synchronously, then awaits Mermaid + KaTeX before marking ready.
    queueMicrotask(() => {
      ready = null;
      mathml = false;
      void postProcessing.then(() => { mathml = true; ready = replacement; });
    });
    let finished = false;
    // Like waitSearch, check synchronously before waiting for the next frame.
    const waiting = (async () => {
      while (!imageThemeRenderReady(previous, ready, true, false)) await Promise.resolve();
      finished = true;
    })();
    await Promise.resolve();
    expect(ready).toBeNull();
    expect(mathml).toBe(false);
    expect(finished).toBe(false);
    rendered();
    await waiting;
    expect(ready).toBe(replacement);
    expect(mathml).toBe(true);
    expect(finished).toBe(true);
  });
});
