// ============================================================================
// audioMONASTRY · AI-Infrastruktur – Rollen, Budgets und Kosten-Grenzen
// ----------------------------------------------------------------------------
// Alle AI-Inferenz läuft auf RunPod Serverless, verteilt auf Rollen-Endpoints:
//
//   brain          App-/Plugin-Steuerung, Tool-Calls (Qwen3-30B-A3B-AWQ)
//   ears           Audio-Intelligence (STT, Embeddings, Klassifikation, Audio-LLM)
//   voiceGen       TTS/SFX/Stem-Separation
//   music          Musikgenerierung (ACE-Step 1.5 XL + LM-Planer + LoRAs)
//   imageHq        Keyframes/Texturen (FLUX.2 [dev] + Qwen-Image-2512)
//   videoReal      photorealistische Clips (Wan 2.2 A14B)
//   videoAbstract  stylisierte/abstrakte Clips (LTXVideo 13B)
//   orchestrator   MoA + MCP über die Fach-Instanzen 2–7
//
// ALLE acht Rollen stehen im Rollen-Manifest und werden vom Drift-Guard
// `tests/manifestRoles.test.ts` geprüft.
//
// Kosten-Konstitution (Betreiber-Vorgabe 2026-09-20) — EINZIGE QUELLE:
//   docs/INFRA_KONSTITUTION.md. Kurzfassung:
//   - maximal 8 GPU-Endpoints (eine Rolle je Instanz, A6000 48 GB)
//   - maximal 5 Hetzner-Server (app/sfu/ai/master/edge)
//   - maximal 10 €/h für die gesamte laufende Flotte, Zielband 5–7,5 €/h
//     (8 × ~0,49 = ~3,92 €/h Vollast)
//   - maximal 5 €/Monat für Speicher/Snapshots/ISOs (Hetzner + RunPod)
//   - AI-Flotte per Einstellung abschaltbar -> dann nur Hetzner-Kosten
//   - bei "AI an" laufen alle immer-Rollen; die VISUAL-Rollen
//     (imageHq/videoReal/videoAbstract) erst bei Abruf (siehe isVisualRole)
// ============================================================================

/**
 * Kanonische Rollen der GPU-Flotte – Reihenfolge = Anzeige-Reihenfolge.
 *
 * 8-Instanzen-Architektur (docs/runpod-8-instances-complete-plan.md):
 *   brain          Qwen3-30B-A3B-AWQ – App-/Plugin-Steuerung, Tool-Calls
 *   ears           Audio-Analyse (STT, Embeddings, Klassifikation, Diarization)
 *   voiceGen       TTS (CustomVoice + VoiceDesign), Stems, SFX
 *   music          ACE-Step 1.5 XL (base/sft/turbo) + LM-Planer + Genre-LoRAs
 *   imageHq        FLUX.2 [dev] + Qwen-Image-2512 + ControlNet/IP-Adapter/LoRAs
 *   videoReal      Wan 2.2 A14B – photorealistische Clips
 *   videoAbstract  LTXVideo 13B – stylisierte/abstrakte Clips
 *   orchestrator   MoA aus 4 Anbieter-diversen kleinen LLMs + MCP-Tools
 *
 * ALLE acht Rollen stehen im Rollen-Manifest und werden vom Drift-Guard
 * `tests/manifestRoles.test.ts` gegen `endpointRegistry.ts` geprüft.
 */
export const GPU_ROLE_IDS = [
  'brain',
  'ears',
  'voiceGen',
  'music',
  'imageHq',
  'videoReal',
  'videoAbstract',
  'orchestrator',
] as const;

/** Rolle eines Flotten-Endpoints. */
export type GpuRoleId = (typeof GPU_ROLE_IDS)[number];

/**
 * Alle zulässigen GPU-Endpoint-Rollen.
 *
 * Seit der 8-Instanzen-Architektur sind Visuals eigene Manifest-Rollen
 * (`imageHq`, `videoReal`, `videoAbstract`) statt manifestfreier Sonderfälle –
 * die frühere Aufteilung in `vision`/`video` entfällt damit.
 */
export const GPU_ENDPOINT_ROLES = [...GPU_ROLE_IDS] as const;

/** Rolle eines beliebigen GPU-Endpoints. */
export type GpuEndpointRole = (typeof GPU_ENDPOINT_ROLES)[number];

/**
 * Liest eine Zahl aus der Umgebung — browser-sicher: ohne `process` (Client-Bundle)
 * faellt der Wert auf `fallback` zurueck, statt mit `ReferenceError` zu crashen.
 * Wird auch von den client-erreichbaren Orchestrator-Modulen genutzt
 * (circuitBreaker, costTracker).
 */
