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
  // GPU-Flotte: RunPod-IDs/Keys aus der Host-Umgebung dürfen die Verfügbarkeit
  // der Rollen-Provider nicht beeinflussen (server.ts lädt sonst die echte .env).
  'RUNPOD_API_KEY', 'RP_API_KEY', 'RP_AGENT_KEY', 'RUNPOD_API_BASE', 'RUNPOD_BRAIN_OPENAI_URL', 'RP_BRAIN_OPENAI_URL',
  'RUNPOD_ENDPOINT_ID', 'RUNPOD_ENDPOINT_ID_BRAIN', 'RUNPOD_ENDPOINT_ID_EARS',
  'RUNPOD_ENDPOINT_ID_VOICE', 'RP_ENDPOINT_ID', 'RP_ENDPOINT_ID_BRAIN', 'RP_ENDPOINT_ID_EARS',
  'RP_ENDPOINT_ID_VOICE', 'RP_ENDPOINT_ID_VISION', 'RP_ENDPOINT_ID_VIDEO',
  'RUNPOD_ENDPOINT_ID_VISION', 'RUNPOD_ENDPOINT_ID_VIDEO', 'RUNPOD_BRAIN_MODEL', 'AI_ALLOW_EXTERNAL_LLM',
  // R2-Ablage: Tests dürfen NICHT gegen den echten Bucket schreiben. Ohne Keys
  // weicht `saveArtifact` auf die lokale Artefakt-Ablage aus — genau der Pfad,
  // den tests/visualShowOrchestrator.test.ts prüft.
  'CFR2_ACCOUNT_ID', 'CFR2_ACCESS_KEY_ID', 'CFR2_ACCESS_KEY', 'CFR2_SECRET_ACCESS_KEY',
  'CFR2_BUCKET', 'CFR2_URL', 'CFR2_ENDPOINT', 'CFR2_PUBLIC_URL',
  'CFS3_ENDPOINT', 'CFS3_ACCESS_KEY', 'CFS3_SECRET_KEY', 'CFS3_BUCKET',
]) {
  delete process.env[key];
}

// ARCH-PERF-001/ARCH-SEC-001: STUDIO_ACCESS_TOKEN aus der Host-.env darf die
// Server-Tests nicht in den Auth-Modus schalten. Tests, die Auth prüfen
// (security.test.ts, securityProductionAuth.test.ts), setzen den Token explizit.
delete process.env.STUDIO_ACCESS_TOKEN;
