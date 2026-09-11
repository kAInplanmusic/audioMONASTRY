/**
 * audioMONASTRY · Preset-Schema der optionalen DSP-Bausteine (FEAT-P3-002)
 * =======================================================================
 * Die vier getesteten Kerne aus FEAT-P3-001 werden hier an die 16 MONKs
 * gebunden, mit Defaults und Wertebereichen. Das Schema ist die **einzige**
 * Quelle für UI (Panel), Adapter (Werte → Audio-Pfad) und Persistenz
 * (JSON), damit ein Preset nicht an drei Stellen unterschiedlich interpretiert
 * wird.
 *
 * Zuordnung (Produktentscheidung, dokumentiert in docs/DSP_OPTIONAL_BLOCKS_2026.md):
 *
 *   | Baustein          | MONK           | Art       |
 *   |-------------------|----------------|-----------|
 *   | mod-matrix        | `dsp`          | processor |
 *   | phase-distortion  | `syntisampler` | source    |
 *   | electric-piano    | `instru`       | source    |
 *   | hq-reverb         | `effect`       | processor |
 *
 * Bewusst ohne DOM/Audio-Kontext — vollständig ohne Browser testbar.
 */

export type OptionalDspBlock = 'mod-matrix' | 'phase-distortion' | 'electric-piano' | 'hq-reverb';

export type OptionalDspMonk = 'dsp' | 'syntisampler' | 'instru' | 'effect';

export interface OptionalDspBlockSpec {
  block: OptionalDspBlock;
  /** Kanonischer Plugin-Adapter (MONK), dem der Baustein zugeordnet ist. */
  monk: OptionalDspMonk;
  kind: 'processor' | 'source';
  label: string;
  defaults: Readonly<Record<string, number>>;
  /** Erlaubter Bereich je Parameter (inklusive). */
  ranges: Readonly<Record<string, readonly [number, number]>>;
}

export interface OptionalDspPreset {
  block: OptionalDspBlock;
  enabled: boolean;
  params: Record<string, number>;
}

export const OPTIONAL_DSP_BLOCKS: Readonly<Record<OptionalDspBlock, OptionalDspBlockSpec>> = {
  'mod-matrix': {
    block: 'mod-matrix',
    monk: 'dsp',
    kind: 'processor',
    label: 'Modulations-Matrix (LFO → Master-Gain)',
    defaults: { rate: 0.5, depth: 0.35 },
    ranges: { rate: [0.05, 10], depth: [0, 1] },
  },
  'phase-distortion': {
    block: 'phase-distortion',
    monk: 'syntisampler',
    kind: 'source',
    label: 'Phase-Distortion-Oszillator (Casio CZ)',
    defaults: { freq: 440, amount: 0.6 },
    ranges: { freq: [20, 20000], amount: [0, 1] },
  },
  'electric-piano': {
    block: 'electric-piano',
    monk: 'instru',
    kind: 'source',
    label: 'E-Piano (FM-Stimme)',
    defaults: { freq: 440, modIndex: 2.4 },
    ranges: { freq: [20, 20000], modIndex: [0, 12] },
  },
  'hq-reverb': {
    block: 'hq-reverb',
    monk: 'effect',
    kind: 'processor',
    label: 'HQ-Reverb (4-Leitungs-FDN)',
    defaults: { mix: 0.3, decayS: 2, damping: 0.35, sizeScale: 1 },
    ranges: { mix: [0, 1], decayS: [0.05, 30], damping: [0, 1], sizeScale: [0.2, 3] },
  },
};

export const OPTIONAL_DSP_BLOCK_IDS: readonly OptionalDspBlock[] = [
  'mod-matrix',
  'phase-distortion',
  'electric-piano',
  'hq-reverb',
] as const;

export function optionalDspSpec(block: OptionalDspBlock): OptionalDspBlockSpec {
  return OPTIONAL_DSP_BLOCKS[block];
}

/** Default-Preset (deaktiviert — erst „an“ macht den Baustein hörbar). */
export function defaultOptionalDspPreset(block: OptionalDspBlock): OptionalDspPreset {
  const spec = optionalDspSpec(block);
  return { block, enabled: false, params: { ...spec.defaults } };
}

export function defaultOptionalDspPresets(): Record<OptionalDspBlock, OptionalDspPreset> {
  return {
    'mod-matrix': defaultOptionalDspPreset('mod-matrix'),
    'phase-distortion': defaultOptionalDspPreset('phase-distortion'),
    'electric-piano': defaultOptionalDspPreset('electric-piano'),
    'hq-reverb': defaultOptionalDspPreset('hq-reverb'),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/**
 * Prüft und normalisiert ein Preset. Unbekannte Bausteine/Parameter und
 * Nicht-Zahlen werfen (kein stiller Default), Werte außerhalb des Bereichs
 * werden **geklemmt** und als `clamped` gemeldet — so sieht die UI ehrlich,
 * dass ein Wert korrigiert wurde.
 */
export function parseOptionalDspPreset(data: unknown): { preset: OptionalDspPreset; clamped: string[] } {
  assert(isObj(data), 'DSP-Preset muss ein Objekt sein');
  const block = data.block;
  assert(typeof block === 'string' && block in OPTIONAL_DSP_BLOCKS, `unbekannter DSP-Baustein: ${String(block)}`);
  const spec = OPTIONAL_DSP_BLOCKS[block as OptionalDspBlock];
  const enabled = data.enabled === true;
  assert(data.enabled === undefined || typeof data.enabled === 'boolean', 'enabled muss boolean sein');
  const rawParams = data.params === undefined ? {} : data.params;
  assert(isObj(rawParams), 'params muss ein Objekt sein');

  const clamped: string[] = [];
  const params: Record<string, number> = {};
  for (const [name, value] of Object.entries(rawParams)) {
    const range = spec.ranges[name];
    assert(range, `unbekannter Parameter ${name} für ${spec.block}`);
    assert(typeof value === 'number' && Number.isFinite(value), `${name} muss eine endliche Zahl sein`);
    const [min, max] = range;
    const next = Math.min(max, Math.max(min, value));
    if (next !== value) clamped.push(`${name}: ${value} → ${next}`);
    params[name] = next;
  }
  // Fehlende Parameter mit dem Default auffüllen (vorwärtskompatibel).
  for (const [name, value] of Object.entries(spec.defaults)) {
    if (params[name] === undefined) params[name] = value;
  }
  return { preset: { block: spec.block, enabled, params }, clamped };
}

/** Serialisiert Presets als JSON (Persistenz; z. B. localStorage/Plugin-Snapshot). */
export function serializeOptionalDspPresets(presets: readonly OptionalDspPreset[]): string {
  const clean = presets.map((p) => ({
    block: p.block,
    enabled: p.enabled === true,
    params: { ...p.params },
  }));
  return JSON.stringify({ version: 1, presets: clean });
}

/** Liest Presets zurück; wirft bei kaputtem JSON/Inhalt (kein stiller Reset). */
export function parseOptionalDspPresets(json: string): OptionalDspPreset[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error(`DSP-Presets sind kein gültiges JSON: ${(e as Error).message}`);
  }
  assert(isObj(data), 'DSP-Preset-Container muss ein Objekt sein');
  assert(Array.isArray(data.presets), 'presets muss ein Array sein');
  return data.presets.map((entry) => parseOptionalDspPreset(entry).preset);
}
