// Vitest-Setup: localStorage-Polyfill für jsdom/Node-Umgebungen.
if (typeof globalThis !== 'undefined' && !globalThis.localStorage) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
}
