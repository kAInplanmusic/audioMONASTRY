import { AudioBuffer, AudioGraph } from '../AudioGraph';
import type { IAudioBuffer, IAudioGraph, IProcessingContext } from '../types';
import type { IAudioGraphBackend } from './types';

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

  get available(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    if (typeof WebAssembly === 'undefined' || this.ready) return;
    try {
      const resp = await fetch('/wasm/dspKernel.wasm');
      if (!resp.ok) return;
      const mod = await WebAssembly.compile(await resp.arrayBuffer());
      const { exports } = await WebAssembly.instantiate(mod, {});
      this.ready = typeof (exports as Record<string, unknown>).dsp_process === 'function';
    } catch {
      // Kernel optional – bewusst degressiv, kein Fehler.
      this.ready = false;
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
    this.ready = false;
  }
}
