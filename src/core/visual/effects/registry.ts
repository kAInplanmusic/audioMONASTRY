/**
 * audioMONASTRY · VisualMONK – die 25 Medien-Effekte und ihr Regisseur
 * ====================================================================
 * Reine Daten und Logik (ohne GPU): welche Effekte es gibt, wie sie sich
 * gruppieren, was sie antreibt, und welche Kombination der Regisseur pro
 * Szene wählt. Die Shader stehen in `shaders.ts`, die GPU-Stufe in `chain.ts`.
 *
 * Alle 25 stehen als Modul bereit. Gleichzeitig sind nur wenige sinnvoll
 * (25 übereinander ergäben Brei), deshalb wählt der Regisseur je Szene
 * höchstens `max` (Standard 3) Effekte und lässt je Gruppe (Mosaik, Stilisierung)
 * nur einen zu. Er ist deterministisch: gleicher Seed + gleiche Features = gleiche Wahl.
 */
import type { AudioFeatures } from '../types';

export type EffectGroup = 'geo' | 'mosaic' | 'stylize' | 'trail' | 'post';

type Driver = 'bass' | 'mid' | 'treble' | 'onset' | 'energy';

export interface EffectDef {
  id: string;
  /** Anzeigename (deutsch). */
  label: string;
  group: EffectGroup;
  /** Reihenfolge in der Kette: kleiner = früher (Geometrie vor Stilisierung vor Nachbearbeitung). */
  stage: number;
  /** Wie stark welches Audio-Band den Effekt antreibt (0..1). */
  drivers: Partial<Record<Driver, number>>;
  /** Passt auch zu ruhiger Musik (bekommt einen Bonus bei niedriger Energie). */
  calm?: boolean;
  /** Liest vorherige Frames (Rückkopplung). */
  history?: boolean;
}

export const EFFECTS: readonly EffectDef[] = [
  { id: 'edge', label: 'Edge Detection', group: 'stylize', stage: 30, drivers: { treble: 0.8, energy: 0.3 } },
  { id: 'hexpixel', label: 'Hexagon Pixelation', group: 'mosaic', stage: 20, drivers: { bass: 0.6, energy: 0.4 } },
  { id: 'voronoi', label: 'Voronoi Glitch', group: 'mosaic', stage: 20, drivers: { onset: 0.7, bass: 0.3 } },
  { id: 'ascii', label: 'ASCII (geometrisch)', group: 'stylize', stage: 30, drivers: { mid: 0.5, energy: 0.3 } },
  { id: 'triangulate', label: 'Triangulate', group: 'mosaic', stage: 20, drivers: { bass: 0.7, energy: 0.2 } },
  { id: 'feedback', label: 'Feedback-Schleife', group: 'trail', stage: 40, drivers: { bass: 0.5, energy: 0.5 }, history: true },
  { id: 'echo', label: 'Echo Trace / Trails', group: 'trail', stage: 41, drivers: { energy: 0.4, mid: 0.3 }, calm: true, history: true },
  { id: 'pixelsort', label: 'Pixel Sorting', group: 'stylize', stage: 30, drivers: { mid: 0.5, onset: 0.3 } },
  { id: 'cloner', label: 'Linear Cloner', group: 'geo', stage: 12, drivers: { bass: 0.4, onset: 0.5 } },
  { id: 'cornertint', label: 'Corner Color Tint', group: 'post', stage: 52, drivers: { energy: 0.1 }, calm: true },
  { id: 'contrast', label: 'Bright/Contrast', group: 'post', stage: 53, drivers: { onset: 0.5, treble: 0.4 } },
  { id: 'dither', label: 'Dithering', group: 'stylize', stage: 30, drivers: { treble: 0.3, mid: 0.3 } },
  { id: 'geoascii', label: 'Geometric ASCII', group: 'stylize', stage: 30, drivers: { mid: 0.6 } },
  { id: 'glyph', label: 'Text-ASCII (Glyph Atlas)', group: 'stylize', stage: 30, drivers: { mid: 0.4, treble: 0.3 } },
  { id: 'glitch', label: 'Glitch', group: 'post', stage: 58, drivers: { onset: 0.9 } },
  { id: 'bloom', label: 'Bloom', group: 'post', stage: 50, drivers: { energy: 0.5 }, calm: true },
  { id: 'noise', label: 'Procedural Noise', group: 'post', stage: 56, drivers: { treble: 0.4 }, calm: true },
  { id: 'kaleido', label: 'Kaleidoscope', group: 'geo', stage: 11, drivers: { energy: 0.7, treble: 0.3 } },
  { id: 'mirrorquad', label: 'Mirror Quad', group: 'geo', stage: 11, drivers: { energy: 0.5 } },
  { id: 'halftone', label: 'Dot Screen / Halftone', group: 'stylize', stage: 30, drivers: { mid: 0.4, bass: 0.2 } },
  { id: 'huerotate', label: 'Hue Rotate', group: 'post', stage: 54, drivers: { mid: 0.5 }, calm: true },
  { id: 'delayrgb', label: 'Delay RGB', group: 'post', stage: 55, drivers: { bass: 0.5, onset: 0.3 }, history: true },
  { id: 'twitch', label: 'Twitch', group: 'geo', stage: 10, drivers: { onset: 0.8 } },
  { id: 'distort', label: 'Distortion / Noise Distort', group: 'geo', stage: 10, drivers: { bass: 0.4, mid: 0.5 }, calm: true },
  { id: 'rgbsplit', label: 'RGB Split', group: 'post', stage: 51, drivers: { onset: 0.7, bass: 0.4 } },
] as const;

