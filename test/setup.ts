/**
 * What the state modules expect the browser to have provided.
 *
 * Only one thing, and only because of a fallback: `persist.ts` reaches for
 * `localStorage` when the store plugin is unavailable, which under a test
 * runner it always is. A dozen lines of stub is cheaper than a DOM
 * environment — and it keeps the tests honest about what they exercise, which
 * is the logic and not the browser.
 *
 * If this file ever grows a second stub, that is the signal to reconsider:
 * a state module that needs a browser to be tested is a state module that has
 * stopped being state and started being a view.
 */
const store = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  },
});
