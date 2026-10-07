import { tick } from 'svelte';
import { t } from '../../i18n';
import type { DocTab } from '../../state/docs.svelte';

type Box = { top: number; bottom: number; left: number; right: number };
export interface GridDockGeometry {
  dock: Box;
  content: Box;
  toolbar: Box;
  tools: Box[];
  toolbarInset: { top: number; bottom: number };
  viewport: { box: Box; clientHeight: number; header: Box } | null;
  detail: Box | null;
  splitter: Box | null;
}

const height = (box: Box) => box.bottom - box.top;
const close = (a: number, b: number) => Math.abs(a - b) <= 2;

/** The assertions consume native DOM geometry. Pure tests only verify that
 * these checks reject the old stretched-toolbar/implicit-row regression. */
export function gridDockGeometryError(layout: GridDockGeometry): string | null {
  const { dock, content, toolbar, tools, toolbarInset, viewport, detail, splitter } = layout;
  if (height(dock) <= 0 || dock.right <= dock.left) return 'dock has no usable area';
  if (!close(content.top, dock.top) || !close(content.bottom, dock.bottom)
    || !close(content.left, dock.left)) return 'grid container does not fill its dock row';
  if (!close(toolbar.top, dock.top) || !close(toolbar.left, content.left)
    || !close(toolbar.right, content.right)) return 'range toolbar is not at the top of the grid column';
  if (!tools.length || !close(Math.min(...tools.map(tool => tool.top)) - toolbar.top, toolbarInset.top)
    || !close(toolbar.bottom - Math.max(...tools.map(tool => tool.bottom)), toolbarInset.bottom)) {
    return 'range toolbar grew beyond its controls';
  }
  if (tools.some(tool => tool.left < toolbar.left - 2 || tool.right > toolbar.right + 2
    || tool.top < toolbar.top - 2 || tool.bottom > toolbar.bottom + 2)) return 'range controls escaped their toolbar';
  if (viewport) {
    if (!close(viewport.box.top, toolbar.bottom) || !close(viewport.box.bottom, content.bottom)
      || !close(viewport.box.left, content.left) || !close(viewport.box.right, content.right)) {
      return 'grid viewport does not fill the space below its toolbar';
    }
    if (height(viewport.header) <= 0 || viewport.clientHeight < height(viewport.header) * 3
      || !close(viewport.header.top, viewport.box.top)) return 'grid viewport is too short or its header is displaced';
  }
  if (detail || splitter) {
    if (!detail || !splitter || !close(detail.top, dock.top) || !close(detail.bottom, dock.bottom)
      || !close(splitter.top, dock.top) || !close(splitter.bottom, dock.bottom)
      || !close(content.right, splitter.left) || !close(splitter.right, detail.left)
      || !close(detail.right, dock.right) || detail.right <= detail.left) return 'cell detail is not beside the full-height grid column';
  } else if (!close(content.right, dock.right)) return 'closed detail left unused dock width';
  return null;
}

function box(element: Element): Box {
  const { top, bottom, left, right } = element.getBoundingClientRect();
  return { top, bottom, left, right };
}

/** A dock resize queues DataGrid's ResizeObserver, then a Svelte width
 * projection. Let both render before checking or handing back to width tests. */
export async function settleGridDockLayout(): Promise<void> {
  await tick();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await tick();
}

/** Only called after native view/form events have settled, including a filter
 * with no results: its grid is hidden, but the column and toolbar must remain. */
export function assertGridDockLayout(tab: DocTab, context: string): GridDockGeometry {
  const dock = document.querySelector<HTMLElement>('main .dock');
  const content = dock?.querySelector<HTMLElement>(':scope > .data-grid');
  const toolbar = content?.querySelector<HTMLElement>(':scope > .range-tools');
  const grid = content?.querySelector<HTMLElement>(':scope > .grid');
  const head = grid?.querySelector<HTMLElement>('.head');
  if (!dock || !content || !toolbar || !grid || !head) throw new Error(context + ': grid and range toolbar must share one dock child');
  const empty = tab.order.stats?.shown === 0;
  if (empty !== (getComputedStyle(grid).display === 'none')) throw new Error(context + ': empty-filter grid visibility changed');
  if (empty && document.querySelector('main p.empty')?.textContent?.trim() !== t('grid.filterEmpty')) {
    throw new Error(context + ': empty-filter message is missing');
  }
  const detail = dock.querySelector<HTMLElement>(':scope > .cell-detail');
  const splitter = dock.querySelector<HTMLElement>(':scope > .dock-splitter');
  if (!!detail !== tab.showCellDetail || !!splitter !== tab.showCellDetail) throw new Error(context + ': detail panel visibility changed');
  if (toolbar.getAttribute('role') !== 'toolbar' || toolbar.getAttribute('aria-label') !== t('gridRange.tools')
    || toolbar.querySelectorAll(':scope > button').length < 4) throw new Error(context + ': range toolbar controls or accessible name are missing');
  const style = getComputedStyle(toolbar);
  const layout: GridDockGeometry = {
    dock: box(dock), content: box(content), toolbar: box(toolbar),
    tools: [...toolbar.children].map(box),
    toolbarInset: { top: parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth),
      bottom: parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth) },
    viewport: empty ? null : { box: box(grid), clientHeight: grid.clientHeight, header: box(head) },
    detail: detail && box(detail), splitter: splitter && box(splitter),
  };
  const error = gridDockGeometryError(layout);
  if (error) throw new Error(context + ': ' + error + ' ' + JSON.stringify(layout));
  return layout;
}

/** Repeated real toggle events guard both filtered states against accidental
 * implicit grid rows, including when display:none removes the viewport. */
export async function checkGridDockDetailStates(tab: DocTab, context: string): Promise<void> {
  const shown = tab.showCellDetail;
  const toggle = document.querySelector<HTMLButtonElement>('main [data-action="cell-detail"]');
  if (!toggle) throw new Error(context + ': detail toggle is missing');
  try {
    for (const open of [false, true, false]) {
      if (tab.showCellDetail !== open) toggle.click();
      await settleGridDockLayout();
      if (tab.showCellDetail !== open) throw new Error(context + ': detail toggle did not change state');
      assertGridDockLayout(tab, context + (open ? ' open' : ' closed'));
    }
  } finally {
    if (tab.showCellDetail !== shown) toggle.click();
    await settleGridDockLayout();
  }
}
