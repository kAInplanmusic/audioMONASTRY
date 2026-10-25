import { AudioBuffer, AudioGraph } from '../AudioGraph';
import type { IAudioBuffer, IAudioGraph, IProcessingContext } from '../types';
import type { IAudioGraphBackend } from './types';
import { DspKernelWasm } from '../../../audio/wasm/dspKernelWasm';
import type { DspKernelLike } from '../../../audio/wasm/dspKernelWasm';

/**
 * WASM-Backend (8.1.2-Referenzpfad).
 * Lädt den optionalen WASM-DSP-Kernel (`src/audio/wasm/dspKernel.c`, gebaut via
 * `scripts/build-wasm-audio.sh` → `/wasm/dspKernel.wasm`). Ohne Kernel bleibt
 * der Adapter inaktiv (`available=false`); die JS-Graph-Verarbeitung übernimmt
 * dann das WebAudioBackend. Der Render-Pfad ist identisch (Graph → Output),
 * damit ein Backend-Wechsel ohne Audio-Veränderung möglich ist.
 */
export class WasmBackend implements IAudioGraphBackend {
  readonly id = 'wasm';
  readonly kind = 'wasm' as const;

  private ready = false;
  private kernel: DspKernelWasm | null = null;
  private module: WebAssembly.Module | null = null;

  get available(): boolean {
    return this.ready;
  }

  /** Instanzierter DSP-Kern (null, solange nicht geladen). Exponiert für Graph-Builder,
   *  damit DSP-Nodes den Kern injizieren können. */
  get dspKernel(): DspKernelLike | null {
    return this.kernel;
  }

  /** true, wenn das geladene Modul die drei WASM-Prozessoren enthält (ABI v2). */
  get hasProcessors(): boolean {
    return this.kernel?.hasProcessors ?? false;
  }

  async initialize(): Promise<void> {
    if (typeof WebAssembly === 'undefined' || this.ready) return;
    try {
      const resp = await fetch('/wasm/dspKernel.wasm');
      if (!resp.ok) return;
      const mod = await WebAssembly.compile(await resp.arrayBuffer());
      const kernel = await DspKernelWasm.fromModule(mod);
      this.module = mod;
      this.kernel = kernel;
      this.ready = true;
    } catch {
      // Kernel optional – bewusst degressiv, kein Fehler.
      this.ready = false;
      this.kernel = null;
      this.module = null;
    }
  }

  /** Erzeugt eine zusätzliche, unabhängige Kernel-Instanz (eigener Filter-/Kompressor-Zustand).
   *  Nützlich, wenn mehrere Nodes denselben WASM-Modul-Kern nutzen sollen ohne Zustands-Konflikte. */
  async createKernel(): Promise<DspKernelLike | null> {
    if (!this.module) return null;
    try {
      return await DspKernelWasm.fromModule(this.module);
    } catch {
      return null;
    }
  }

  createGraph(): IAudioGraph {
    return new AudioGraph();
  }

  createBuffer(sampleRate: number, length: number, channels: number): IAudioBuffer {
    return new AudioBuffer(sampleRate, length, channels);
  }

  /** Verarbeitet den Graph und schreibt den letzten Output-Buffer in den Ausgang. */
  async render(graph: IAudioGraph, ctx: IProcessingContext, output: IAudioBuffer): Promise<void> {
    graph.process(ctx);
    const last = graph.getLastOutput();
    for (let ch = 0; ch < output.numberOfChannels; ch++) {
      const src = last?.[ch] ?? last?.[0];
      const dst = output.channelData[ch];
      if (!src) {
        dst.fill(0);
        continue;
      }
      const n = Math.min(dst.length, src.length);
      for (let i = 0; i < n; i++) dst[i] = src[i];
      if (n < dst.length) dst.fill(0, n);
    }
  }

  async dispose(): Promise<void> {
    this.kernel?.dispose();
    this.kernel = null;
    this.module = null;
    this.ready = false;
  }
}
