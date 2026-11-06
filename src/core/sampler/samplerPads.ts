/**
 * audioMONASTRY · syntisamplerMONK – Pads je Bank (UI-2026-11-06-003)
 * ==================================================================
 * Der Sampler hat 16 Pads, und die Bank (A/B) ist bisher NUR eine Sicht des
 * Sequencers gewesen: `pads` war ein einziges Array, und das Audio-Ziel eines
 * Pads war `SAMPLE_TRACKS[i % 4]` ohne Bankbezug. Folge: Bank B Pad 1 schrieb
 * sein Sample auf denselben Kanal wie Bank A Pad 1 und überschrieb es – zwei
 * Bänke, ein Klang.
 *
 * Hier steht deshalb die eine Wahrheit über Pads:
 *  - jede Bank hat ihren EIGENEN Pad-Zustand (16 Pads, eigener Name/Füllstand),
 *  - jede (Bank, Pad)-Kombination hat ein deterministisches Audio-Ziel aus dem
 *    Kanal-Pool ihrer Bank (`BANK_TRACKS`), Bank A und B teilen sich keinen
 *    Kanal,
 *  - die Ablage enthält nur Regler (Slice/Loop/Reverse/Pitch) je Bank; Audio
 *    (Objekt-URLs) und Füllstände sind Sitzungszustand und werden nicht
 *    persistiert (eine blob:-URL ist nach dem Neuladen tot).
 *
 * Reine Funktionen ohne DOM/Engine – damit ist das Mapping ohne AudioContext
 * testbar (`tests/samplerPads.test.ts`).
 */
import type { TrackType } from '../../types';

export type SamplerBank = 'A' | 'B';
export const SAMPLER_BANKS: readonly SamplerBank[] = ['A', 'B'];
export const PAD_COUNT = 16;

/** Farbe je Pad-Nummer (unabhängig von der Bank). */
export const PAD_COLORS: readonly string[] = [
  '#f43f5e', '#fb7185', '#f97316', '#fbbf24',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#a855f7',
  '#d946ef', '#ec4899', '#f472b6', '#fb923c',
];

/**
 * Audio-Ziele je Bank. Vier Sample-Stimmen pro Bank, disjunkt zwischen den
 * Bänken: Bank A nutzt die Kanäle 4/5/6/8 (syntisampler-Rolle), Bank B die
 * übrigen 1/2/3/7. Innerhalb einer Bank teilen sich die Pads die vier Stimmen
 * (mehr Sample-Kanäle gibt der Mixer nicht her) – welches Sample eine Stimme
 * gerade hält, entscheidet `auditionPad` beim Anschlag anhand der Pad-URL.
 */
export const BANK_TRACKS: Readonly<Record<SamplerBank, readonly TrackType[]>> = {
  A: ['channel4', 'channel5', 'channel6', 'channel8'],
  B: ['channel1', 'channel2', 'channel3', 'channel7'],
};

export interface SamplerPad {
  name: string;
  filled: boolean;
  color: string;
  slice: number;
  loop: boolean;
  reverse: boolean;
  pitch: number;
  /** Sample dieses Pads (Objekt-URL); nur zur Laufzeit, nicht persistiert. */
  url?: string;
  /** Länge des aufgenommenen Samples in Sekunden (Anzeige). */
  seconds?: number;
  bpm?: number;
  key?: string;
  analyzing?: boolean;
}

export type PadsByBank = Record<SamplerBank, SamplerPad[]>;
/** Persistierter Reglerstand eines Pads (ohne Audio/Füllstand). */
export type PadTuning = Pick<SamplerPad, 'slice' | 'loop' | 'reverse' | 'pitch'>;
export type PadsTuning = Record<SamplerBank, PadTuning[]>;

/** Eindeutiger Schlüssel eines Pads über beide Bänke. */
export const padSlot = (bank: SamplerBank, index: number): string => `${bank}:${index}`;

/** Audio-Ziel eines Pads – bank- und padspezifisch, deterministisch. */
export const padTrack = (bank: SamplerBank, index: number): TrackType => {
  const tracks = BANK_TRACKS[bank] ?? BANK_TRACKS.A;
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return tracks[i % tracks.length];
};