export const EFFECT_IDS: readonly string[] = EFFECTS.map((e) => e.id);

const BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));

export function effectById(id: string): EffectDef | undefined {
  return BY_ID.get(id);
}

export interface EffectPick {
  id: string;
  /** 0..1 */
  amount: number;
}

/** Ordnet Picks in Kettenreihenfolge und entfernt unbekannte/doppelte Einträge. */
export function orderPicks(picks: readonly EffectPick[]): EffectPick[] {
  const seen = new Set<string>();
  const out: EffectPick[] = [];
  for (const pick of picks) {
    const def = BY_ID.get(pick.id);
    if (!def || seen.has(pick.id) || !(pick.amount > 0)) continue;
    seen.add(pick.id);
    out.push({ id: pick.id, amount: Math.min(1, pick.amount) });
  }
  return out.sort((a, b) => BY_ID.get(a.id)!.stage - BY_ID.get(b.id)!.stage);
}

export interface DirectorState {
  /** Aktuell gewählte Effekt-IDs. */
  picks: string[];
  sinceMs: number;
  sceneKey: string;
}

export interface DirectorOptions {
  /** Höchstzahl gleichzeitiger Effekte (1..4). */
  max: number;
  seed: number;
  /** Frühestens nach so vielen Sekunden darf ein Beat die Auswahl ändern. */
  minDwellS: number;
}

export const DIRECTOR_DEFAULTS: DirectorOptions = { max: 3, seed: 0, minDwellS: 3 };

export function createDirector(): DirectorState {
  return { picks: [], sinceMs: 0, sceneKey: '' };
}

function hash(seed: number, text: string, index: number): number {
  let h = 2166136261 ^ (seed | 0);
  const s = text + '#' + index;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function drive(def: EffectDef, f: AudioFeatures): number {
  let sum = 0;
  let weight = 0;
  for (const [key, w] of Object.entries(def.drivers) as [Driver, number][]) {
    sum += w * Math.max(0, Math.min(1, f[key]));
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}

function select(f: AudioFeatures, sceneKey: string, o: DirectorOptions): string[] {
  const energy = Math.max(0, Math.min(1, f.energy));
  const scored = EFFECTS.map((def, i) => {
    const calmBonus = def.calm && energy < 0.35 ? 0.3 : 0;
    return { def, score: drive(def, f) + calmBonus + 0.55 * hash(o.seed, sceneKey, i) };
  }).sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(4, Math.round(o.max)));
  // Je lauter, desto mehr Effekte gleichzeitig (1 bei Ruhe, bis `limit` bei Höhepunkten).
  const count = Math.max(1, Math.min(limit, 1 + Math.round(energy * (limit - 1))));
  const chosen: string[] = [];
  const used = new Set<EffectGroup>();
  for (const { def } of scored) {
    if (chosen.length >= count) break;
    // Mosaik und Stilisierung nie doppelt: sonst entsteht Brei.
    if ((def.group === 'mosaic' || def.group === 'stylize') && (used.has('mosaic') || used.has('stylize'))) continue;
    if (def.group === 'trail' && used.has('trail')) continue;
    chosen.push(def.id);
    used.add(def.group);
  }
  return chosen;
}

/**
 * Ein Regie-Schritt pro Frame. Die Auswahl ändert sich nur bei Szenenwechsel,
 * bei einem harten Beat nach der Mindest-Standzeit oder nach 12 s; die Stärken
 * folgen dagegen jeden Frame dem Klang.
 */
export function directEffects(
  state: DirectorState,
  features: AudioFeatures,
  nowMs: number,
  sceneKey: string,
  options: Partial<DirectorOptions> = {},
): { state: DirectorState; picks: EffectPick[] } {
  const o = { ...DIRECTOR_DEFAULTS, ...options };
  const dwellS = (nowMs - state.sinceMs) / 1000;
  const sceneChanged = sceneKey !== state.sceneKey;
  const beat = features.onset >= 0.8 && dwellS >= o.minDwellS;
  let next = state;
  if (state.picks.length === 0 || sceneChanged || beat || dwellS >= 12) {
    next = { picks: select(features, sceneKey, o), sinceMs: nowMs, sceneKey };
  }
  const picks = next.picks.map((id) => {
    const def = BY_ID.get(id)!;
    return { id, amount: Math.max(0.25, Math.min(1, 0.25 + 0.75 * drive(def, features))) };
  });
  return { state: next, picks: orderPicks(picks) };
}
