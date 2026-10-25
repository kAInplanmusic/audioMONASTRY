/**
 * src/core/audio/nodes/wasmDspNodes.ts
 * =====================================
 * V2-Audio-Nodes, die den Rust/WASM-DSP-Kern (ABI v2) nutzen.
 * Alle Nodes sind BYPASS-TRANSPARENT (enabled default 0) und allocation-free
 * im Prozess: Scratch-Puffer werden einmal im Konstruktor angelegt.
 *
 * Der Kernel wird injiziert (DspKernelLike | null). Ist er null, fällt die
 * Node auf die reine TypeScript-Referenz (`ReferenceDspKernel`) zurück –
 * damit laufen Tests und Offline-Render auch ohne `wasm32-unknown-unknown`.
 *
 * WICHTIG: Eine Kernel-Instanz hält EINEN Filter-/Kompressor-Zustand.
 * Wird dieselbe Instanz in mehrere Nodes eingespeist, teilen sie sich den
 * Zustand (unbeabsichtigt). Für mehrere Biquads/Kompressoren je Graph muss
 * der Graph-Builder pro Node eine eigene Instanz erzeugen
 * (`WasmBackend.createKernel()`).
 */
import { AudioParameter } from '../AudioGraph';
import { BaseNode } from './basicNodes';
import type { IProcessingContext } from '../types';
import type { AutomatableV2Node } from '../state/v2NodeAutomation';
import type { DspKernelLike, FilterParams } from '../../../audio/wasm/dspKernelWasm';
import { ReferenceDspKernel } from '../../../audio/wasm/dspReference';

/** Blocklänge, für die die Scratch-Puffer im Konstruktor angelegt werden.
 *  2048 Samples à 4 Kanäle × 4 Byte = 32 KiB pro Node – klein genug für
 *  viele Instanzen, groß genug für alle Echtzeit-Blockgrößen (typisch 128/256).
 *  Wächst ein Block darüber (Offline-Render), wird einmalig nachallokiert. */
const SCRATCH_BLOCK = 2048;

/** Biquad-Modus als Zahl (C-ABI-konform). */
export const BIQUAD_MODE_LOWPASS = 0;
export const BIQUAD_MODE_HIGHPASS = 1;
export const BIQUAD_MODE_BANDPASS = 2;

/** Basisklasse für alle WASM-DSP-Nodes (gemeinsame Bypass-Logik, Scratch-Buffer). */
abstract class WasmDspNode extends BaseNode implements AutomatableV2Node {
  readonly enabled: AudioParameter;
  protected readonly kernel: DspKernelLike;
  /** true = echter WASM-Kern, false = TS-Referenz (Fallback). */
  readonly usesWasmKernel: boolean;

  /** Scratch-Puffer für den Kernel-Aufruf (L/R ein/aus). */
  protected inL = new Float32Array(SCRATCH_BLOCK);
  protected inR = new Float32Array(SCRATCH_BLOCK);
  protected outL = new Float32Array(SCRATCH_BLOCK);
  protected outR = new Float32Array(SCRATCH_BLOCK);

  constructor(id: string, type: string, kernel: DspKernelLike | null) {
    super(id, type, 1, 1);
    this.kernel = kernel ?? new ReferenceDspKernel();
    this.usesWasmKernel = kernel !== null;
    this.enabled = new AudioParameter('enabled', 0, 1, 0);
    this.parameters.push(this.enabled);
  }

  setEnabled(active: boolean): void {
    this.enabled.setValue(active ? 1 : 0);
  }

  /** Liefert true, wenn die Node aktiv ist (enabled > 0.5). */
  protected isActive(ctx: IProcessingContext): boolean {
    return this.enabled.getValueAtTime(ctx.currentTime) > 0.5;
  }

  /** Stellt sicher, dass die Scratch-Puffer `len` Samples fassen.
   *  Gibt die Views zurück; bei erstem Überlauf wächst das Array (einmalig). */
  private ensureScratch(len: number): {
    inL: Float32Array;
    inR: Float32Array;
    outL: Float32Array;
    outR: Float32Array;
  } {
    if (len <= this.inL.length) {
      return { inL: this.inL, inR: this.inR, outL: this.outL, outR: this.outR };
    }
    const grow = Math.max(len, this.inL.length * 2);
    this.inL = new Float32Array(grow);
    this.inR = new Float32Array(grow);
    this.outL = new Float32Array(grow);
    this.outR = new Float32Array(grow);
    return { inL: this.inL, inR: this.inR, outL: this.outL, outR: this.outR };
  }

