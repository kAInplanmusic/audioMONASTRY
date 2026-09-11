/**
 * audioMONASTRY · VisualMONK – Show-Orchestrator (reiner Kern)
 * ===========================================================
 * Der Orchestrator führt eine **Show** aus Szenen: jedes Element (generatives
 * Bild oder Wan2.2-Clip) steht eine Zeit lang auf dem Beamer und geht dann in
 * die nächste Szene über. Wann umgeschaltet wird, entscheiden drei Regeln:
 *
 *   1. `duration` – die Szene hat ihre Standdauer erreicht (Clip-Länge bzw.
 *      gewünschte Dauer, gedeckelt durch `maxSceneS`).
 *   2. `beat`     – ein harter Onset im laufenden Set (Feature-Bus) **nach**
 *      der Mindeststandzeit (`minDwellS`), damit nicht jeder Takt flippt.
 *   3. `energy`   – die Energie ist seit Beginn der Szene um `energyJump`
 *      gestiegen (Drop/Section-Wechsel).
 *
 * Bewusst **rein und deterministisch**: kein DOM, keine Timer, keine KI. Die
 * Zeit kommt als Parameter herein, damit derselbe Ablauf in Tests, im Browser
 * und (später) im Replay identisch ist.
 */

import type { AudioFeatures } from './types';

type ShowSceneKind = 'image' | 'clip';

/** Ein Element der Show. */
export interface ShowScene {
  id: string;
  /** Kurzname für die UI (z. B. „Galaxie über Wasser“). */
  label: string;
  prompt: string;
  style?: string;
  kind: ShowSceneKind;
  /** data-URI oder URL (Bild bzw. mp4). */
  src: string;
  /** Gewünschte Standdauer in Sekunden. */
  durationS: number;
  /** Echte Clip-Länge, wenn bekannt – begrenzt die Standdauer. */
  mediaDurationS?: number;
}

/** Laufzustand einer Show (serialisierbar). */
export interface ShowState {
  index: number;
  /** Zeitpunkt (ms), an dem die aktuelle Szene begann. */
  startedAtMs: number;
  transitions: number;
  /** Energie beim Beginn der Szene – Bezug für die Sprungerkennung. */
  energyRef: number;
}

export interface ShowOptions {
  /** Kürzeste Standzeit, bevor Audio umschalten darf (Sekunden). */
  minDwellS?: number;
  /** Crossfade-Dauer am Szenenanfang (Sekunden, 0 = harter Schnitt). */
  fadeS?: number;
  /** Onset-Schwelle 0..1 für `beat`. */
  onsetThreshold?: number;
  /** Energie-Anstieg 0..1 seit Szenenbeginn für `energy`. */
  energyJump?: number;
  /** Harte Obergrenze der Standzeit (Sekunden). */
  maxSceneS?: number;
}

export const SHOW_DEFAULTS: Required<ShowOptions> = {
  minDwellS: 4,
  fadeS: 0.8,
  onsetThreshold: 0.72,
  energyJump: 0.35,
  maxSceneS: 30,
};

type ShowAdvanceReason = 'duration' | 'beat' | 'energy' | null;

export interface ShowTick {
  state: ShowState;
  /** -1 = keine Szene vorhanden. */
  sceneIndex: number;
  advanced: boolean;
  reason: ShowAdvanceReason;
  /** 1 = voll sichtbar, < 1 = im Crossfade der aktuellen Szene. */
  fade: number;
  /** Laufzeit der aktuellen Szene in Sekunden. */
  elapsedS: number;
  /** Rechnerische Gesamtdauer der Show in Sekunden. */
  totalS: number;
}

function resolve(opts?: ShowOptions): Required<ShowOptions> {
  return { ...SHOW_DEFAULTS, ...(opts ?? {}) };
}

/**
 * Effektive Standdauer einer Szene: Wunschdauer, Clip-Länge und Deckel
 * zusammengeführt. Immer ≥ 1 s, damit keine Szene „durchblitzt“.
 */
export function effectiveDurationS(scene: ShowScene, opts?: ShowOptions): number {
  const o = resolve(opts);
  const wanted = scene.durationS > 0 ? scene.durationS : o.maxSceneS;
  const clipLimit =
    scene.kind === 'clip' && typeof scene.mediaDurationS === 'number' && scene.mediaDurationS > 0
      ? scene.mediaDurationS
      : Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(wanted, clipLimit, o.maxSceneS));
}

