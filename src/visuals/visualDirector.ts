/**
 * VisualMONK · Regisseur (Visual Director) — beatsynced, stimmungs-rotierend
 * =========================================================================
 * Der Regisseur ist KEINE KI-Instanz, sondern reiner, deterministischer Code.
 * Er empfängt die Audio-Features des Feature-Bus (onset/energy/bass/rms/bpm)
 * und wählt aus dem Pool-Manifest die nächste Szene:
 *
 *   * hartes Onset nach Mindeststandzeit  →  Szenenwechsel auf den Schlag
 *   * Energie steigt über Schwelle         →  Wechsel bei Drop/Section
 *   * Stimmung rotiert                     →  düster ↔ cool ↔ lustig wechselt
 *                                              sich ab, statt zu kleben
 *   * energiepassend                       →  ruhige Quellen bei ruhigem Teil
 *
 * Warum keine Instanz dafür: Beat-Sync braucht Frame-Timing im Browser; eine
 * entfernte Instanz brächte nur Latenz + Kosten, keinen Nutzen. Das Beat-Signal
 * ist bereits lokal (WebAudio-Analyser am Master-Ausgang).
 */
import { mulberry32 } from '../core/visual/canvasRenderer';
import type { AudioFeatures } from '../core/visual/types';
import type { PoolEntry, PoolMood, PoolEnergy } from './poolManifest';

/** Zustand des Regisseurs (serialisierbar, deterministisch). */
export interface DirectorState {
  seed: number;
  /** Index der aktuellen Szene im Pool. */
  index: number;
  /** Zeitpunkt des Szenenbeginns (ms). */
  startedAtMs: number;
  /** Energie bei Szenenbeginn (Bezug für Sprungerkennung). */
  energyRef: number;
  /** Letzte Stimmung (für Rotation). */
  lastMood: PoolMood | null;
  /** Zähler der Wechsel (UI/Statistik). */
  transitions: number;
}

export interface DirectorOptions {
  /** Kürzeste Standzeit, bevor Audio umschalten darf (s). */
  minDwellS?: number;
  /** Onset-Schwelle 0..1 für den Beat-Wechsel. */
  onsetThreshold?: number;
  /** Energie-Anstieg 0..1 seit Szenenbeginn für den Drop-Wechsel. */
  energyJump?: number;
  /** Harte Obergrenze der Standzeit (s). */
  maxSceneS?: number;
}

export const DIRECTOR_DEFAULTS: Required<DirectorOptions> = {
  minDwellS: 3,
  onsetThreshold: 0.6,
  energyJump: 0.3,
  maxSceneS: 24,
};

/** Energie-Präferenz einer Szene → Auswahlgewicht bei gegebenem Energielevel. */
function energyFitWeight(entryEnergy: PoolEnergy, energy: number): number {
  // ruhige Quelle passt bei niedriger Energie, harte bei hoher.
  switch (entryEnergy) {
    case 'ruhig': return 1.6 - energy * 0.8;   // 1.6 (ruhig) → 0.8 (hart)
    case 'mittel': return 1.0;
    case 'hart': return 0.7 + energy * 0.9;    // 0.7 (ruhig) → 1.6 (hart)
    default: return 1.0;
  }
}

/** Stimmungs-Rotation: bevorzugt die Stimmung, die NICHT die letzte war. */
function moodFitWeight(mood: PoolMood, lastMood: PoolMood | null): number {
  if (lastMood === null) return 1.0;
  return mood === lastMood ? 0.35 : 1.0;
}

/** Nächsten Index wählen — gewichtet, aber deterministisch über den Seed. */
export function pickNextScene(
  pool: readonly PoolEntry[],
  state: DirectorState,
  features: AudioFeatures,
  // Teil der öffentlichen Signatur: bewusst (noch) ungenutzt, daher `_`-Präfix,
  // damit @typescript-eslint/no-unused-vars es als Absicht liest.
  _opts: Required<DirectorOptions>,
): number {
  if (pool.length === 0) return -1;
  if (pool.length === 1) return 0;

  const rng = mulberry32(state.seed + state.transitions * 7919);
  const energy = Number.isFinite(features.energy) ? Math.max(0, Math.min(1, features.energy)) : 0;
  const weights = pool.map((entry, i) => {
    // niemals sofort dieselbe Szene
    const repeat = i === state.index ? 0.05 : 1.0;
    return repeat * energyFitWeight(entry.energy, energy) * moodFitWeight(entry.mood, state.lastMood);
  });

  let total = 0;
  for (const w of weights) total += w;
  let roll = rng() * total;
  for (let i = 0; i < pool.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return (state.index + 1) % pool.length;
}

/** Szene zum Zustand — oder null, wenn der Pool leer ist. */
export function currentScene(pool: readonly PoolEntry[], state: DirectorState): PoolEntry | null {
  if (pool.length === 0) return null;
  return pool[Math.min(Math.max(state.index, 0), pool.length - 1)] ?? null;
}

export function createDirectorState(seed = 4711, nowMs = 0): DirectorState {
  return { seed, index: 0, startedAtMs: nowMs, energyRef: 0, lastMood: null, transitions: 0 };
}

export type DirectorAdvanceReason = 'duration' | 'beat' | 'energy' | null;

export interface DirectorTick {
  state: DirectorState;
  sceneIndex: number;
  advanced: boolean;
  reason: DirectorAdvanceReason;
  elapsedS: number;
}

/**
 * Ein Schritt des Regisseurs. Rein, deterministisch — dieselben Features und
 * dieselbe Zeit ergeben denselben Zustand (testbar ohne Browser).
 */
export function tickDirector(
  state: DirectorState,
  pool: readonly PoolEntry[],
  features: AudioFeatures,
  nowMs: number,
  options?: DirectorOptions,
): DirectorTick {
  const opts: Required<DirectorOptions> = { ...DIRECTOR_DEFAULTS, ...(options ?? {}) };
  if (pool.length === 0) {
    return { state, sceneIndex: -1, advanced: false, reason: null, elapsedS: 0 };
  }

  const index = Math.min(Math.max(state.index, 0), pool.length - 1);
  const scene = pool[index];
  const elapsedS = Math.max(0, (nowMs - state.startedAtMs) / 1000);
  const durationS = Math.max(1, Math.min(scene.durationS || opts.maxSceneS, opts.maxSceneS));
  const energy = Number.isFinite(features.energy) ? features.energy : 0;

  let reason: DirectorAdvanceReason = null;
  if (elapsedS >= durationS) {
    reason = 'duration';
  } else if (elapsedS >= opts.minDwellS) {
    if (features.onset >= opts.onsetThreshold) reason = 'beat';
    else if (energy - state.energyRef >= opts.energyJump) reason = 'energy';
  }

  if (!reason) {
    return { state, sceneIndex: index, advanced: false, reason: null, elapsedS };
  }

  const next = pickNextScene(pool, state, features, opts);
  const nextState: DirectorState = {
    seed: state.seed,
    index: next,
    startedAtMs: nowMs,
    energyRef: energy,
    lastMood: pool[next]?.mood ?? state.lastMood,
    transitions: state.transitions + 1,
  };
  return { state: nextState, sceneIndex: next, advanced: true, reason, elapsedS: 0 };
}
