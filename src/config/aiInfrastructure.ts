// ============================================================================
// audioMONASTRY · AI-Infrastruktur – Rollen, Budgets und Kosten-Grenzen
// ----------------------------------------------------------------------------
// Alle AI-Inferenz läuft auf RunPod Serverless, verteilt auf Rollen-Endpoints:
//
//   brain     lokales LLM (MOA-Planung, MCP-Tool-Calls, App-Steuerung)
//   ears      Audio-Intelligence (STT, Embeddings, Klassifikation, Audio-LLM)
//   voiceGen  TTS/Gesang/Song/SFX/Stem-Separation
//   vision    generative Visuals (Bild/Video aus Text + Ton)  ← seit 2026-09-11
//
// `brain`/`ears`/`voiceGen` stehen im Rollen-Manifest (Drift-Guard
// `tests/manifestRoles.test.ts`); `vision` ist ein **Endpoint** (RunPod-Hub-Worker)
// und bewusst NICHT im Audio-Manifest geführt.
//
// Kostenregel (Betreiber-Vorgabe 2026-09-11):
//   - maximal 4 GPU-Endpoints (eine vierte Instanz ist freigegeben)
//   - maximal 10 €/h für die gesamte laufende Flotte
//   - maximal 5 €/Monat für Speicher/Snapshots (Hetzner + RunPod zusammen)
// ============================================================================

/** Kanonische Audio-Rollen der GPU-Flotte – Reihenfolge = Anzeige-Reihenfolge. */
export const GPU_ROLE_IDS = ['brain', 'ears', 'voiceGen'] as const;

/** Rolle eines Audio-Endpoints. */
export type GpuRoleId = (typeof GPU_ROLE_IDS)[number];

/** Zusätzliche Endpoint-Rolle: generative Visuals (nicht im Audio-Manifest). */
export const VISION_ROLE_ID = 'vision' as const;

/** Alle zulässigen GPU-Endpoint-Rollen (Audio + Vision). */
export const GPU_ENDPOINT_ROLES = [...GPU_ROLE_IDS, VISION_ROLE_ID] as const;

/** Rolle eines beliebigen GPU-Endpoints. */
export type GpuEndpointRole = (typeof GPU_ENDPOINT_ROLES)[number];

function envNumber(name: string, fallback: number): number {
  if (typeof process === 'undefined' || !process.env) return fallback;
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Harte Obergrenze aktiver GPU-Endpoints (Kostenregel). */
export const AI_MAX_GPU_ENDPOINTS = envNumber('AI_MAX_GPU_ENDPOINTS', GPU_ENDPOINT_ROLES.length);

/** Budget: maximale Kosten pro laufender Stunde (EUR) für die gesamte Flotte. */
export const AI_MAX_FLEET_EUR_PER_HOUR = envNumber('AI_MAX_FLEET_EUR_PER_HOUR', 10);

/** Budget: maximale Speicher-/Snapshot-Kosten pro Monat (EUR), Hetzner + RunPod. */
export const AI_MAX_STORAGE_EUR_PER_MONTH = envNumber('AI_MAX_STORAGE_EUR_PER_MONTH', 5);

/**
 * Erfahrungswerte pro Endpoint-Rolle in EUR/h (A6000 48 GB, scale-to-zero).
 * Reine Größenordnung für den Budget-Guard – keine Abrechnung.
 */
export const FLEET_ROLE_EUR_PER_HOUR: Record<GpuEndpointRole, number> = {
  brain: 0.49,
  ears: 0.49,
  voiceGen: 0.49,
  vision: 0.49,
};

/**
 * Alt-Endpoints, die NICHT mehr verwendet werden dürfen (nur Doku/Status).
 * `samplemonk-ai` war der gemeinsame HF-Custom-Container, die übrigen die
 * abgeschalteten HF-Pilot-/CLAP-Endpoints.
 */
export const LEGACY_GPU_ENDPOINTS = [
  'samplemonk-ai',
  'samplemonk-ai-pilot',
  'samplemonk-ai-clap',
] as const;

/** Namenskonvention der RunPod-Serverless-Endpoints je Rolle. */
export function endpointNameForRole(role: GpuEndpointRole): string {
  if (role === VISION_ROLE_ID) return 'samplemonk-ai-vision';
  return `samplemonk-ai-${role === 'voiceGen' ? 'voice' : role}`;
}

/**
 * Verhindert versehentlich konfigurierte GPU-Infrastruktur jenseits der
 * erlaubten Rollen. Wird beim Start des Provider-Routers aufgerufen.
 */
export function assertGpuEndpointBudget(): void {
  const max = AI_MAX_GPU_ENDPOINTS;
  if (!Number.isInteger(max) || max < 1 || max > GPU_ENDPOINT_ROLES.length) {
    throw new Error(
      `AI_MAX_GPU_ENDPOINTS muss zwischen 1 und ${GPU_ENDPOINT_ROLES.length} liegen (aktuell: ${AI_MAX_GPU_ENDPOINTS}). ` +
        `Die AI-Flotte besteht aus den Rollen ${GPU_ENDPOINT_ROLES.join(', ')} – weitere GPU-Endpoints sind nicht erlaubt.`,
    );
  }
}

/** Summe der Erfahrungswerte für einen Satz aktiver Rollen (EUR/h). */
export function estimateFleetEurPerHour(active: readonly GpuEndpointRole[]): number {
  return active.reduce((sum, role) => sum + (FLEET_ROLE_EUR_PER_HOUR[role] ?? 0), 0);
}

/**
 * Wirft, wenn eine laufende Flotte teurer wäre als erlaubt.
 * `extraEurPerHour` bildet die Hetzner-Instanzen ab (nicht in der Rollen-Tabelle).
 */
export function assertFleetHourlyBudget(active: readonly GpuEndpointRole[], extraEurPerHour = 0): void {
  const total = estimateFleetEurPerHour(active) + Math.max(0, extraEurPerHour);
  if (total > AI_MAX_FLEET_EUR_PER_HOUR) {
    throw new Error(
      `Flotten-Kosten ${total.toFixed(2)} €/h übersteigen das Budget von ${AI_MAX_FLEET_EUR_PER_HOUR} €/h ` +
        `(Rollen: ${active.join(', ')}${extraEurPerHour ? `, Hetzner +${extraEurPerHour.toFixed(2)} €/h` : ''}).`,
    );
  }
}

/** Wirft, wenn Speicher-/Snapshot-Kosten das Monatsbudget sprengen würden. */
export function assertStorageBudget(monthlyEur: number): void {
  if (!Number.isFinite(monthlyEur) || monthlyEur < 0) {
    throw new Error(`Speicherkosten müssen eine nicht-negative Zahl sein (erhielt: ${monthlyEur}).`);
  }
  if (monthlyEur > AI_MAX_STORAGE_EUR_PER_MONTH) {
    throw new Error(
      `Speicherkosten ${monthlyEur.toFixed(2)} €/Monat übersteigen das Budget von ` +
        `${AI_MAX_STORAGE_EUR_PER_MONTH} €/Monat (Hetzner + RunPod).`,
    );
  }
}