/** Rechnerische Gesamtdauer aller Szenen (für UI/Fortschritt). */
export function showTotalDurationS(scenes: readonly ShowScene[], opts?: ShowOptions): number {
  return scenes.reduce((sum, scene) => sum + effectiveDurationS(scene, opts), 0);
}

/** Kurzstatistik für die UI – ohne DOM, damit auch serverseitig nutzbar. */
export function summarizeShow(scenes: readonly ShowScene[], opts?: ShowOptions): {
  scenes: number;
  clips: number;
  images: number;
  totalS: number;
} {
  return {
    scenes: scenes.length,
    clips: scenes.filter((s) => s.kind === 'clip').length,
    images: scenes.filter((s) => s.kind === 'image').length,
    totalS: showTotalDurationS(scenes, opts),
  };
}

export function createShowState(index = 0, nowMs = 0, energyRef = 0): ShowState {
  return { index, startedAtMs: nowMs, transitions: 0, energyRef };
}

/** Nächster Index – die Show läuft als Schleife (Beamer ohne Bedienung). */
export function nextSceneIndex(index: number, sceneCount: number): number {
  if (sceneCount <= 0) return -1;
  return (index + 1) % sceneCount;
}

/** Szene zum Zustand – oder null, wenn die Show leer ist. */
export function sceneAt(state: ShowState, scenes: readonly ShowScene[]): ShowScene | null {
  if (scenes.length === 0) return null;
  const index = Math.min(Math.max(state.index, 0), scenes.length - 1);
  return scenes[index] ?? null;
}

/**
 * Ein Schritt der Show. Wird pro Frame (oder pro Tick) aufgerufen und liefert
 * den **neuen** Zustand plus die Entscheidung. Der übergebene Zustand wird
 * nicht verändert.
 */
export function tickShow(
  state: ShowState,
  scenes: readonly ShowScene[],
  features: AudioFeatures,
  nowMs: number,
  opts?: ShowOptions,
): ShowTick {
  const o = resolve(opts);
  const totalS = showTotalDurationS(scenes, o);
  if (scenes.length === 0) {
    return { state, sceneIndex: -1, advanced: false, reason: null, fade: 1, elapsedS: 0, totalS };
  }

  const index = Math.min(Math.max(state.index, 0), scenes.length - 1);
  const scene = scenes[index];
  const elapsedS = Math.max(0, (nowMs - state.startedAtMs) / 1000);
  const durationS = effectiveDurationS(scene, o);
  const energy = Number.isFinite(features.energy) ? features.energy : 0;

  let reason: ShowAdvanceReason = null;
  if (elapsedS >= durationS) {
    reason = 'duration';
  } else if (elapsedS >= o.minDwellS) {
    if (features.onset >= o.onsetThreshold) reason = 'beat';
    else if (energy - state.energyRef >= o.energyJump) reason = 'energy';
  }

  if (reason) {
    const next = nextSceneIndex(index, scenes.length);
    const nextState: ShowState = {
      index: next,
      startedAtMs: nowMs,
      transitions: state.transitions + 1,
      // Bezug für die nächste Szene neu setzen: „Anstieg seit Szenenbeginn“.
      energyRef: energy,
    };
    return {
      state: nextState,
      sceneIndex: next,
      advanced: true,
      reason,
      // Beim Wechsel startet der Crossfade der neuen Szene bei 0.
      fade: o.fadeS > 0 ? 0 : 1,
      elapsedS: 0,
      totalS,
    };
  }

  return {
    state,
    sceneIndex: index,
    advanced: false,
    reason: null,
    fade: o.fadeS > 0 ? Math.min(1, elapsedS / o.fadeS) : 1,
    elapsedS,
    totalS,
  };
}

/**
 * Crossfade-Faktor 0..1 für das Zeichnen: 0 = vorherige Szene/Signal, 1 = die
 * aktuelle Szene deckt vollständig. Ausserhalb des Fades immer 1.
 */
export function showFade(state: ShowState, nowMs: number, opts?: ShowOptions): number {
  const o = resolve(opts);
  if (o.fadeS <= 0) return 1;
  const elapsedS = Math.max(0, (nowMs - state.startedAtMs) / 1000);
  return Math.min(1, elapsedS / o.fadeS);
}

/**
 * Übergabe-Liste für das Zusammenführen (nur Clips mit Quelle). Reihenfolge =
 * Show-Reihenfolge; Bilder kennt der Merger nicht (ffmpeg würde sie als
 * Standbild behandeln, deshalb bleiben sie draussen).
 */
export function mergeableClips(scenes: readonly ShowScene[]): ShowScene[] {
  return scenes.filter((s) => s.kind === 'clip' && Boolean(s.src));
}
