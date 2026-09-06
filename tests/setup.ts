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

// Test-Isolation: LLM-API-Keys aus der Host-Shell (z. B. CB_API_KEY, OR_API_KEY,
// PUBLICAI_*, HF_API_KEY) dürfen die Provider-Verfügbarkeit im LlmRouter nicht
// beeinflussen – sonst schlagen Reihenfolge-Tests je nach Umgebung rot/grün aus.
// Entfernt NUR in der Test-Umgebung; echte Keys werden nicht geändert.
for (const key of [
  'HF_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'OLLAMA_URL', 'OLLAMA_MODEL',
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'CB_API_KEY', 'OR_API_KEY', 'OPENROUTER_MODEL',
  'PUBLICAI_KEY', 'PUBLICAI_BASE_URL', 'PUBLICAI_MODEL', 'AI_EMERGENCY_PROVIDERS',
]) {
  delete process.env[key];
}
