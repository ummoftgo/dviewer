import type { ColumnMeasure } from './tables';

/** At most 20 rows, including the first and last. Never clone the whole table. */
export function measureColumns(table: HTMLTableElement, root: HTMLElement): ColumnMeasure[] {
  const host = document.createElement('div');
  host.className = 'markdown-body';
  host.dataset.dviewerUi = 'table-measure';
  host.inert = true;
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;max-width:none';
  const probe = table.cloneNode(false) as HTMLTableElement;
  probe.removeAttribute('id');
  probe.style.cssText = 'display:table;table-layout:auto;max-width:none;overflow:visible;word-break:normal;overflow-wrap:normal';
  probe.style.font = getComputedStyle(table).font;
  const body = probe.createTBody();
  const count = Math.min(20, table.rows.length);
  for (let i = 0; i < count; i++) {
    const index = count === 1 ? 0 : Math.floor(i * (table.rows.length - 1) / (count - 1));
    const row = table.rows[index].cloneNode(true) as HTMLTableRowElement;
    row.removeAttribute('id');
    for (const ui of row.querySelectorAll('[data-dviewer-ui]')) ui.remove();
    for (const element of row.querySelectorAll('[id]')) element.removeAttribute('id');
    for (const cell of row.cells) {
      cell.style.width = '';
      cell.style.minWidth = '';
      cell.style.maxWidth = '';
      cell.style.whiteSpace = 'normal';
      cell.style.overflowWrap = 'normal';
      cell.style.wordBreak = 'normal';
    }
    body.append(row);
  }
  host.append(probe);
  // Outside the article so document indexing observers never see measurement text.
  (root.parentElement ?? document.body).append(host);
  try {
    const cells = [...probe.rows[0].cells];
    probe.style.width = 'min-content';
    const mins = cells.map((cell) => cell.getBoundingClientRect().width);
    probe.style.width = 'max-content';
    return cells.map((cell, i) => ({ min: mins[i], max: cell.getBoundingClientRect().width }));
  } finally { host.remove(); }
}
