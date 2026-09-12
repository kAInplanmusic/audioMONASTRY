/**
 * audioMONASTRY · Worklet-Parameter-Fassade (AUDIO-P1-002 · aus `audioEngine` ausgelagert)
 * =====================================================================================
 * Bündelt die Steuerung der AudioWorklet-Nodes (effect/dsp/eq/mastering/granular/
 * fm6/drumSynth) an einer Stelle. Die Fassade hält **keinen** Engine-Zustand:
 * die Node-Zugriffe, die Zeitquelle und die V2-Live-Spiegelung werden über
 * `WorkletParamBridgeDeps` hereingereicht. `audioEngine` delegiert nur noch.
 *
 * Verhalten unverändert: gleiche Nachrichten, gleiche Bypass-/Fallback-Pfade,
 * gleiche V2-Live-Spiegelung (AUDIO-P0-004).
 */
import { dx7SysexToPatch } from '../core/instrument/dx7Sysex';

export interface WorkletParamBridgeDeps {
  getEffectNode(): AudioWorkletNode | null;
  setEffectNode(node: AudioWorkletNode): void;
  getDynamicsNode(): AudioWorkletNode | null;
  getDspNode(): AudioWorkletNode | null;
  getMasteringNode(): AudioWorkletNode | null;
  getEqNode(): AudioWorkletNode | null;
  getGranularNode(): AudioWorkletNode | null;
  getFm6Node(): AudioWorkletNode | null;
  getDrumSynthNode(): AudioWorkletNode | null;
  /** Roher AudioContext (inkl. Tone-Fallback) für die lazy effect-Node. */
  getRawContext(): BaseAudioContext | null;
  now(): number;
  mirrorDynamics(enabled: boolean, threshold: number, ratio: number, makeup: number): void;
  mirrorFx(wet: number, feedback: number, rate: number, depth: number): void;
  mirrorDsp(cutoff: number, resonance: number, depth: number, drive: number): void;
  mirrorMastering(threshold: number, ratio: number, makeup: number, ceiling: number): void;
}

const isConnected = (node: AudioWorkletNode | null): boolean =>
  !!(node && typeof (node as unknown as { connect?: unknown }).connect === 'function');

/** Flusht gesammelte Automation-Messages an den jeweiligen Worklet-Port. */
export class WorkletParamBridge {
  constructor(private readonly deps: WorkletParamBridgeDeps) {}

  flushAutomation(key: string, payload: unknown): void {
    const target = key.split(':')[0];
    const msg = payload as Record<string, unknown>;
    try {
      switch (target) {
        case 'dynamics': this.deps.getDynamicsNode()?.port?.postMessage(msg); break;
        case 'effect': this.deps.getEffectNode()?.port?.postMessage(msg); break;
        case 'dsp': this.deps.getDspNode()?.port?.postMessage(msg); break;
        case 'mastering': this.deps.getMasteringNode()?.port?.postMessage(msg); break;
        case 'eq': this.deps.getEqNode()?.port?.postMessage(msg); break;
      }
    } catch { /* Worklet nicht verfügbar – Coalescer verwirft den Batch */ }
  }

  setWorkletParam(name: string, value: number): void {
    const node = this.deps.getDspNode();
    if (!node || typeof (node as unknown as { parameters?: { get?: unknown } }).parameters?.get !== 'function') return;
    node.parameters.get(name)?.setValueAtTime(value, this.deps.now());
  }

  isDynamicsInsertReady(): boolean {
    return isConnected(this.deps.getDynamicsNode());
  }

  isEffectInsertReady(): boolean {
    return isConnected(this.deps.getEffectNode());
  }

  isGranularReady(): boolean {
    return isConnected(this.deps.getGranularNode());
  }

  isFm6Ready(): boolean {
    return isConnected(this.deps.getFm6Node());
  }

  isDrumSynthReady(): boolean {
    return isConnected(this.deps.getDrumSynthNode());
  }

