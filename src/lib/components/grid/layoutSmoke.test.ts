import { describe, expect, it } from 'vitest';
import { gridDockGeometryError, type GridDockGeometry } from './layoutSmoke';

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
function layout(open = false, empty = false): GridDockGeometry {
  const right = open ? 679 : 1000;
  return {
    dock: box(0, 200, 1000, 720), content: box(0, 200, right, 720),
    toolbar: box(0, 200, right, 234), tools: [box(8, 204, 200, 229), box(208, 204, 340, 229)],
    toolbarInset: { top: 4, bottom: 5 },
    viewport: empty ? null : { box: box(0, 234, right, 720), clientHeight: 486, header: box(0, 234, right, 260) },
    detail: open ? box(680, 200, 1000, 720) : null,
    splitter: open ? box(679, 200, 680, 720) : null,
  };
}

describe('native grid dock geometry assertions', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'accepts a full-height column with detail=%s and empty filter=%s', (open, empty) => {
      expect(gridDockGeometryError(layout(open, empty))).toBeNull();
    });

  it('rejects the tall toolbar and bottom implicit grid row seen in Windows screenshots', () => {
    const broken = layout();
    broken.toolbar.bottom = 670;
    broken.tools = [box(8, 423, 350, 447)];
    broken.viewport = { box: box(0, 670, 1000, 720), clientHeight: 50, header: box(0, 670, 1000, 696) };
    expect(gridDockGeometryError(broken)).toBe('range toolbar grew beyond its controls');
  });

  it('rejects a content-sized viewport that leaves blank space under the grid', () => {
    const broken = layout();
    broken.viewport!.box.bottom = 290;
    broken.viewport!.clientHeight = 56;
    expect(gridDockGeometryError(broken)).toBe('grid viewport does not fill the space below its toolbar');
  });

  it('rejects a collapsed viewport or displaced sticky header independently', () => {
    const broken = layout();
    broken.viewport!.clientHeight = 52;
    expect(gridDockGeometryError(broken)).toBe('grid viewport is too short or its header is displaced');
    broken.viewport!.clientHeight = 486;
    broken.viewport!.header.top += 25;
    broken.viewport!.header.bottom += 25;
    expect(gridDockGeometryError(broken)).toBe('grid viewport is too short or its header is displaced');
  });

  it('allows intrinsically wrapped controls in a narrow column', () => {
    const wrapped = layout(true);
    wrapped.content.right = wrapped.toolbar.right = 280;
    wrapped.toolbar.bottom = 263;
    wrapped.tools = [box(8, 204, 200, 229), box(8, 233, 140, 258)];
    wrapped.viewport = { box: box(0, 263, 280, 720), clientHeight: 457, header: box(0, 263, 280, 289) };
    wrapped.splitter = box(280, 200, 281, 720);
    wrapped.detail = box(281, 200, 1000, 720);
    expect(gridDockGeometryError(wrapped)).toBeNull();
    wrapped.tools[1].right = 350;
    expect(gridDockGeometryError(wrapped)).toBe('range controls escaped their toolbar');
  });

  it('rejects detail placement in another row even when the filtered grid is hidden', () => {
    const broken = layout(true, true);
    broken.detail!.top = 400;
    expect(gridDockGeometryError(broken)).toBe('cell detail is not beside the full-height grid column');
  });

  it('rejects a remaining empty panel column after closing detail', () => {
    const broken = layout(true);
    broken.detail = broken.splitter = null;
    expect(gridDockGeometryError(broken)).toBe('closed detail left unused dock width');
  });
});
