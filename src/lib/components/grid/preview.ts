import type { DocKind, TableCell, TableRow } from '../../ipc';
import { t } from '../../i18n';

export const CELL_PREVIEW_CHARS = 1000;
export type Preview = Pick<TableCell, 'truncated' | 'previewBytes'>;
export interface CellSelection {
  row: number;
  column: number;
  sourceRow?: number;
  preview?: Preview;
}

export function previewBadge(preview?: Preview): string | null {
  if (!preview?.truncated) return null;
  return preview.previewBytes === undefined
    ? t('grid.previewChars', { chars: CELL_PREVIEW_CHARS })
    : t('grid.previewBytes', { bytes: preview.previewBytes });
}

export function cellTitle(cell: Partial<TableCell> | undefined, kind: DocKind): string {
  if (cell?.null) return 'NULL';
  if (!cell?.truncated) return cell?.text ?? '';
  if (cell.previewBytes !== undefined) return t('grid.previewBinary', { bytes: cell.previewBytes });
  return t(kind === 'text' ? 'grid.previewText' : 'grid.previewValue', { chars: CELL_PREVIEW_CHARS });
}

/** Keep the selected preview when its page scrolls out, replace it when that page returns. */
export function selectedCell(previous: CellSelection | null, row: number, column: number, pageRow?: TableRow): CellSelection {
  const same = previous?.row === row && previous.column === column;
  const cell = pageRow?.cells[column];
  return { row, column, sourceRow: pageRow?.index ?? (same ? previous.sourceRow : undefined),
    preview: cell ? { truncated: cell.truncated, previewBytes: cell.previewBytes } : same ? previous.preview : undefined };
}
