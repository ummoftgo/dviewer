import { gridCellText, gridRowText, type CellText } from '../../ipc';
import type { DocTab } from '../../state/docs.svelte';
import { visibleColumns } from './columns';

export const MAX_ROW_COPY_BYTES = 8 * 1024 * 1024;

/** Snapshot the requested projection, never split a raw CSV/JSONL record or copy previews. */
export async function rowText(tab: DocTab, row: number | Promise<number>, count: number): Promise<CellText> {
  const columns = visibleColumns(tab, count);
  const { id, collection } = tab;
  const generation = tab.meta.generation, revision = tab.order.revision;
  const current = () => {
    if (tab.id !== id || tab.meta.generation !== generation || tab.collection !== collection || tab.order.revision !== revision) {
      throw { code: 'cancelled' };
    }
  };
  const sourceRow = await row;
  current();
  if (columns.length === count && columns.every((column, at) => column === at)) {
    const result = await gridRowText(id, sourceRow);
    current();
    return result;
  }
  const result = await projectedRowText(columns, async column => {
    const value = await gridCellText(id, sourceRow, column);
    current();
    return value;
  });
  return result;
}

export async function projectedRowText(columns: readonly number[], readCell: (column: number) => Promise<CellText>,
  limit = MAX_ROW_COPY_BYTES): Promise<CellText> {
  const buffer = new Uint8Array(limit);
  const encoder = new TextEncoder();
  let used = 0, truncated = false;
  for (const [at, column] of columns.entries()) {
    const cell = await readCell(column);
    // TSV quoting keeps embedded tabs, newlines and quotes in their own cell.
    const value = /[\t\r\n"]/.test(cell.text) ? `"${cell.text.replace(/"/g, '""')}"` : cell.text;
    const field = (at ? '\t' : '') + value;
    const written = encoder.encodeInto(field, buffer.subarray(used));
    used += written.written;
    truncated ||= cell.truncated || written.read < field.length;
    if (written.read < field.length || used === limit) {
      truncated ||= column !== columns.at(-1);
      break;
    }
  }
  return { text: new TextDecoder().decode(buffer.subarray(0, used)), truncated };
}
