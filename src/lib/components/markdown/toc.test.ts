import { describe, expect, it } from 'vitest';
import { activeHeading } from './toc';

describe('activeHeading', () => {
  it('has no current entry without headings', () => expect(activeHeading([], 30, 16)).toBe(-1));
  it('uses the first heading at the top, including short documents', () => expect(activeHeading([32, 90], 0, 16, true)).toBe(0));
  it('keeps the first entry before its position', () => expect(activeHeading([32, 90], 1, 16)).toBe(0));
  it('selects the heading exactly on the inset boundary', () => expect(activeHeading([32, 90, 200], 74, 16)).toBe(1));
  it('keeps the current section when scrolling between headings', () => {
    expect(activeHeading([32, 900, 1800], 1200, 16)).toBe(1);
    expect(activeHeading([32, 900, 1800], 1700, 16)).toBe(1);
  });
  it('does not cross a boundary more than one CSS pixel early', () => expect(activeHeading([32, 90, 200], 72.5, 16)).toBe(0));
  it('keeps the clicked heading when native scroll rounding stops below the inset', () => {
    expect(activeHeading([32, 16224.719, 16500], 16208.667, 16)).toBe(1);
    expect(activeHeading([32, 90, 200], 73.01, 16)).toBe(1);
  });
  it('selects the last heading at the bottom', () => expect(activeHeading([32, 900], 400, 16, true)).toBe(1));
  it('selects the last equal position and handles one heading', () => {
    expect(activeHeading([32, 90, 90, 200], 74, 16)).toBe(2);
    expect(activeHeading([32], 100, 16)).toBe(0);
  });
});
