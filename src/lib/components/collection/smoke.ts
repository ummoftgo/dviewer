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
    }
  } finally {
    settings.tableWidthMode = saved.widthMode; settings.docFontPx = saved.font; settings.uiScale = saved.scale;
    tab.tableWidthMode = saved.tabWidthMode;
    await tick();
    try { if (saved.collection && saved.collection !== tab.collection && !tab.error) await select(saved.collection); }
    finally { tab.columnWidths = saved.widths; tab.tableFillRatios = saved.ratios; await tick(); }
  }
}
