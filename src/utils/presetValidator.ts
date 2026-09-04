// src/utils/presetValidator.ts – ohne zod (Bundle-Diät P2-5)
// Manuelle Validierung für Routing-Presets und Gemini-Synth-Presets.
// API bleibt kompatibel: validatePreset / validateGeminiPreset werfen bei
// ungültigen Daten (wie vorher zod .parse).

import { TRACK_ROLE_MAP, TrackRole, ALL_ROLES, emptyPatterns } from '../types';

export interface PresetTrack {
  id: string;
  instrument: string;
  params?: Record<string, unknown>;
  effects?: Array<{ type: string; params?: Record<string, unknown> }>;
  output: string;
  patterns?: boolean[];
}

export interface Preset {
  global?: { tempo?: number; masterVolume?: number };
  tracks?: PresetTrack[];
  buses?: Array<{ id: string; effects?: Array<{ type: string; params?: Record<string, unknown> }>; output: string }>;
  connections?: Array<{ source: string; destination: string }>;
}

export interface GeminiPreset {
  name?: string;
  bpm: number;
  cutoff: number;
  resonance: number;
  decay: number;
  engine?: 'SUBTRACTIVE' | 'FM' | 'WAVETABLE';
  patterns?: Record<string, boolean[]>;
  synthNotes?: number[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function validatePreset(data: unknown): Preset {
  if (!isObj(data)) throw new Error('Preset muss ein Objekt sein');
  if (data.global !== undefined) {
    assert(isObj(data.global), 'global muss ein Objekt sein');
    if (data.global.tempo !== undefined) assert(isNum(data.global.tempo) && data.global.tempo >= 30 && data.global.tempo <= 300, 'tempo muss 30..300 sein');
    if (data.global.masterVolume !== undefined) assert(isNum(data.global.masterVolume) && data.global.masterVolume >= -100 && data.global.masterVolume <= 0, 'masterVolume muss -100..0 sein');
  }
  if (data.tracks !== undefined) {
    assert(Array.isArray(data.tracks), 'tracks muss ein Array sein');
    for (const t of data.tracks as unknown[]) {
      assert(isObj(t), 'Track muss ein Objekt sein');
      assert(isStr(t.id) && isStr(t.instrument) && isStr(t.output), 'Track id/instrument/output müssen Strings sein');
    }
  }
  if (data.buses !== undefined) {
    assert(Array.isArray(data.buses), 'buses muss ein Array sein');
    for (const b of data.buses as unknown[]) {
      assert(isObj(b), 'Bus muss ein Objekt sein');
      assert(isStr(b.id) && isStr(b.output), 'Bus id/output müssen Strings sein');
    }
  }
  if (data.connections !== undefined) {
    assert(Array.isArray(data.connections), 'connections muss ein Array sein');
    for (const c of data.connections as unknown[]) {
      assert(isObj(c) && isStr(c.source) && isStr(c.destination), 'Connection source/destination müssen Strings sein');
    }
  }
  return data as unknown as Preset;
}

export function validateGeminiPreset(data: unknown): GeminiPreset {
  if (!isObj(data)) throw new Error('Gemini-Preset muss ein Objekt sein');
  const { name, bpm, cutoff, resonance, decay, engine } = data;
  if (name !== undefined) assert(isStr(name), 'name muss ein String sein');
  assert(isNum(bpm) && bpm >= 60 && bpm <= 250, 'bpm muss 60..250 sein');
  assert(isNum(cutoff) && cutoff >= 20 && cutoff <= 20000, 'cutoff muss 20..20000 sein');
  assert(isNum(resonance) && resonance >= 0 && resonance <= 20, 'resonance muss 0..20 sein');
  assert(isNum(decay) && decay >= 0 && decay <= 1, 'decay muss 0..1 sein');
  if (engine !== undefined) assert(engine === 'SUBTRACTIVE' || engine === 'FM' || engine === 'WAVETABLE', 'engine muss SUBTRACTIVE/FM/WAVETABLE sein');
  return data as unknown as GeminiPreset;
}

// --- Track-Role-Validierung (einheitliches Datenmodell) ---
export const TRACK_ROLE_ORDER: TrackRole[] = [...ALL_ROLES];

/**
 * Prüft, dass Patterns die erwartete Spurenstruktur haben und jede Spur
 * den semantischen Rollen zugeordnet ist (channel1..channel8).
 */
export function validateTrackPreset(patterns: unknown): boolean {
  if (!patterns || typeof patterns !== 'object') return false;
  const p = patterns as Record<string, unknown>;
  for (const track of Object.keys(TRACK_ROLE_MAP)) {
    const steps = p[track];
    if (!Array.isArray(steps) || steps.length !== 16) {
      return false;
    }
    if (!steps.every((s) => typeof s === 'boolean')) return false;
  }
  return true;
}

/** Stellt sicher, dass Patterns vollständig (alle 8 Spuren à 16 Steps) sind. */
export function normalizePatterns(input: unknown): Record<string, boolean[]> {
  const base = emptyPatterns();
  if (!input || typeof input !== 'object') return base as unknown as Record<string, boolean[]>;
  const asRecord = input as Record<string, unknown>;
  for (const track of Object.keys(base) as (keyof typeof base)[]) {
    if (Array.isArray(asRecord[track])) {
      const arr = asRecord[track] as unknown[];
      base[track] = arr.slice(0, 16).map((v) => !!v);
      while (base[track].length < 16) base[track].push(false);
    }
  }
  return base as unknown as Record<string, boolean[]>;
}
