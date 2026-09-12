import type { DocKind, DocView } from './ipc';

/** The toolbar and the view router must offer the same readings. */
export function supportsRaw(view: DocView, kind: DocKind): boolean {
  return view === 'prose' || kind === 'text';
}
