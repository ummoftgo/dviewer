import { tick } from 'svelte';
import { t, type MessageKey } from '../../i18n';
import { docSourceText } from '../../ipc';
import type { DocTab } from '../../state/docs.svelte';
import { settings } from '../../state/settings.svelte';

async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 16));
  }
}

export async function checkTextReading(tab: DocTab): Promise<void> {
  const mode = tab.mode;
  const savedWidthMode = settings.tableWidthMode;
  const tabWidthMode = tab.tableWidthMode;
  const base = [...tab.columnWidths], ratios = tab.tableFillRatios;
  try {
    settings.tableWidthMode = 'fill';
    tab.tableWidthMode = 'fill';
    tab.mode = 'rendered';
    await tick();
    await waitFor(() => document.querySelector<HTMLElement>('main .grid')?.dataset.widthMode === 'fill'
      && document.querySelector<HTMLElement>('main .grid')?.dataset.fitted === 'true', 'text grid width did not settle');
    const grid = document.querySelector<HTMLElement>('main .grid')!;
    const head = grid.querySelector<HTMLElement>('.head')!;
    if (Math.abs(head.getBoundingClientRect().width - grid.clientWidth) > 1) throw new Error('text grid did not fill its viewport');
    const cut = grid.querySelector<HTMLElement>('[role="gridcell"][data-truncated="true"]');
    if (!cut || cut.title !== t('grid.previewText', { chars: 1000 })) throw new Error('truncated text preview did not explain its limit');
    cut.click(); await tick();
    if (document.querySelector('.preview-badge')?.textContent !== t('grid.previewChars', { chars: 1000 })) throw new Error('selected text preview did not show its badge');
    grid.querySelector<HTMLElement>('[role="gridcell"]')!.click(); await tick();
    if (document.querySelector('.preview-badge')) throw new Error('preview badge survived a complete cell selection');
    const choose = async (key: MessageKey) => {
      head.querySelectorAll<HTMLElement>('[role="columnheader"]')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await tick();
      const button = [...document.querySelectorAll<HTMLButtonElement>('.menu button')].find(button => button.querySelector('.label')?.textContent === t(key));
      if (!button) throw new Error('text grid width action missing: ' + key);
      button.click(); await tick();
      await waitFor(() => grid.dataset.fitted === 'true', 'width action did not settle');
    };
    for (const key of ['grid.fitColumn', 'grid.recommendWidths'] as const) {
      await choose(key);
      if (tab.columnWidths[0] <= 420 || tab.columnWidths[0] > 8000) throw new Error('explicit width did not lift the automatic ceiling');
    }
    await choose('grid.resetWidths');
    if (tab.columnWidths[0] > 420 || Math.abs(head.getBoundingClientRect().width - grid.clientWidth) > 1) throw new Error('width reset did not restore automatic fill');
    const expected = await docSourceText(tab.id);
    if (!document.querySelector('[data-action="table-width"]')) throw new Error('text table width menu missing');
    const raw = document.querySelector<HTMLButtonElement>('[data-action="view-raw"]');
    if (!raw) throw new Error('text toolbar has no raw switch');
    raw.click();
    const expectedLines = expected.replace(/\r\n/g, '\n').split('\n');
    await waitFor(() => document.querySelector<HTMLElement>('.text-raw-view')?.dataset.total === String(expectedLines.length),
      'text raw source did not finish loading');
    const actual = [...document.querySelectorAll('.text-raw-view .line-text')].map(line => line.textContent);
    if (document.querySelector('[data-action="table-width"]')) throw new Error('table width menu appeared in raw mode');
    const numbers = [...document.querySelectorAll('.text-raw-view .line-number')].map(line => line.textContent);
    if (JSON.stringify(actual) !== JSON.stringify(expectedLines)) throw new Error('text raw source lines changed');
    if (numbers.length !== expectedLines.length || numbers.at(-1) !== String(expectedLines.length)) throw new Error('text raw line numbers changed');
    document.querySelector<HTMLButtonElement>('[data-action="view-rendered"]')!.click();
    await waitFor(() => document.querySelector('main [role="grid"]') !== null, 'text did not return to its table');
  } finally {
    settings.tableWidthMode = savedWidthMode;
    tab.tableWidthMode = tabWidthMode;
    tab.columnWidths = base; tab.tableFillRatios = ratios;
    tab.mode = mode;
    await tick();
  }
}

