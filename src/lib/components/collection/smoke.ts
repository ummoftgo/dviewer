import { tick } from 'svelte';
import { t } from '../../i18n';
import type { DocTab } from '../../state/docs.svelte';
import { settings } from '../../state/settings.svelte';

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 16));
  }
}

export async function checkCollectionWidths(tab: DocTab): Promise<void> {
  const grid = () => document.querySelector<HTMLElement>('main .collection .grid');
  const picker = () => document.querySelector<HTMLSelectElement>('main .collection .picker select');
  const settled = () => !!tab.gridStats && !picker()?.disabled
    && grid()?.dataset.fitted === 'true'
    && tab.columnWidths.length === tab.gridStats.columnCount
    && grid()?.getAttribute('aria-colcount') === String(tab.gridStats.columnCount)
    && (tab.gridStats.rowCount === 0 || !!grid()?.querySelector('.body .row'));
  await waitFor(() => !!picker() && settled(), 'collection did not finish its first page');
  const saved = { widthMode: settings.tableWidthMode, font: settings.docFontPx, scale: settings.uiScale,
    tabWidthMode: tab.tableWidthMode, collection: tab.collection, widths: [...tab.columnWidths], ratios: tab.tableFillRatios };
  const select = async (name: string) => {
    const control = picker();
    if (!control || control.disabled) throw new Error('collection picker is not ready');
    control.value = name;
    control.dispatchEvent(new Event('change', { bubbles: true }));
    if (tab.columnWidths.length || tab.tableFillRatios !== null) throw new Error('collection switch retained previous widths or ratios');
    await tick();
    await waitFor(() => tab.collection === name && settled(), 'selected collection did not finish layout: ' + name);
  };
  const saveDescriptor = Object.getOwnPropertyDescriptor(settings, 'save');
  const savedModes: string[] = [];
  Object.defineProperty(settings, 'save', { configurable: true, value: () => { savedModes.push(settings.tableWidthMode); } });
  const toolbarWidth = async (mode: 'fill' | 'scroll') => {
    const button = document.querySelector<HTMLButtonElement>('[data-action="table-width"]');
    if (!button) throw new Error('collection toolbar width menu missing');
    button.click(); await tick();
    const options = () => [...document.querySelectorAll<HTMLButtonElement>('.menu button')];
    const marked = (option: HTMLButtonElement) => option.querySelector('.mark')?.textContent === '✓';
    const label = (mode: 'fill' | 'scroll') => t(mode === 'fill' ? 'settings.tableWidth.fill' : 'settings.tableWidth.scroll');
    if (options().filter(marked).length !== 1 || !options().some(option => marked(option) && option.querySelector('.label')?.textContent === label(tab.tableWidthMode))) {
      throw new Error('table width check does not match the current tab');
    }
    const target = options().find(option => option.querySelector('.label')?.textContent === label(mode));
    if (!target) throw new Error('table width option missing: ' + mode);
    const calls = savedModes.length;
    target.click(); await tick();
    await waitFor(() => grid()?.dataset.widthMode === mode && settled(), 'toolbar width did not settle: ' + mode);
    if (tab.tableWidthMode !== mode || settings.tableWidthMode !== mode || savedModes.length !== calls + 1 || savedModes.at(-1) !== mode) {
      throw new Error('toolbar width did not apply and save its choice');
    }
    button.click(); await tick();
    if (options().filter(marked).length !== 1 || !options().some(option => marked(option) && option.querySelector('.label')?.textContent === label(mode))) {
      throw new Error('table width check did not update');
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
  };
  try {
    settings.tableWidthMode = 'fill'; settings.docFontPx = 12; settings.uiScale = 1;
    tab.tableWidthMode = 'fill';
    await tick();
    for (const item of tab.collections.slice(0, 2)) {
      tab.tableFillRatios = tab.columnWidths.map((_, i) => i === 0 ? 99 : 1);
      await select(item.name);
      const host = grid()!;
      const head = host.querySelector<HTMLElement>('.head')!;
      if (host.dataset.widthMode !== 'fill' || Math.abs(head.getBoundingClientRect().width - host.clientWidth) > 1) {
        throw new Error('collection did not fill its viewport: ' + item.name);
      }
      head.querySelectorAll<HTMLElement>('[role="columnheader"]')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await tick();
      for (const key of ['grid.fitColumn', 'grid.recommendWidths', 'grid.resetWidths'] as const) {
        if (![...document.querySelectorAll('.menu button .label')].some(label => label.textContent === t(key))) {
          throw new Error('collection width action missing: ' + key);
        }
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await tick();
      // A mode choice remeasures even a width that was previously dragged.
      tab.columnWidths = tab.columnWidths.map(() => 399);
      tab.tableFillRatios = tab.columnWidths.map(() => 1);
      await toolbarWidth('scroll');
      const gutter = head.querySelector<HTMLElement>('.num')!.getBoundingClientRect().width;
      const natural = gutter + tab.columnWidths.reduce((sum, width) => sum + width, 0);
      if (tab.tableFillRatios !== null || tab.columnWidths.every(width => width === 399)
        || Math.abs(head.getBoundingClientRect().width - natural) > 1 || natural >= host.clientWidth - 1) {
        throw new Error('toolbar scroll did not remeasure natural widths');
      }
      await toolbarWidth('fill');
      if (tab.columnWidths.some(width => width > 420) || Math.abs(head.getBoundingClientRect().width - host.clientWidth) > 1) {
        throw new Error('toolbar fill did not remeasure and fill its viewport');
      }
      const cells = [...head.querySelectorAll<HTMLElement>('[role="columnheader"]')].slice(1);
      const grip = cells[0].querySelector<HTMLElement>('.grip')!;
      const before = cells.slice(0, 2).map(cell => cell.getBoundingClientRect().width);
      grip.focus();
      if (document.activeElement !== grip) throw new Error('grid resize grip is not focusable');
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await tick(); await waitFor(settled, 'keyboard resize did not settle');
      if (Math.abs(cells[0].getBoundingClientRect().width - before[0] - 8) > 1
        || Math.abs(cells[1].getBoundingClientRect().width - before[1] + 8) > 1) {
        throw new Error('keyboard resize did not compensate its neighbor');
      }
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick(); await waitFor(settled, 'keyboard fit did not settle');
      const fitted = cells[0].getBoundingClientRect().width;
      if (Math.abs(fitted - tab.columnWidths[0]) > 1 || Math.abs(head.getBoundingClientRect().width - host.clientWidth) > 1) {
        throw new Error('keyboard fit did not keep fill while fitting content');
      }
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      await tick();
      grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await tick(); await waitFor(settled, 'double-click fit did not settle');
      if (Math.abs(cells[0].getBoundingClientRect().width - fitted) > 1) throw new Error('Enter and double-click fit differ');
    }
  } finally {
    try {
      settings.tableWidthMode = saved.widthMode; settings.docFontPx = saved.font; settings.uiScale = saved.scale;
      tab.tableWidthMode = saved.tabWidthMode;
      await tick();
      if (saved.collection && saved.collection !== tab.collection && !tab.error) await select(saved.collection);
    } finally {
      tab.columnWidths = saved.widths; tab.tableFillRatios = saved.ratios;
      if (saveDescriptor) Object.defineProperty(settings, 'save', saveDescriptor);
      else Reflect.deleteProperty(settings, 'save');
      await tick();
    }
  }
}
