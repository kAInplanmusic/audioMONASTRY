/**
 * NEW-D1-3: AI-Modus-Flag
 * ----------------------------------------------------------------------------
 * Der "AI-Modus" ist aktiv, solange das aiMONK-Modul nicht OFF ist
 * (AUTO_AI oder PRO). In diesem Modus darf der mixerMONK-Halter wechseln
 * (Lock-Takeover). Außerhalb des AI-Modus gilt der normale Lock-Schutz.
 *
 * INFRA-FEAT-001: Dieses Flag ist KEIN reines UI-Flag mehr. Es ist die
 * Client-Seite des Betriebsmodus in `aiGate.ts`, und der Modus ist die Kante,
 * die den GPU-Verkehr wirklich stoppt (fleetWake/RunPodProvider/Visual-Pfade).
 *
 *   aiMONK OFF      → `off`              (kein RunPod-Aufruf, nur Hetzner)
 *   aiMONK AUTO_AI  → `on-no-visuals`    (AI an, aber ohne Visualisierung)
 *   aiMONK PRO      → `on-with-visuals`  (Visuals bei Abruf, lazy)
 *
 * Änderungen werden best-effort an den Server gespiegelt (`POST /api/ai/mode`),
 * damit die Sperre nicht nur im Browser-Tab existiert.
 */
import {
  getAiOperatingMode,
  isAiDisabled,
  setAiOperatingMode,
  setAiOperatingModeForModuleState,
  type AiOperatingMode,
} from './aiGate';

export function setAiModeActive(active: boolean): void {
  if (active) {
    // Nur einschalten, wenn wirklich aus – ein aktives PRO (mit Visuals) darf
    // nicht auf "ohne Visuals" zurückfallen.
    if (isAiDisabled()) setAiOperatingMode('on-no-visuals', { source: 'aiMode' });
    return;
  }
  setAiOperatingMode('off', { source: 'aiMode' });
}

export function isAiModeActive(): boolean {
  return !isAiDisabled();
}

/**
 * Spiegelt den aiMONK-Modul-Zustand in den Betriebsmodus und – im Browser – an
 * den Server (dort greift die Sperre für alle AI-Pfade, auch ohne offenes Tab).
 */
export function setAiModeFromModuleState(state: 'OFF' | 'AUTO_AI' | 'PRO'): AiOperatingMode {
  const mode = setAiOperatingModeForModuleState(state);
  syncAiModeToServer(mode);
  return mode;
}

/** Aktueller Betriebsmodus (Kurzform für Client-Code). */
export function currentAiMode(): AiOperatingMode {
  return getAiOperatingMode();
}

/**
 * Best-effort-Spiegelung an den Server. Fehler sind hier bewusst nicht fatal:
 * der Moduswechsel im Client muss auch ohne API-Erreichbarkeit funktionieren
 * (die lokale Kante sperrt weiterhin jeden Aufruf in diesem Tab).
 */
export function syncAiModeToServer(mode: AiOperatingMode = getAiOperatingMode()): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  void fetch('/api/ai/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, source: 'module-state' }),
  }).catch((error: unknown) => {
    console.warn('[ai-mode] Server-Sync fehlgeschlagen:', (error as Error).message);
  });
}
