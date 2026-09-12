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
      if (tab.columnWidths[0] <= 420 || tab.columnWidths[0] > 4000) throw new Error('explicit width did not lift the automatic ceiling');
    }
    await choose('grid.resetWidths');
    if (tab.columnWidths[0] > 420 || Math.abs(head.getBoundingClientRect().width - grid.clientWidth) > 1) throw new Error('width reset did not restore automatic fill');
    const expected = await docSourceText(tab.id);
    const raw = document.querySelector<HTMLButtonElement>('[data-action="view-raw"]');
    if (!raw) throw new Error('text toolbar has no raw switch');
    raw.click();
    await waitFor(() => document.querySelector('.raw-view .source')?.textContent === expected,
      'text raw source did not finish loading');
    const numbers = document.querySelector('.raw-view .gutter')?.textContent?.split('\n') ?? [];
    const lines = expected.split('\n').length;
    if (numbers.length !== lines || numbers.at(-1) !== String(lines)) throw new Error('text raw line numbers changed');
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