export const emptyPads = (): SamplerPad[] =>
  PAD_COLORS.map((color, i) => ({
    name: `PAD ${String(i + 1).padStart(2, '0')}`,
    filled: false,
    color,
    slice: 1,
    loop: false,
    reverse: false,
    pitch: 0,
  }));

export const emptyPadsByBank = (): PadsByBank => ({ A: emptyPads(), B: emptyPads() });

/** Erstes freies Pad (Index) oder -1, wenn alle belegt sind. */
export function firstFreePad(pads: readonly SamplerPad[]): number {
  for (let i = 0; i < pads.length; i++) if (!pads[i]?.filled) return i;
  return -1;
}

/**
 * Ändert genau ein Pad einer Bank. Die andere Bank bleibt referenzgleich –
 * ein Capture in Bank B löst kein Neuzeichnen von Bank A aus.
 */
export function updateBankPad(
  state: PadsByBank,
  bank: SamplerBank,
  index: number,
  patch: Partial<SamplerPad>,
): PadsByBank {
  const pads = state[bank];
  if (!pads || index < 0 || index >= pads.length) return state;
  return {
    ...state,
    [bank]: pads.map((p, i) => (i === index ? { ...p, ...patch } : p)),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Übernimmt nur bekannte Regler mit passendem Typ (kein fremder Stand bricht das Pad). */
function mergeTuning(base: PadTuning, saved: unknown): PadTuning {
  const out: PadTuning = { ...base };
  if (!isRecord(saved)) return out;
  const slice = saved.slice;
  if (typeof slice === 'number' && Number.isFinite(slice)) out.slice = Math.max(1, Math.min(4, Math.round(slice)));
  if (typeof saved.loop === 'boolean') out.loop = saved.loop;
  if (typeof saved.reverse === 'boolean') out.reverse = saved.reverse;
  const pitch = saved.pitch;
  if (typeof pitch === 'number' && Number.isFinite(pitch)) out.pitch = Math.max(-12, Math.min(12, Math.round(pitch)));
  return out;
}

/**
 * Liest den gespeicherten Stand. Neu: `{ A: [...], B: [...] }`.
 * Alt: ein einzelnes 16er-Array (die frühere Fassung) → gilt für Bank A.
 */
export function padsFromSettings(saved: unknown): PadsByBank {
  const base = emptyPadsByBank();
  const apply = (bank: SamplerBank, list: unknown) => {
    if (!Array.isArray(list)) return;
    base[bank] = base[bank].map((p, i) => ({ ...p, ...mergeTuning(p, list[i]) }));
  };
  if (Array.isArray(saved)) {
    apply('A', saved);
  } else if (isRecord(saved)) {
    apply('A', saved.A);
    apply('B', saved.B);
  }
  return base;
}

/** Persistierbarer Stand: nur Regler je Bank (16 Einträge je Bank). */
export function padsToSettings(state: PadsByBank): PadsTuning {
  const tuning = (pads: readonly SamplerPad[]): PadTuning[] =>
    pads.map(({ slice, loop, reverse, pitch }) => ({ slice, loop, reverse, pitch }));
  return { A: tuning(state.A), B: tuning(state.B) };
}

/** Strukturelle Sicht auf die Engine, die `auditionPad` braucht (testbar ohne Engine). */
export interface PadAudioApi {
  getTrackSampleUrl(track: TrackType): string | null;
  loadTrackSample(track: TrackType, url: string | null): Promise<void>;
  triggerEvent(track: TrackType, velocity?: number): void;
  setChannelPan(track: TrackType, pan: number): void;
}

/**
 * Schlägt ein Pad an. Hält der Ziel-Track noch ein anderes Sample, wird das
 * Pad-Sample zuerst nachgeladen – sonst spielte das Pad den Klang eines anderen
 * Pads derselben Bank (die vier Stimmen werden geteilt).
 */
export async function auditionPad(
  api: PadAudioApi,
  track: TrackType,
  pad: SamplerPad,
  velocity = 0.9,
  stepPitch = 0,
): Promise<void> {
  if (!pad.filled) return;
  if (pad.url && api.getTrackSampleUrl(track) !== pad.url) {
    await api.loadTrackSample(track, pad.url);
  }
  api.triggerEvent(track, velocity);
  const pitch = (pad.pitch ?? 0) + stepPitch;
  if (pitch !== 0) api.setChannelPan(track, Math.max(-1, Math.min(1, pitch / 12)));
}
