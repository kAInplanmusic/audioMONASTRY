/**
 * audioMONASTRY · AI-Betriebsmodus (der AI-Schalter mit echter Wirkung)
 * =====================================================================
 * Die Konstitution (docs/INFRA_KONSTITUTION.md §2) verlangt EINEN Schalter, der
 * den GPU-Verkehr wirklich stoppt:
 *
 *   `off`               – AI aus: kein RunPod-Job, kein `workersMin=1`, kein
 *                         Visual-Abruf. Es laufen nur die Hetzner-Kosten
 *                         (~0,054 €/h).
 *   `on-no-visuals`     – AI an OHNE Visualisierung: alle immer-Rollen
 *                         (brain/ears/voiceGen/music/orchestrator) laufen voll,
 *                         die Visual-Rollen (imageHq/videoReal/videoAbstract)
 *                         werden gar nicht erst geweckt.
 *   `on-with-visuals`   – AI an MIT Visualisierung: zusätzlich dürfen die
 *                         Visual-Rollen bei Abruf starten (lazy, siehe
 *                         fleetWake.ts) und fallen danach auf Null zurück.
 *
 * WARUM DIESES MODUL: Der frühere Schalter (`aiMode.ts`) war ein reines
 * Client-Flag ohne Kante zum Router – der GPU-Aufruf lief weiter. Hier liegt der
 * EINE Zustand, den alle RunPod-Kanten abfragen:
 *
 *   - `fleetWake.ts` (Wake/Sleep, `workersMin`)
 *   - `runpodProvider.ts` (`run`/`runLong`/`warmup` aller acht Rollen)
 *   - `vision/runpodVision.ts` + `vision/runpodVideo.ts` (direkte Visual-Pfade)
 *
 * Das Modul ist browser- und server-sicher (kein Node-API-Zugriff; `process.env`
 * nur hinter einer Existenzprüfung), weil es auch aus Client-Code (aiMONK-Modul)
 * erreicht wird.
 */
import { isVisualRole, type GpuEndpointRole } from '../../config/aiInfrastructure';

/** Betriebsmodus der AI-Flotte. */
export type AiOperatingMode = 'off' | 'on-no-visuals' | 'on-with-visuals';

/** Möglicher Grund, warum eine Rolle nicht laufen darf. */
export type AiGateBlockCode = 'AI_DISABLED' | 'AI_VISUALS_OFF';

/** Rolle des Aufrufers, der eine Sperre gemeldet hat (Logs/Diagnose). */
export interface AiGateContext {
  /** Wo wurde geprüft (z. B. 'fleet-wake', 'runpod', 'vision'). */
  source: string;
  /** Rolle, die blockiert wurde. */
  role: GpuEndpointRole;
}

/** Fehler einer geschlossenen AI-Gate – nie wiederholbar (Zustand, kein Netzfehler). */
export class AiGateError extends Error {
  readonly code: AiGateBlockCode;
  readonly role: GpuEndpointRole;
  readonly source: string;
  readonly retryable = false;

  constructor(code: AiGateBlockCode, role: GpuEndpointRole, source: string) {
    super(blockMessage(code, role, source));
    this.name = 'AiGateError';
    this.code = code;
    this.role = role;
    this.source = source;
  }
}

/** Klartext-Meldung je Sperrgrund (auch für API-Antworten). */
export function blockMessage(code: AiGateBlockCode, role?: GpuEndpointRole, source?: string): string {
  const where = source ? ` (${source})` : '';
  if (code === 'AI_DISABLED') {
    return `AI ist ausgeschaltet (aiMONK = OFF): ${role ?? 'GPU-Flotte'} startet nicht${where} – `
      + 'es laufen nur die Hetzner-Kosten. Zum Aktivieren: aiMONK auf AUTO_AI (ohne Visuals) oder PRO (mit Visuals).';
  }
  return `Rolle '${role ?? '?'}' ist eine Visual-Rolle und im Modus "AI ohne Visualisierung" gesperrt${where} – `
    + 'Visuals laufen nur bei aiMONK = PRO bzw. AI_MODE=on-with-visuals.';
}

function envValue(name: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  return (process.env[name] ?? '').trim();
}

/** Liest einen Betriebsmodus aus einem String (env oder API). */
export function parseAiOperatingMode(raw: string | undefined | null): AiOperatingMode | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (['off', 'aus', 'none', 'disabled', '0', 'false'].includes(value)) return 'off';
  if (['on', 'an', 'ai', 'true', '1', 'no-visuals', 'novisuals', 'without-visuals', 'ohne-visuals', 'on-no-visuals'].includes(value)) {
    return 'on-no-visuals';
  }
  if (['full', 'pro', 'visuals', 'with-visuals', 'mit-visuals', 'max', 'on-with-visuals'].includes(value)) {
    return 'on-with-visuals';
  }
  return null;
}

/**
 * Default aus der Umgebung (`AI_MODE`, Alias `AI_OPERATING_MODE`).
 *
 * Ohne Einstellung gilt „AI an, Visuals nur bei Anforderung“ – das ist die
 * Konstitution (§2, „AI an“ + Visual-Regel). `AI_MODE=off` ist damit der harte
 * Server-Kill-Schalter für den Fall, dass die Flotte unabhängig von der UI aus
 * bleiben soll.
 */
export function defaultAiOperatingMode(): AiOperatingMode {
  return parseAiOperatingMode(envValue('AI_MODE'))
    ?? parseAiOperatingMode(envValue('AI_OPERATING_MODE'))
    ?? 'on-no-visuals';
}

