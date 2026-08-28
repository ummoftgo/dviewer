import { getValue, setValue } from "../persist";
import type { DocKind } from "../ipc";

export interface RecentEntry {
  path: string;
  title: string;
  kind: DocKind;
  /** Epoch milliseconds; stored absolute so a restart does not reorder them. */
  openedAt: number;
}

const STORE_KEY = "recents";
const MAX_RECENTS = 20;

class Recents {
  entries = $state<RecentEntry[]>([]);

  async load() {
    const saved = await getValue<RecentEntry[]>(STORE_KEY);
    if (Array.isArray(saved)) {
      this.entries = saved.filter(
        (entry): entry is RecentEntry =>
          typeof entry?.path === "string" && typeof entry?.title === "string",
      );
    }
  }

  add(entry: Omit<RecentEntry, "openedAt">) {
    const next = [
      { ...entry, openedAt: Date.now() },
      ...this.entries.filter((e) => e.path !== entry.path),
    ].slice(0, MAX_RECENTS);
    this.entries = next;
    void setValue(STORE_KEY, next);
  }

  remove(path: string) {
    this.entries = this.entries.filter((e) => e.path !== path);
    void setValue(STORE_KEY, this.entries);
  }

  clear() {
    this.entries = [];
    void setValue(STORE_KEY, []);
  }
}

export const recents = new Recents();