  /**
   * Kopiert Kanal 0/1 des `out`-Puffers in die Scratch-Eingänge,
   * ruft `kernelCall(len)` auf, kopiert die Ergebnisse zurück.
   * Kanäle ≥ 2 bleiben unverändert (durch `prepareProcess` bereits kopiert).
   * NaN/Inf in den Ergebnis-Kanälen 0/1 wird auf 0 geklammert.
   */
  protected runStereoKernel(
    out: Float32Array[],
    len: number,
    kernelCall: (n: number) => void,
  ): void {
    const { inL, inR, outL, outR } = this.ensureScratch(len);

    // Eingänge: Kanal 0 = L, Kanal 1 = R (falls vorhanden, sonst L duplizieren).
    const srcL = out[0];
    const srcR = out[1] ?? out[0];

    // Copy in (kann in-place sein, Kernel liest i bevor es schreibt).
    inL.set(srcL.subarray(0, len));
    inR.set(srcR.subarray(0, len));

    // Kernel-Aufruf.
    kernelCall(len);

    // Copy out.
    out[0].set(outL.subarray(0, len));
    if (out[1]) out[1].set(outR.subarray(0, len));

    // NaN/Inf-Schutz für die verarbeiteten Kanäle.
    for (let i = 0; i < len; i++) {
      if (!Number.isFinite(out[0][i])) out[0][i] = 0;
      if (out[1] && !Number.isFinite(out[1][i])) out[1][i] = 0;
    }
  }

  // Gemeinsamer Bypass: ist die Node aus, gibt `prepareProcess` bereits den
  // Eingang 1:1 in `out` zurück – wir müssen nur den Port-Puffer zuweisen.
  protected bypass(out: Float32Array[]): void {
    this.outputs[0].buffer = out;
  }
}

/** Biquad-Filter-Node (LP/HP/BP via RBJ-Cookbook). */
export class WasmBiquadNode extends WasmDspNode {
  readonly cutoff: AudioParameter;
  readonly q: AudioParameter;
  readonly mode: AudioParameter; // 0=LP, 1=HP, 2=BP

  // Cache für den letzten `setFilter`-Aufruf (vermeidet allokationsfreien Pfad).
  private cached: {
    kind: number;
    cutoff: number;
    q: number;
    sr: number;
  } | null = null;

  constructor(
    id: string,
    kernel: DspKernelLike | null = null,
  ) {
    super(id, 'wasm-biquad', kernel);
    this.cutoff = new AudioParameter('cutoff', 20, 20000, 1000);
    this.q = new AudioParameter('q', 0.1, 20, 0.70710678);
    this.mode = new AudioParameter('mode', 0, 2, 0);
    this.parameters.push(this.cutoff, this.q, this.mode);
  }

  /** Setzt den Modus über einen sprechenden String (Bequemlichkeit). */
  setMode(kind: 'lowpass' | 'highpass' | 'bandpass'): void {
    const v = kind === 'highpass' ? BIQUAD_MODE_HIGHPASS : kind === 'bandpass' ? BIQUAD_MODE_BANDPASS : BIQUAD_MODE_LOWPASS;
    this.mode.setValue(v);
  }

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { out, len } = block;

    if (!this.isActive(ctx)) {
      this.bypass(out);
      return;
    }

    // Filter-Koeffizienten nur bei Parameteränderung neu setzen.
    const kind = this.mode.getValueAtTime(ctx.currentTime) | 0;
    const cutoff = this.cutoff.getValueAtTime(ctx.currentTime);
    const q = this.q.getValueAtTime(ctx.currentTime);
    const sr = Math.max(8000, ctx.sampleRate);

    if (!this.cached || this.cached.kind !== kind || this.cached.cutoff !== cutoff
        || this.cached.q !== q || this.cached.sr !== sr) {
      this.kernel.setFilter({ kind: kind as unknown as FilterParams['kind'], sampleRate: sr, cutoff, q });
      this.cached = { kind, cutoff, q, sr };
    }