export async function checkTextRawVirtual(tab: DocTab): Promise<void> {
  const mode = tab.mode, scrollTop = tab.rawScrollTop;
  const query = tab.textSearch.query, current = tab.textSearch.current;
  const total = 17 * 1024 * 1024 / 128;
  try {
    if (tab.view !== 'table' || tab.tableStats?.rowCount !== total) throw new Error('big log did not open as a complete table');
    await waitFor(() => document.querySelector('main [role="grid"]') !== null, 'big log table did not render');
    document.querySelector<HTMLButtonElement>('[data-action="view-raw"]')!.click();
    await waitFor(() => document.querySelector<HTMLElement>('.text-raw-view')?.dataset.total === String(total), 'big raw total did not settle');
    const viewport = document.querySelector<HTMLElement>('.text-raw-view')!;
    if (tab.raw !== null || viewport.querySelectorAll('.raw-line').length > 2000) throw new Error('raw view materialised the document');
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event('scroll'));
    await waitFor(() => viewport.dataset.range?.split('-')[1] === String(total - 1), 'raw scrolling did not reach the last line');
    if (viewport.querySelector('.raw-line:last-child .line-number')?.textContent !== String(total)) throw new Error('last raw line number changed');
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await waitFor(() => viewport.dataset.range?.split('-')[0] === '0' && viewport.scrollTop === 0, 'raw view did not return to the top');
    const input = document.querySelector<HTMLInputElement>('.raw-searchbar input[type="search"]')!;
    input.value = 'M35-LAST-UNIQUE';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => tab.textSearch.current === total - 1
      && viewport.dataset.range?.split('-')[1] === String(total - 1)
      && viewport.scrollTop > 0
      && viewport.querySelector('.found mark')?.textContent === 'm35-last-unique', 'raw find did not navigate and highlight the last content line');
    document.querySelector<HTMLButtonElement>('[data-action="view-rendered"]')!.click();
    await waitFor(() => document.querySelector('main [role="grid"]') !== null, 'big log did not return to table');
  } finally {
    tab.mode = mode; tab.rawScrollTop = scrollTop;
    tab.textSearch.query = query; tab.textSearch.current = current;
    await tick();
  }
}

/** The long value in `cell-detail.csv`; the generator keeps it at this length. */
const CELL_DETAIL_LONG = 5000;

/**
 * The cell detail panel, opened the way a reader opens it: select a cell, press
 * the toolbar button. Whether the panel was open is decided here and put back
 * afterwards, and every assertion is on what the panel drew, after it said the
 * value on screen is the selected cell's.
 */
export async function checkCellDetail(tab: DocTab): Promise<{ valueLength: number }> {
  const shown = tab.showCellDetail, selected = tab.selectedCell;
  try {
    tab.showCellDetail = false;
    tab.selectedCell = null;
    await tick();
    const rows = () => document.querySelectorAll<HTMLElement>('main .grid .body .row');
    await waitFor(() => rows().length >= 7, 'cell detail grid did not render');
    const cell = (row: number) => rows()[row].querySelector<HTMLElement>('[role="gridcell"][data-column="1"]')!;
    const panel = () => document.querySelector<HTMLElement>('main .cell-detail');
    if (cell(0).dataset.truncated !== 'true') throw new Error('long cell was not a cut preview');
    cell(0).click();
    await tick();
    const toggle = document.querySelector<HTMLButtonElement>('[data-action="cell-detail"]');
    if (!toggle) throw new Error('grid toolbar has no cell detail button');
    toggle.click();
    await waitFor(() => panel()?.dataset.ready === 'true', 'cell detail did not read the long value');
    const valueLength = panel()!.querySelector('.value')?.textContent?.length ?? -1;
    if (panel()!.dataset.kind !== 'value' || valueLength !== CELL_DETAIL_LONG) {
      throw new Error(`cell detail showed ${valueLength} of ${CELL_DETAIL_LONG} characters`);
    }
    const expect = async (row: number, kind: string) => {
      cell(row).click();
      await waitFor(() => panel()?.dataset.ready === 'true' && panel()?.dataset.kind === kind, `row ${row + 1} did not read as ${kind}`);
    };
    await expect(1, 'empty');
    await expect(2, 'empty');
    await expect(3, 'missing');
    await expect(4, 'value');
    if (!panel()!.querySelector('[data-action="cell-json"]')) throw new Error('a JSON value offered no JSON view');
    panel()!.querySelector<HTMLButtonElement>('[data-action="cell-detail-close"]')!.click();
    await tick();
    if (panel() || tab.showCellDetail) throw new Error('cell detail did not close');
    return { valueLength };
  } finally {
    tab.showCellDetail = shown;
    tab.selectedCell = selected;
    await tick();
  }
}
