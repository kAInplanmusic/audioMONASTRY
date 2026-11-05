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
import type { PoolMood, PoolEnergy } from './poolManifest';

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
  /**
   * MEDIA-2026-11-04-006: zuletzt gespielte Indizes, jüngster zuletzt — die
   * Wiederholungssperre. Ohne Eintrag gilt nur `index` als gesperrt.
   */
  recent?: number[];
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
  /** MEDIA-2026-11-04-006: wie viele der zuletzt gespielten Clips gesperrt sind. */
  repeatWindow?: number;
}

export const DIRECTOR_DEFAULTS: Required<DirectorOptions> = {
  minDwellS: 3,
  onsetThreshold: 0.6,
  energyJump: 0.3,
  maxSceneS: 24,
  repeatWindow: 3,
};

/**
 * Was der Regisseur von einem Kandidaten wissen muss. `PoolEntry` erfüllt das
 * vollständig; `ShowScene` (showOrchestrator) trägt dieselben Felder optional,
 * damit der Live-Pfad denselben Regisseur nutzen kann.
 */
export interface DirectorCandidate {
  mood?: PoolMood | null;
  energy?: PoolEnergy | null;
  durationS?: number;
}

/** Energie-Präferenz einer Szene → Auswahlgewicht bei gegebenem Energielevel. */
export function energyFitWeight(entryEnergy: PoolEnergy | null | undefined, energy: number): number {
  // ruhige Quelle passt bei niedriger Energie, harte bei hoher.
  switch (entryEnergy) {
    case 'ruhig': return 1.6 - energy * 0.8;   // 1.6 (ruhig) → 0.8 (hart)
    case 'hart': return 0.7 + energy * 0.9;    // 0.7 (ruhig) → 1.6 (hart)
    // 'mittel' und unbekannt (eigene Bilder/Clips ohne Pool-Metadaten): neutral.
    default: return 1.0;
  }
}

/** Stimmungs-Rotation: bevorzugt die Stimmung, die NICHT die letzte war. */
export function moodFitWeight(mood: PoolMood | null | undefined, lastMood: PoolMood | null): number {
  if (mood == null || lastMood === null) return 1.0;
  return mood === lastMood ? 0.35 : 1.0;
}

/**
 * Nächsten Index wählen — gewichtet, aber deterministisch über den Seed.
 *
 * Sperre: die `repeatWindow` zuletzt gespielten Indizes (`state.recent`,
 * notfalls nur `state.index`) bekommen Gewicht 0. Sind dadurch ALLE Gewichte 0
 * (Pool nicht größer als das Fenster), greift der Rest des Pools bzw. der
 * Nachfolger — lieber eine Wiederholung als eine schwarze Fläche.
 */
export function pickNextScene<T extends DirectorCandidate>(
  pool: readonly T[],
  state: DirectorState,
  features: AudioFeatures,
  opts: Required<DirectorOptions>,
): number {
  if (pool.length === 0) return -1;
  if (pool.length === 1) return 0;

  const rng = mulberry32(state.seed + state.transitions * 7919);
  const energy = Number.isFinite(features.energy) ? Math.max(0, Math.min(1, features.energy)) : 0;
  const window = Math.max(1, Math.floor(opts.repeatWindow));
  const recent = (state.recent && state.recent.length > 0 ? state.recent : [state.index]).slice(-window);
  const locked = new Set<number>(recent);

  const fit = (entry: T, i: number): number =>
    locked.has(i) ? 0 : energyFitWeight(entry.energy, energy) * moodFitWeight(entry.mood, state.lastMood);

  let weights = pool.map(fit);
  let total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) {
    // Sperrfenster größer als der Pool: nur die laufende Szene bleibt gesperrt,
    // damit auch bei zwei Clips nicht zweimal derselbe hintereinander kommt.
    weights = pool.map((entry, i) =>
      i === state.index ? 0 : energyFitWeight(entry.energy, energy) * moodFitWeight(entry.mood, state.lastMood),
    );
    total = weights.reduce((sum, w) => sum + w, 0);
  }
  if (total <= 0) return (state.index + 1) % pool.length;

  let roll = rng() * total;
  for (let i = 0; i < pool.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return (state.index + 1) % pool.length;
}

/**
 * Seed aus einer Session-Kennung ableiten (FNV-1a, 32 bit).
 *
 * Gleiche Kennung → gleicher Seed → gleiche Show. Der Live-Pfad legt die
 * Kennung einmal je Browser-Session ab; damit startet nicht jede Show mit
 * derselben Szene, bleibt aber innerhalb der Session reproduzierbar.
 */
export function deriveSessionSeed(source: string | number): number {
  const text = String(source);
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** Szene zum Zustand — oder null, wenn der Pool leer ist. */
export function currentScene<T extends DirectorCandidate>(pool: readonly T[], state: DirectorState): T | null {
  if (pool.length === 0) return null;
  return pool[Math.min(Math.max(state.index, 0), pool.length - 1)] ?? null;
}

export function createDirectorState(seed = 4711, nowMs = 0): DirectorState {
  return { seed, index: 0, startedAtMs: nowMs, energyRef: 0, lastMood: null, transitions: 0, recent: [0] };
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
export function tickDirector<T extends DirectorCandidate>(
  state: DirectorState,
  pool: readonly T[],
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
  // MEDIA-2026-11-04-006: Wiederholungssperre mitführen (jüngster zuletzt).
  const window = Math.max(1, Math.floor(opts.repeatWindow));
  const recent = [...(state.recent && state.recent.length > 0 ? state.recent : [index]), next].slice(-window);
  const nextState: DirectorState = {
    seed: state.seed,
    index: next,
    startedAtMs: nowMs,
    energyRef: energy,
    lastMood: pool[next]?.mood ?? state.lastMood,
    transitions: state.transitions + 1,
    recent,
  };
  return { state: nextState, sceneIndex: next, advanced: true, reason, elapsedS: 0 };
}