    this.runStereoKernel(out, len, (n) => this.kernel.processFilter(this.inL, this.inR, this.outL, this.outR));
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.enabled.reset();
    this.cutoff.reset();
    this.q.reset();
    this.mode.reset();
    this.cached = null;
    this.kernel.resetFilter();
    this.outputs[0].buffer = null;
  }
}

/** tanh-Sättigungs-Node (Drive + Output-Trim). */
export class WasmSaturationNode extends WasmDspNode {
  readonly drive: AudioParameter;
  readonly trim: AudioParameter;

  private cached: { drive: number; trim: number } | null = null;

  constructor(
    id: string,
    kernel: DspKernelLike | null = null,
  ) {
    super(id, 'wasm-saturation', kernel);
    this.drive = new AudioParameter('drive', 1, 50, 1);
    this.trim = new AudioParameter('trim', 0, 1, 1);
    this.parameters.push(this.drive, this.trim);
  }

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { out, len } = block;

    if (!this.isActive(ctx)) {
      this.bypass(out);
      return;
    }

    const drive = this.drive.getValueAtTime(ctx.currentTime);
    const trim = this.trim.getValueAtTime(ctx.currentTime);

    if (!this.cached || this.cached.drive !== drive || this.cached.trim !== trim) {
      this.kernel.setSaturation({ drive, trim });
      this.cached = { drive, trim };
    }

    this.runStereoKernel(out, len, (n) => this.kernel.processSaturation(this.inL, this.inR, this.outL, this.outR));
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.enabled.reset();
    this.drive.reset();
    this.trim.reset();
    this.cached = null;
    // Sättigung ist zustandslos – kein Kernel-Reset nötig.
    this.outputs[0].buffer = null;
  }
}

/** Stereo-verkoppelter Kompressor-Node (Threshold/Ratio/Attack/Release). */
export class WasmCompressorNode extends WasmDspNode {
  readonly threshold: AudioParameter;
  readonly ratio: AudioParameter;
  readonly attack: AudioParameter;
  readonly release: AudioParameter;

  private cached: {
    threshold: number;
    ratio: number;
    attack: number;
    release: number;
    sr: number;
  } | null = null;

  constructor(
    id: string,
    kernel: DspKernelLike | null = null,
  ) {
    super(id, 'wasm-compressor', kernel);
    this.threshold = new AudioParameter('threshold', -60, 0, -18);
    this.ratio = new AudioParameter('ratio', 1, 20, 4);
    this.attack = new AudioParameter('attack', 0.001, 0.5, 0.01);
    this.release = new AudioParameter('release', 0.01, 2, 0.2);
    this.parameters.push(this.threshold, this.ratio, this.attack, this.release);
  }

  /** Aktuelle Gain-Reduktion in dB (≤ 0) – für Metering. */
  get gainReductionDb(): number {
    return this.kernel.compressorGainDb();
  }

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { out, len } = block;

    if (!this.isActive(ctx)) {
      this.bypass(out);
      return;
    }

    const threshold = this.threshold.getValueAtTime(ctx.currentTime);
    const ratio = this.ratio.getValueAtTime(ctx.currentTime);
    const attack = this.attack.getValueAtTime(ctx.currentTime);
    const release = this.release.getValueAtTime(ctx.currentTime);
    const sr = Math.max(8000, ctx.sampleRate);

    if (!this.cached || this.cached.threshold !== threshold || this.cached.ratio !== ratio
        || this.cached.attack !== attack || this.cached.release !== release
        || this.cached.sr !== sr) {
      this.kernel.setCompressor({ sampleRate: sr, threshold, ratio, attack, release });
      this.cached = { threshold, ratio, attack, release, sr };
    }

    this.runStereoKernel(out, len, (n) => this.kernel.processCompressor(this.inL, this.inR, this.outL, this.outR));
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.enabled.reset();
    this.threshold.reset();
    this.ratio.reset();
    this.attack.reset();
    this.release.reset();
    this.cached = null;
    this.kernel.resetCompressor();
    this.outputs[0].buffer = null;
  }
}