export function envNumber(name: string, fallback: number): number {
  if (typeof process === 'undefined' || !process.env) return fallback;
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Liest einen String aus der Umgebung — browser-sicher (siehe `envNumber`). */
export function envString(name: string, fallback: string): string {
  if (typeof process === 'undefined' || !process.env) return fallback;
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Harte Obergrenze aktiver GPU-Endpoints (Kostenregel). */
export const AI_MAX_GPU_ENDPOINTS = envNumber('AI_MAX_GPU_ENDPOINTS', GPU_ENDPOINT_ROLES.length);

/** Budget: maximale Kosten pro laufender Stunde (EUR) für die gesamte Flotte. */
export const AI_MAX_FLEET_EUR_PER_HOUR = envNumber('AI_MAX_FLEET_EUR_PER_HOUR', 10);

/** Budget: maximale Speicher-/Snapshot-Kosten pro Monat (EUR), Hetzner + RunPod. */
export const AI_MAX_STORAGE_EUR_PER_MONTH = envNumber('AI_MAX_STORAGE_EUR_PER_MONTH', 5);

/** Harte Obergrenze der Hetzner-Server (Rollen app/sfu/ai/master/edge). */
export const AI_MAX_HETZNER_SERVERS = envNumber('AI_MAX_HETZNER_SERVERS', 5);

/**
 * Zielband der laufenden Flottenkosten (EUR/h) — weicher Korridor unterhalb der
 * harten Grenze `AI_MAX_FLEET_EUR_PER_HOUR`. Oberhalb `max` soll die Flotte
 * gedrosselt werden, ohne die harte Grenze zu reißen.
 */
export const AI_TARGET_FLEET_EUR_PER_HOUR = { min: 5, max: 7.5 } as const;

/**
 * Erfahrungswert der laufenden Hetzner-Kosten aller fünf Rollen (app/sfu/ai/
 * master/edge) in EUR/h — Konstitution §3. Der Guard rechnet ihn zur GPU-Flotte
 * dazu, weil die Konstitutionsgrenze (10 €/h) BEIDE Seiten umfasst.
 */
export const AI_HETZNER_EUR_PER_HOUR = envNumber('AI_HETZNER_EUR_PER_HOUR', 0.054);

/**
 * Angenommene Speicher-/Snapshot-Kosten in EUR/Monat.
 *
 * Ist-Wert der Flotte (2026-09-20 per Hetzner-API gemessen): 10 Snapshots,
 * 2 je Rolle (Retention `SNAPSHOT_RETENTION=2`), Summe image_size ≈ 50,4 GB
 * ≈ 0,50 €/Monat bei ~0,01 €/GB/Monat. Die früheren 0,30 €/Monat gingen von
 * fünf Snapshots (~25,5 GB) aus; die Retention hält jetzt zehn. Dient dem
 * Storage-Guard als Ist-Wert, solange die Abrechnung nicht live gelesen wird.
 */
export const AI_ESTIMATED_STORAGE_EUR_PER_MONTH = envNumber('AI_ESTIMATED_STORAGE_EUR_PER_MONTH', 0.5);

/**
 * Laufzeit-Grenzen der Budget-Guards.
 *
 * Die Werte starten aus den Konstanten oben (env-gestützt) und sind zur Laufzeit
 * überschreibbar: Ops kann die Grenzen senken (z. B. Zielband erzwingen), und
 * Tests können eine Überschreitung herstellen, ohne die Umgebung zu verbiegen.
 */
export interface AiBudgetLimits {
  maxEurPerHour: number;
  maxStorageEurPerMonth: number;
  maxGpuEndpoints: number;
  maxHetznerServers: number;
}

let budgetLimits: AiBudgetLimits = {
  maxEurPerHour: AI_MAX_FLEET_EUR_PER_HOUR,
  maxStorageEurPerMonth: AI_MAX_STORAGE_EUR_PER_MONTH,
  maxGpuEndpoints: AI_MAX_GPU_ENDPOINTS,
  maxHetznerServers: AI_MAX_HETZNER_SERVERS,
};

/** Aktuelle Laufzeit-Grenzen (Kopie — Mutation von außen ist wirkungslos). */
export function getBudgetLimits(): AiBudgetLimits {
  return { ...budgetLimits };
}

/** Setzt einzelne Laufzeit-Grenzen und liefert den neuen Stand. */
export function setBudgetLimits(partial: Partial<AiBudgetLimits>): AiBudgetLimits {
  budgetLimits = { ...budgetLimits, ...partial };
  return getBudgetLimits();
}

/** Stellt den env-Stand wieder her (Ops-Reset bzw. Test-Isolation). */
export function resetBudgetLimits(): AiBudgetLimits {
  budgetLimits = {
    maxEurPerHour: AI_MAX_FLEET_EUR_PER_HOUR,
    maxStorageEurPerMonth: AI_MAX_STORAGE_EUR_PER_MONTH,
    maxGpuEndpoints: AI_MAX_GPU_ENDPOINTS,
    maxHetznerServers: AI_MAX_HETZNER_SERVERS,
  };
  return getBudgetLimits();
}

/**
 * Visual-Rollen: laufen NICHT dauerhaft, sondern erst bei Abruf/Aktivierung
 * (Bild-/Video-Generierung) und fallen danach per `idleTimeout` auf Null zurück.
 * Alle übrigen Rollen laufen bei "AI an" voll (kein Lazy-Load).
 */
export const AI_VISUAL_ROLES = [
  'imageHq',
  'videoReal',
  'videoAbstract',
] as const satisfies readonly GpuEndpointRole[];

/** true, wenn die Rolle eine bedarfsgesteuerte Visual-Rolle ist. */
export function isVisualRole(role: GpuEndpointRole): boolean {
  return (AI_VISUAL_ROLES as readonly GpuEndpointRole[]).includes(role);
}

/** Rollen, die bei "AI an" immer laufen (alle außer den Visual-Rollen). */
export function alwaysOnRoles(): GpuEndpointRole[] {
  return GPU_ENDPOINT_ROLES.filter((role) => !isVisualRole(role));
}

/**
 * Erfahrungswerte pro Endpoint-Rolle in EUR/h (A6000 48 GB, scale-to-zero).
 * Reine Größenordnung für den Budget-Guard – keine Abrechnung.
 */
const FLEET_ROLE_EUR_PER_HOUR: Record<GpuEndpointRole, number> = {
  brain: 0.49,
  ears: 0.49,
  voiceGen: 0.49,
  music: 0.49,
  imageHq: 0.49,
  videoReal: 0.49,
  videoAbstract: 0.49,
  orchestrator: 0.49,
};

/**
 * Alt-Endpoints, die NICHT mehr verwendet werden dürfen (nur Doku/Status).
 * `audiomonastry-ai` war der gemeinsame HF-Custom-Container, die übrigen die
 * abgeschalteten HF-Pilot-/CLAP-Endpoints.
 */
export const LEGACY_GPU_ENDPOINTS = [
  'audiomonastry-ai',
  'audiomonastry-ai-pilot',
  'audiomonastry-ai-clap',
] as const;

/** Namenskonvention der RunPod-Serverless-Endpoints je Rolle. */
const ENDPOINT_NAME_BY_ROLE: Record<GpuEndpointRole, string> = {
  brain: 'audiomonastry-ai-brain',
  ears: 'audiomonastry-ai-ears',
  voiceGen: 'audiomonastry-ai-voice',
  music: 'audiomonastry-ai-music',
  imageHq: 'audiomonastry-ai-image',
  videoReal: 'audiomonastry-ai-video-real',
  videoAbstract: 'audiomonastry-ai-video-abstract',
  orchestrator: 'audiomonastry-ai-orchestrator',
};

export function endpointNameForRole(role: GpuEndpointRole): string {
  return ENDPOINT_NAME_BY_ROLE[role];
}

/**
 * Verhindert versehentlich konfigurierte GPU-Infrastruktur jenseits der
 * erlaubten Rollen. Wird beim Start des Provider-Routers aufgerufen.
 */
export function assertGpuEndpointBudget(): void {
  const max = getBudgetLimits().maxGpuEndpoints;
  if (!Number.isInteger(max) || max < 1 || max > GPU_ENDPOINT_ROLES.length) {
    throw new Error(
      `AI_MAX_GPU_ENDPOINTS muss zwischen 1 und ${GPU_ENDPOINT_ROLES.length} liegen (aktuell: ${max}). ` +
        `Die AI-Flotte besteht aus den Rollen ${GPU_ENDPOINT_ROLES.join(', ')} – weitere GPU-Endpoints sind nicht erlaubt.`,
    );
  }
}

/** Wirft, wenn die Hetzner-Serverzahl die Konstitution überschreitet. */
export function assertHetznerServerBudget(count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Hetzner-Serverzahl muss eine nicht-negative Ganzzahl sein (erhielt: ${count}).`);
  }
  if (count > getBudgetLimits().maxHetznerServers) {
    throw new Error(
      `Hetzner-Flotte ${count} Server übersteigt die Konstitution von ${getBudgetLimits().maxHetznerServers} Servern ` +
        `(app/sfu/ai/master/edge) — siehe docs/INFRA_KONSTITUTION.md.`,
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
  const limit = getBudgetLimits().maxEurPerHour;
  if (total > limit) {
    throw new Error(
      `Flotten-Kosten ${total.toFixed(2)} €/h übersteigen das Budget von ${limit} €/h ` +
        `(Rollen: ${active.join(', ')}${extraEurPerHour ? `, Hetzner +${extraEurPerHour.toFixed(2)} €/h` : ''}).`,
    );
  }
}

/** Wirft, wenn Speicher-/Snapshot-Kosten das Monatsbudget sprengen würden. */
export function assertStorageBudget(monthlyEur: number): void {
  if (!Number.isFinite(monthlyEur) || monthlyEur < 0) {
    throw new Error(`Speicherkosten müssen eine nicht-negative Zahl sein (erhielt: ${monthlyEur}).`);
  }
  const limit = getBudgetLimits().maxStorageEurPerMonth;
  if (monthlyEur > limit) {
    throw new Error(
      `Speicherkosten ${monthlyEur.toFixed(2)} €/Monat übersteigen das Budget von ` +
        `${limit} €/Monat (Hetzner + RunPod).`,
    );
  }
}

/** Ist-Stand eines Budgets inkl. Bewertung gegen Grenze und Zielband. */
export interface BudgetCheck {
  /** Ist-Wert (EUR/h bzw. EUR/Monat). */
  value: number;
  /** Harte Grenze aus den Laufzeit-Limits. */
  limit: number;
  withinLimit: boolean;
  /** Fehlermeldung des Guards, wenn die Grenze gerissen ist. */
  violation?: string;
}

/**
 * Prüft einen Wert gegen einen Guard und liefert das Ergebnis statt zu werfen.
 * Für Status-/Alarm-Pfade (Flotten-Status, Monitoring): dort soll eine
 * Überschreitung sichtbar und geloggt werden, ohne die Antwort abzureißen.
 */
function checkBudget(value: number, guard: () => void, limit: number): BudgetCheck {
  try {
    guard();
    return { value, limit, withinLimit: true };
  } catch (error) {
    return { value, limit, withinLimit: false, violation: (error as Error).message };
  }
}

/**
 * Gesamtbericht der laufenden und der Speicher-Kosten gegen die Konstitution.
 * Pur (kein Netzwerk), für `fleetStatus()` und die Budget-Route.
 */
export interface FleetBudgetReport {
  /** GPU-Rollen allein (EUR/h). */
  gpuEurPerHour: number;
  /** Hetzner-Anteil (EUR/h). */
  hetznerEurPerHour: number;
  /** Gesamt laufend (EUR/h) — GPU + Hetzner. */
  totalEurPerHour: number;
  hourly: BudgetCheck;
  /** Zielband aus `AI_TARGET_FLEET_EUR_PER_HOUR`. */
  target: { min: number; max: number; within: boolean };
  storage: BudgetCheck;
}

export function fleetBudgetReport(
  active: readonly GpuEndpointRole[],
  hetznerEurPerHour = AI_HETZNER_EUR_PER_HOUR,
  storageEurPerMonth = AI_ESTIMATED_STORAGE_EUR_PER_MONTH,
): FleetBudgetReport {
  const gpuEurPerHour = estimateFleetEurPerHour(active);
  const hetzner = Math.max(0, hetznerEurPerHour);
  const total = gpuEurPerHour + hetzner;
  const hourly = checkBudget(total, () => assertFleetHourlyBudget(active, hetzner), getBudgetLimits().maxEurPerHour);
  return {
    gpuEurPerHour,
    hetznerEurPerHour: hetzner,
    totalEurPerHour: total,
    hourly,
    target: {
      ...AI_TARGET_FLEET_EUR_PER_HOUR,
      within: total >= AI_TARGET_FLEET_EUR_PER_HOUR.min && total <= AI_TARGET_FLEET_EUR_PER_HOUR.max,
    },
    storage: checkBudget(
      storageEurPerMonth,
      () => assertStorageBudget(storageEurPerMonth),
      getBudgetLimits().maxStorageEurPerMonth,
    ),
  };
}
