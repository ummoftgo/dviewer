/**
 * Thin key/value persistence over tauri-plugin-store.
 *
 * Falls back to localStorage when the plugin is unavailable (e.g. the frontend
 * opened in a plain browser via `npm run dev`) so the UI still works, but logs
 * loudly so a genuine plugin misconfiguration is not mistaken for a fallback.
 */

type StoreLike = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

let storePromise: Promise<StoreLike | null> | null = null;

function openStore(): Promise<StoreLike | null> {
  storePromise ??= (async () => {
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      return (await load("dviewer.json", { autoSave: 300 })) as unknown as StoreLike;
    } catch (err) {
      console.warn("[dviewer] store plugin unavailable, using localStorage:", err);
      return null;
    }
  })();
  return storePromise;
}

export async function getValue<T>(key: string): Promise<T | undefined> {
  const store = await openStore();
  if (store) return store.get<T>(key);

  const raw = localStorage.getItem(key);
  return raw === null ? undefined : (JSON.parse(raw) as T);
}

export async function setValue(key: string, value: unknown): Promise<void> {
  const store = await openStore();
  if (store) {
    await store.set(key, value);
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}