/** Betriebsmodus eines Modul-Zustands (`OFF` ⇄ `AUTO_AI` ⇄ `PRO`). */
export function aiOperatingModeForModuleState(state: 'OFF' | 'AUTO_AI' | 'PRO'): AiOperatingMode {
  if (state === 'OFF') return 'off';
  return state === 'PRO' ? 'on-with-visuals' : 'on-no-visuals';
}

let mode: AiOperatingMode | null = null;
let modeSource = 'default';
const listeners = new Set<(mode: AiOperatingMode, source: string) => void>();

function ensureMode(): AiOperatingMode {
  if (mode === null) {
    mode = defaultAiOperatingMode();
    modeSource = 'default';
  }
  return mode;
}

/** Aktueller Betriebsmodus. */
export function getAiOperatingMode(): AiOperatingMode {
  return ensureMode();
}

/** Woher der aktuelle Modus kommt ('default' | 'env' | 'module-state' | 'api' | 'test'). */
export function getAiOperatingModeSource(): string {
  ensureMode();
  return modeSource;
}

/**
 * Setzt den Betriebsmodus. Der Aufrufer (`source`) landet in Statusausgaben und
 * Logs, damit im Nachhinein belegbar ist, WER die Flotte abgeschaltet hat.
 */
export function setAiOperatingMode(next: AiOperatingMode, options: { source?: string } = {}): AiOperatingMode {
  ensureMode();
  const source = options.source ?? 'api';
  if (mode === next) return mode;
  mode = next;
  modeSource = source;
  for (const listener of [...listeners]) {
    try {
      listener(next, source);
    } catch {
      // Ein defekter Zuhörer darf den Schalter nicht blockieren.
    }
  }
  return mode;
}

/** Setzt den Modus aus einem aiMONK-Modul-Zustand (OFF/AUTO_AI/PRO). */
export function setAiOperatingModeForModuleState(
  state: 'OFF' | 'AUTO_AI' | 'PRO',
  options: { source?: string } = {},
): AiOperatingMode {
  return setAiOperatingMode(aiOperatingModeForModuleState(state), { source: options.source ?? 'module-state' });
}

/** true, wenn der AI-Schalter aus ist (keine GPU-Aufrufe). */
export function isAiDisabled(): boolean {
  return getAiOperatingMode() === 'off';
}

/** true, wenn Visual-Rollen bei Abruf starten dürfen. */
export function visualsEnabled(): boolean {
  return getAiOperatingMode() === 'on-with-visuals';
}

/**
 * INFRA-AI-005: Qualitätsstufe der Modellwahl, gesteuert über die Einstellung.
 *
 *   `standard` – aiMONK = AUTO_AI bzw. `on-no-visuals`: schnelle/günstige
 *                Modelle (Ausführer-Stufe), Kosten stehen im Vordergrund.
 *   `high`     – aiMONK = PRO bzw. `on-with-visuals`: das größere Modell wird
 *                auch für einfache Aufgaben gewählt, Reasoning bleibt an.
 *
 * Damit hat der Modul-State eine Kante bis in die Modell- und Providerwahl
 * (vorher hing die Wahl allein an `complexity` und env-Flags).
 */
export function aiQualityTier(): 'standard' | 'high' {
  return getAiOperatingMode() === 'on-with-visuals' ? 'high' : 'standard';
}

/** true, wenn die Rolle im aktuellen Modus laufen darf. */
export function isRoleAllowed(role: GpuEndpointRole): boolean {
  const current = getAiOperatingMode();
  if (current === 'off') return false;
  if (isVisualRole(role)) return current === 'on-with-visuals';
  return true;
}

/** Sperrgrund einer Rolle – `null`, wenn sie laufen darf. */
export function roleBlockCode(role: GpuEndpointRole): AiGateBlockCode | null {
  const current = getAiOperatingMode();
  if (current === 'off') return 'AI_DISABLED';
  if (isVisualRole(role) && current !== 'on-with-visuals') return 'AI_VISUALS_OFF';
  return null;
}

/** Wirft `AiGateError`, wenn die Rolle im aktuellen Modus nicht starten darf. */
export function assertRoleAllowed(role: GpuEndpointRole, source = 'ai'): void {
  const code = roleBlockCode(role);
  if (code) throw new AiGateError(code, role, source);
}

/** Rollen, die im aktuellen Modus laufen dürfen (Reihenfolge bleibt stabil). */
export function allowedRoles(roles: readonly GpuEndpointRole[]): GpuEndpointRole[] {
  return roles.filter((role) => isRoleAllowed(role));
}

/** Rollen, die im aktuellen Modus gesperrt sind. */
export function blockedRoles(roles: readonly GpuEndpointRole[]): GpuEndpointRole[] {
  return roles.filter((role) => !isRoleAllowed(role));
}

/** Reiner Statusbericht (kein Netzwerk) für `fleetStatus()` und `/api/ai/mode`. */
export function aiGateStatus(roles: readonly GpuEndpointRole[] = []): {
  mode: AiOperatingMode;
  source: string;
  aiEnabled: boolean;
  visualsEnabled: boolean;
  allowedRoles: GpuEndpointRole[];
  blockedRoles: GpuEndpointRole[];
} {
  return {
    mode: getAiOperatingMode(),
    source: getAiOperatingModeSource(),
    aiEnabled: !isAiDisabled(),
    visualsEnabled: visualsEnabled(),
    allowedRoles: allowedRoles(roles),
    blockedRoles: blockedRoles(roles),
  };
}

/** Abonniert Moduswechsel; Rückgabe meldet ab. */
export function onAiOperatingModeChange(listener: (mode: AiOperatingMode, source: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Nur für Tests: Modus auf den env-Default zurückstellen. */
export function __resetAiGate(): void {
  mode = null;
  modeSource = 'default';
  listeners.clear();
}
