import { tick } from 'svelte';
import { gridRangeText, gridCellText, smokeGridExport } from '../../ipc';
import type { DocTab } from '../../state/docs.svelte';
import { waitSearch } from '../markdown/searchSmoke';

/** Uses native view events and IPC; cell-detail.csv supplies full and missing values. */
export async function checkGridRange(tab: DocTab) {
  const order = [...tab.columnOrder], hidden = [...tab.hiddenColumns], selected = tab.selectedCell;
  try {
    const grid = () => document.querySelector<HTMLElement>('main .grid')!;
    const cells = () => [...grid().querySelectorAll<HTMLElement>('.body .row')].map(row => [...row.querySelectorAll<HTMLElement>('[role="gridcell"]')]);
    await waitSearch(() => !!grid() && cells().length >= 7, 'range grid missing');
    cells()[0][0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 }));
    cells()[1][1].dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
    await tick();
    if (grid().querySelectorAll('[aria-selected="true"]').length !== 4) throw new Error('drag did not select a 2 by 2 rectangle');
    grid().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', shiftKey: true }));
    await tick();
    if (grid().querySelectorAll('[aria-selected="true"]').length !== 6) throw new Error('shift arrow lost the range anchor');
    grid().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await tick();
    if (grid().querySelector('[aria-selected="true"]')) throw new Error('Escape did not clear range');
    tab.columnOrder = [2, 1, 0]; tab.hiddenColumns = [0]; await tick();
    cells()[0][0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 }));
    cells()[0][1].dispatchEvent(new PointerEvent('pointerenter', { buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup')); await tick();
    if (grid().querySelectorAll('[aria-selected="true"]').length !== 2) throw new Error('reordered range selected hidden columns');
    const full = await gridRangeText(tab.id,{ start: 0, count: 1, columns: [2, 1], headers: ['kind','value'] });
    const kind = (await gridCellText(tab.id,0,2)).text;
    if (!full.startsWith(`kind\tvalue\n${kind}\t`) || full.split('\n')[1].length < 5000) throw new Error('range copy used preview or source order');
    const blanks = await gridRangeText(tab.id,{start: 1,count:3,columns:[1],headers:['']});
    if (blanks !== '\n\n\n') throw new Error('empty header/empty/missing fields lost row separators');
    const exportMetrics = await smokeGridExport(tab.id);
    return { exportMetrics, selectedCells: 6, fullValueLength: 5000, visibleColumns: 2 };
  } finally {
    tab.columnOrder = order; tab.hiddenColumns = hidden; tab.selectedCell = selected;
    await tick();
  }
}