  /**
   * Dynamik-Parameter setzen (Kompressor/Gate/Dynamic EQ).
   * Ohne `enabled: true` bleibt der Insert im Bypass (Signal unverändert).
   */
  setDynamicsParams(params: {
    enabled?: boolean;
    compressor?: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number };
    gate?: { enabled?: boolean; threshold?: number; range?: number; attack?: number; hold?: number; release?: number; hysteresis?: number };
    dynEq?: { enabled?: boolean; freq?: number; q?: number; threshold?: number; ratio?: number; range?: number };
  }): void {
    try { this.deps.getDynamicsNode()?.port?.postMessage({ ...params }); } catch { /* noop */ }
    this.deps.mirrorDynamics(
      Boolean(params.enabled),
      params.compressor?.threshold ?? -18,
      params.compressor?.ratio ?? 3,
      params.compressor?.makeup ?? 0,
    );
  }

  /** Granular-Source setzen (Float32Array wird als Kopie an das Worklet gepostet). */
  loadGranularSource(buffer: Float32Array): void {
    try { this.deps.getGranularNode()?.port?.postMessage({ buffer }); } catch { /* Worklet nicht verfügbar */ }
  }

  /** Granular-Parameter setzen. */
  setGranularParams(p: {
    grainSize?: number; density?: number; position?: number; positionJitter?: number;
    pitch?: number; pitchJitter?: number; direction?: 1 | -1; freeze?: boolean; gain?: number;
  }): void {
    try { this.deps.getGranularNode()?.port?.postMessage({ ...p }); } catch { /* noop */ }
  }

  /** 6-Op-FM-Patch setzen. */
  setFm6Patch(patch: unknown): void {
    try { this.deps.getFm6Node()?.port?.postMessage({ type: 'patch', patch }); } catch { /* noop */ }
  }

  /** DX7-SysEx (156-Byte-unpacked) laden und als Patch setzen. */
  loadFm6Sysex(bytes: Uint8Array): void {
    try {
      const patch = dx7SysexToPatch(bytes);
      this.setFm6Patch(patch);
    } catch { /* ungültige SysEx – Worklet bleibt unverändert */ }
  }

  fm6NoteOn(noteHz: number, velocity = 0.8): void {
    try { this.deps.getFm6Node()?.port?.postMessage({ type: 'noteOn', noteHz, velocity }); } catch { /* noop */ }
  }

  fm6NoteOff(noteHz: number): void {
    try { this.deps.getFm6Node()?.port?.postMessage({ type: 'noteOff', noteHz }); } catch { /* noop */ }
  }

  setFm6Gain(gain: number): void {
    try { this.deps.getFm6Node()?.port?.postMessage({ type: 'gain', value: gain }); } catch { /* noop */ }
  }

  /** Synthetische Drums triggern (kick/snare/hat). */
  triggerDrumSynth(kind: 'kick' | 'snare' | 'hat'): void {
    try { this.deps.getDrumSynthNode()?.port?.postMessage({ type: kind }); } catch { /* noop */ }
  }

  setEffectParam(p: { wet?: number; feedback?: number; rate?: number; depth?: number; bits?: number; sampleReduction?: number }): void {
    let node = this.deps.getEffectNode();
    if (!node) {
      // Fallback, falls setEffectParam vor Abschluss von init() aufgerufen
      // wurde (ensureInitialized wird nicht awaited).
      try {
        const rawCtx = this.deps.getRawContext();
        if (!rawCtx) return;
        node = new AudioWorkletNode(rawCtx, 'effect-processor', { numberOfInputs: 1, numberOfOutputs: 1 });
        this.deps.setEffectNode(node);
      } catch (e) {
        console.warn('[audioEngine] effect-worklet nicht verfügbar:', (e as Error).message);
        return;
      }
    }
    try { node.port.postMessage({ ...p }); } catch { /* noop */ }
    // AUDIO-P0-004: Effekt-Parameter in den hörbaren V2-Live-Pfad spiegeln.
    this.deps.mirrorFx(p.wet ?? 0, p.feedback ?? 0.6, p.rate ?? 0.5, p.depth ?? 0.5);
  }

  /** Task 11: Mastering-Limiter/Kompression steuern (masteringProcessor). */
  setMasteringParams(p: { threshold?: number; ratio?: number; knee?: number; attack?: number; release?: number; makeup?: number; ceiling?: number }): void {
    try { this.deps.getMasteringNode()?.port?.postMessage({ ...p }); } catch { /* Gain-Fallback */ }
    // AUDIO-P0-004: Mastering-Parameter in den V2-Live-Pfad spiegeln.
    this.deps.mirrorMastering(p.threshold ?? -14, p.ratio ?? 3, p.makeup ?? 1, p.ceiling ?? 0.98);
  }

  /** Task 10: DSP-Engine steuern (Phasenkorrektur, dynamisches Filter, Drive). */
  setDspParam(p: { phase?: number; filterCutoff?: number; resonance?: number; depth?: number; drive?: number }): void {
    try { this.deps.getDspNode()?.port?.postMessage({ ...p }); } catch { /* Gain-Fallback */ }
    // AUDIO-P0-004: DSP-Parameter in den V2-Live-Pfad spiegeln.
    this.deps.mirrorDsp(p.filterCutoff ?? 20000, p.resonance ?? 0.5, p.depth ?? 0, p.drive ?? 0);
  }
}
