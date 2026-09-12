/**
 * audioMONASTRY · Instrument-Note-Bridge (AUDIO-P1-002 · aus `audioEngine` ausgelagert)
 * ==================================================================================
 * Kapselt die instrumentMONK-Noten-Steuerung an den V2-Sink und den
 * it-synth-Worklet (Note-On/Off, All-Notes-Off, Automation) sowie die reine
 * Abbildung einer Instrument-Definition auf ein Worklet-`PitchDef`.
 *
 * Ohne Engine-Zustand: Sink und Worklet-Node werden hereingereicht.
 */
import { INSTRUMENT_PATCHES } from '../data/instrumentSynths';
import type { InstrumentDefinition } from '../core/instrument/types';
import type { V2LiveSink } from '../core/audio/backends/V2LiveSink';

export interface InstrumentNoteBridgeDeps {
  getSink(): V2LiveSink;
  getItSynthNode(): AudioWorkletNode | null;
  isItSynthReady(): boolean;
}

/** Wandelt eine instrumentMONK-Definition in ein worklet-taugliches PitchDef um (rein). */
export function toPitchDef(def: InstrumentDefinition): Record<string, unknown> {
  const a = def as unknown as Record<string, unknown>;
  const common: Record<string, unknown> = {
    id: def.id, name: def.name, kind: def.kind,
    attack: a.attack ?? 0.01,
    release: a.release ?? 0.3,
    cutoff: a.cutoff ?? a.filterFreq,
    resonance: a.resonance ?? a.filterQ,
    osc: a.osc ?? a.wave,
  };
  if (def.kind === 'acoustic') { common.partials = a.partials; common.sustain = (a.env as unknown[])?.[2]; common.decay = (a.env as unknown[])?.[1]; }
  if (def.kind === 'fm') { common.modulatorOsc = a.modulator; common.modIndex = a.modIndex; common.ratio = 2; }
  if (def.kind === 'drum') { common.freqStart = a.freqStart; common.freqEnd = a.freqEnd; common.noise = a.noise; common.noiseFilter = a.filterFreq; common.multiBurst = a.multiBurst; common.click = a.click; common.decay = a.decay; }
  if (def.kind === 'fx') { common.lfoRate = a.lfoRate; common.freq = a.freq; common.freqStartHZ = a.freqStart; common.freqEndHZ = a.freqEnd; common.resonance = a.resonance; common.noiseType = a.noiseType; common.wobble = 0.15; }
  return common;
}

/** Instrument-Patch-Katalog (unverändert durchgereicht). */
export function instrumentPatches() {
  return INSTRUMENT_PATCHES;
}

export class InstrumentNoteBridge {
  constructor(private readonly deps: InstrumentNoteBridgeDeps) {}

  /** Steuert den Synth (Note-On) – Phase 9: hörbar über den V2-Sink. */
  noteOn(freq: number, velocity = 1): void {
    this.deps.getSink().setSynthSource('channel8', Math.max(20, Math.min(20000, freq)), 'lead');
    this.deps.getSink().synthTrigger('channel8', Math.max(0.2, Math.min(1, velocity)));
  }

  noteOff(): void {
    this.deps.getSink().stopSample('channel8');
  }

  /** Harte Note-Aus (alle Stimmen) – für Umschalten/Stop. */
  allNotesOff(): void {
    this.deps.getItSynthNode()?.port.postMessage({ type: 'allNotesOff' });
  }

  /** Sendet eine sample-genaue Automations-Rampe an den instrumentMONK-Worklet. */
  automate(
    param: 'cutoff' | 'resonance' | 'modIndex' | 'gain' | 'lfoRate' | 'lfoDepth',
    value: number,
    rampTime = 0.02,
  ): void {
    if (!this.deps.isItSynthReady()) return;
    const node = this.deps.getItSynthNode();
    if (!node) return;
    node.port.postMessage({ type: 'automate', param, value, rampTime });
  }
}
