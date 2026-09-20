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
  'RUNPOD_ENDPOINT_ID_VOICE', 'RUNPOD_ENDPOINT_ID_MUSIC', 'RUNPOD_ENDPOINT_ID_IMAGE',
  'RUNPOD_ENDPOINT_ID_VIDEO_REAL', 'RUNPOD_ENDPOINT_ID_VIDEO_ABSTRACT', 'RUNPOD_ENDPOINT_ID_ORCHESTRATOR',
  'RP_ENDPOINT_ID', 'RP_ENDPOINT_ID_BRAIN', 'RP_ENDPOINT_ID_EARS',
  'RP_ENDPOINT_ID_VOICE', 'RP_ENDPOINT_ID_MUSIC', 'RP_ENDPOINT_ID_IMAGE',
  'RP_ENDPOINT_ID_VIDEO_REAL', 'RP_ENDPOINT_ID_VIDEO_ABSTRACT', 'RP_ENDPOINT_ID_ORCHESTRATOR',
  // Legacy-Namen der Vorarchitektur (Fallback in runpodVision/runpodVideo).
  'RP_ENDPOINT_ID_VISION', 'RP_ENDPOINT_ID_VIDEO',
  'RUNPOD_ENDPOINT_ID_VISION', 'RUNPOD_ENDPOINT_ID_VIDEO', 'RUNPOD_BRAIN_MODEL', 'AI_ALLOW_EXTERNAL_LLM',
  // R2-Ablage: Tests dürfen NICHT gegen den echten Bucket schreiben. Ohne Keys
  // weicht `saveArtifact` auf die lokale Artefakt-Ablage aus — genau der Pfad,
  // den tests/visualShowOrchestrator.test.ts prüft.
  'CFR2_ACCOUNT_ID', 'CFR2_ACCESS_KEY_ID', 'CFR2_ACCESS_KEY', 'CFR2_SECRET_ACCESS_KEY',
  'CFR2_BUCKET', 'CFR2_URL', 'CFR2_ENDPOINT', 'CFR2_PUBLIC_URL',
  'CFS3_ENDPOINT', 'CFS3_ACCESS_KEY', 'CFS3_SECRET_KEY', 'CFS3_BUCKET',
  // FIX F2: Der Resolver liest jetzt zusätzlich die dokumentierten Aliasse
  // (docs/ENV_MATRIX.md) und die auf app-1 benutzten `*_ID`-Schreibweisen. Eine
  // Host-Shell mit diesen Variablen würde sonst ECHTE R2-Zugangsdaten in die
  // Tests tragen (im Betreiber-Shell live gemessen: CLOUDFLARE_ACCESS_KEY_ID,
  // CLOUDFLARE_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID). Deshalb mit entfernen.
  'CFS3_ACCESS_KEY_ID', 'CFS3_SECRET_ACCESS_KEY', 'CFS3_ACCOUNT_ID', 'CFS3_PUBLIC_URL',
  'CLOUDFLARE_ACCESS_KEY_ID', 'CLOUDFLARE_SECRET_ACCESS_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID',
  // Ops-/Diagnose-Schalter des R2-Healthchecks (nur Tests setzen sie).
  'R2_HEALTH_TTL_MS', 'R2_PROBE_TIMEOUT_MS', 'R2_SDK_MAX_ATTEMPTS',
  'R2_AUTOSAVE_RETRY_ATTEMPTS', 'R2_AUTOSAVE_RETRY_BASE_MS', 'R2_AUTOSAVE_RETRY_MAX_MS',
  // Supabase (AI-P1-007): Unit-Tests duerfen NICHT gegen die echte DB lesen
  // oder schreiben (MOS-Ladepfad, ai_evaluations). Tests, die Persistenz
  // brauchen, injizieren einen Mock (setAiPersistenceClientForTests).
  'SB_URL', 'SB_SERVICE_ROLE', 'SB_SECRET', 'SB_PAT',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE_JWT', 'SUPABASE_SECRET', 'SUPABASE_LEGACY_PAT',
]) {
  delete process.env[key];
}

// ARCH-PERF-001/ARCH-SEC-001: STUDIO_ACCESS_TOKEN aus der Host-.env darf die
// Server-Tests nicht in den Auth-Modus schalten. Tests, die Auth prüfen
// (security.test.ts, securityProductionAuth.test.ts), setzen den Token explizit.
delete process.env.STUDIO_ACCESS_TOKEN;
