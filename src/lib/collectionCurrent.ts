import type { DocTab } from './state/docs.svelte';

/** A generation alone cannot distinguish two newly opened documents. */
export function currentCollection(target: DocTab, shown: DocTab, id: number, generation: number, live: boolean): boolean {
  return live && shown === target && target.id === id && target.status === 'ready'
    && (target.meta.generation ?? 0) === generation;
}
