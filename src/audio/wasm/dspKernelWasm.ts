/**
 * src/audio/wasm/dspKernelWasm.ts
 * ===============================
 * Typisierter TS-Wrapper um den Rust/WASM-DSP-Kern
 * (`src/audio/wasm/dspKernel_rs/src/lib.rs`).
 *
 * Ladepfad wie `WasmBackend.ts` / `WasmPluginHost.ts`: das Modul hat KEINE
 * Imports, wird also mit einem leeren Import-Objekt instanziiert
 * (`WebAssembly.instantiate(mod, {})`) und über C-ABI-Namen angesprochen.
 *
 *   const kernel = await DspKernelWasm.load('/wasm/dspKernel.wasm');
 *   kernel.setFilter({ kind: 'lowpass', sampleRate: 48000, cutoff: 1200, q: 0.707 });
 *   kernel.processFilter(inL, inR, outL, outR);   // pro Audio-Block
 *
 * Koeffizienten hängen von der Abtastrate ab; sie werden deshalb bei jedem
 * `setFilter`/`setCompressor` mitgegeben und im Rust-Kern EINMAL gerechnet
 * (kein `sin`/`cos` im Sample-Loop).
 *
 * Ohne neu gebautes `.wasm` (fehlendes `wasm32-unknown-unknown`-Target) fehlen
 * die Prozessor-Exporte. `hasProcessors` sagt das vorab; die Prozess-Methoden
 * werfen dann mit dem exakten Build-Kommando statt still Stille zu liefern.
 */

import type {
  CompressorParams,
  DspKernelLike,
  FilterParams,
  SaturationParams,
} from './dspReference';

/** Standard-Ablage, wie sie `WasmBackend` erwartet. */
const DSP_KERNEL_WASM_URL = '/wasm/dspKernel.wasm';

/** Fehlendes Build-Artefakt – im Fehlertext, damit niemand raten muss. */
const BUILD_HINT =
  'rustup target add wasm32-unknown-unknown && cd src/audio/wasm/dspKernel_rs && '
  + 'cargo build --release --target wasm32-unknown-unknown';

/** Export-Fläche des Moduls. Optionale Einträge = ABI v2 (Prozessoren). */
interface DspKernelExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  free_ptr(ptr: number, len: number): void;
  dsp_process(
    inL: number, inR: number, outL: number, outR: number, n: number, gain: number,
  ): void;
  dsp_abi_version?: () => number;
  dsp_filter_set?: (kind: number, sampleRate: number, cutoff: number, q: number) => void;
  dsp_filter_reset?: () => void;
  dsp_filter_process?: (
    inL: number, inR: number, outL: number, outR: number, n: number,
  ) => void;
  dsp_saturate_set?: (drive: number, trim: number) => void;
  dsp_saturate_process?: (
    inL: number, inR: number, outL: number, outR: number, n: number,
  ) => void;
  dsp_comp_set?: (
    sampleRate: number, thresholdDb: number, ratio: number, attackS: number, releaseS: number,
  ) => void;
  dsp_comp_reset?: () => void;
  dsp_comp_gain_db?: () => number;
  dsp_comp_process?: (
    inL: number, inR: number, outL: number, outR: number, n: number,
  ) => void;
}

interface BufferPtrs {
  inL: number;
  inR: number;
  outL: number;
  outR: number;
}

interface BufferViews {
  inL: Float32Array;
  inR: Float32Array;
  outL: Float32Array;
  outR: Float32Array;
}

/** Filtertyp → i32 der C-ABI (bewusst lokal, damit der Wrapper nicht den
 *  kompletten Referenz-Implementierungscode mitzieht). */
function filterKindToInt(kind: FilterParams['kind']): number {
  if (kind === 'highpass') return 1;
  if (kind === 'bandpass') return 2;
  return 0;
}

export class DspKernelWasm implements DspKernelLike {
  private readonly ex: DspKernelExports;
  private capacity = 0;
  private ptr: BufferPtrs = { inL: 0, inR: 0, outL: 0, outR: 0 };
  private viewCache: { buffer: ArrayBuffer; views: BufferViews } | null = null;
  private disposed = false;

  private constructor(exports: DspKernelExports) {
    for (const name of ['memory', 'alloc', 'free_ptr', 'dsp_process'] as const) {
      if (exports[name] === undefined) {
        throw new Error(`[DspKernelWasm] Export "${name}" fehlt – das ist kein dspKernel.wasm.`);
      }
    }
    this.ex = exports;
  }

  // --- Laden ---------------------------------------------------------------

  /** Baut ein Modul aus einem bereits kompilierten `WebAssembly.Module`
   *  (Worker-Pfad: Module lassen sich zwischen Threads übertragen). */
  static async fromModule(module: WebAssembly.Module): Promise<DspKernelWasm> {
    const instance = await WebAssembly.instantiate(module, {});
    return new DspKernelWasm(instance.exports as unknown as DspKernelExports);
  }

  /** Baut ein Modul aus Bytes – der Pfad, den die Tests nehmen. */
  static async fromBytes(bytes: BufferSource): Promise<DspKernelWasm> {
    const module = await WebAssembly.compile(bytes);
    return DspKernelWasm.fromModule(module);
  }

  /** Lädt und instanziiert `/wasm/dspKernel.wasm` (oder eine andere URL). */
  static async load(url: string = DSP_KERNEL_WASM_URL): Promise<DspKernelWasm> {
    if (typeof fetch !== 'function') {
      throw new Error('[DspKernelWasm] fetch nicht verfügbar – Bytes selbst laden und fromBytes() nutzen.');
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`[DspKernelWasm] ${url}: HTTP ${response.status}`);
    }
    return DspKernelWasm.fromBytes(await response.arrayBuffer());
  }

  // --- Zustand der ABI -----------------------------------------------------

  /** 1 = nur Gain/Mix (Altstand), 2 = Filter/Sättigung/Kompressor. */
  get abiVersion(): number {
    return this.ex.dsp_abi_version ? this.ex.dsp_abi_version() : 1;
  }

  /** true, wenn das geladene `.wasm` die drei Prozessoren wirklich enthält. */
  get hasProcessors(): boolean {
    return (
      typeof this.ex.dsp_filter_process === 'function'
      && typeof this.ex.dsp_saturate_process === 'function'
      && typeof this.ex.dsp_comp_process === 'function'
    );
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // --- Gain/Mix (Bestand) --------------------------------------------------

  /** Gain auf L/R, identisch zum C-Kern (`dsp_process`). In-place erlaubt. */
  processGain(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    gain: number,
  ): void {
    const fn = this.ex.dsp_process;
    this.runBlock(inL, inR, outL, outR, (n) =>
      fn(this.ptr.inL, this.ptr.inR, this.ptr.outL, this.ptr.outR, n, gain));
  }

  // --- Biquad --------------------------------------------------------------

  setFilter(params: FilterParams): void {
    const fn = this.ex.dsp_filter_set;
    if (!fn) throw this.missing('dsp_filter_set');
    fn(filterKindToInt(params.kind), params.sampleRate, params.cutoff, params.q);
  }

  resetFilter(): void {
    const fn = this.ex.dsp_filter_reset;
    if (!fn) throw this.missing('dsp_filter_reset');
    fn();
  }

  processFilter(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
  ): void {
    const fn = this.ex.dsp_filter_process;
    if (!fn) throw this.missing('dsp_filter_process');
    this.runBlock(inL, inR, outL, outR, (n) =>
      fn(this.ptr.inL, this.ptr.inR, this.ptr.outL, this.ptr.outR, n));
  }

  // --- Sättigung -----------------------------------------------------------

  setSaturation(params: SaturationParams): void {
    const fn = this.ex.dsp_saturate_set;
    if (!fn) throw this.missing('dsp_saturate_set');
    fn(params.drive, params.trim);
  }

  processSaturation(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
  ): void {
    const fn = this.ex.dsp_saturate_process;
    if (!fn) throw this.missing('dsp_saturate_process');
    this.runBlock(inL, inR, outL, outR, (n) =>
      fn(this.ptr.inL, this.ptr.inR, this.ptr.outL, this.ptr.outR, n));
  }

  // --- Kompressor ----------------------------------------------------------

  setCompressor(params: CompressorParams): void {
    const fn = this.ex.dsp_comp_set;
    if (!fn) throw this.missing('dsp_comp_set');
    fn(params.sampleRate, params.threshold, params.ratio, params.attack, params.release);
  }

  resetCompressor(): void {
    const fn = this.ex.dsp_comp_reset;
    if (!fn) throw this.missing('dsp_comp_reset');
    fn();
  }

  /** Aktuelle Gain-Reduktion in dB (<= 0) – Metering/Diagnose. */
  compressorGainDb(): number {
    const fn = this.ex.dsp_comp_gain_db;
    if (!fn) throw this.missing('dsp_comp_gain_db');
    return fn();
  }

  processCompressor(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
  ): void {
    const fn = this.ex.dsp_comp_process;
    if (!fn) throw this.missing('dsp_comp_process');
    this.runBlock(inL, inR, outL, outR, (n) =>
      fn(this.ptr.inL, this.ptr.inR, this.ptr.outL, this.ptr.outR, n));
  }

  /** Gibt die Scratch-Buffer im WASM-Heap frei. Weitere Aufrufe werfen. */
  dispose(): void {
    if (this.disposed) return;
    this.freeBuffers();
    this.disposed = true;
  }

  // --- Interna -------------------------------------------------------------

  private missing(name: string): Error {
    return new Error(
      `[DspKernelWasm] Export "${name}" fehlt im geladenen .wasm – das Modul ist ABI v1 `
      + `(nur Gain/Mix). Neu bauen: ${BUILD_HINT}`,
    );
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new Error('[DspKernelWasm] nach dispose() nicht mehr nutzbar.');
    }
  }

  /**
   * Kopiert die Eingänge in den WASM-Heap, ruft `call(n)` und schreibt zurück.
   * Der Rust-Kern liest Index i, bevor er ihn schreibt – in-place (out === in)
   * ist damit auf beiden Seiten sicher.
   */
  private runBlock(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    call: (n: number) => void,
  ): void {
    this.assertLive();
    const n = Math.min(inL.length, inR.length, outL.length, outR.length);
    if (n <= 0) return;
    this.ensureCapacity(n);
    const views = this.views();
    views.inL.set(inL.subarray(0, n));
    views.inR.set(inR.subarray(0, n));
    call(n);
    outL.set(views.outL.subarray(0, n));
    outR.set(views.outR.subarray(0, n));
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    const { alloc, free_ptr } = this.ex;
    const next: BufferPtrs = {
      inL: alloc(n),
      inR: alloc(n),
      outL: alloc(n),
      outR: alloc(n),
    };
    if (!next.inL || !next.inR || !next.outL || !next.outR) {
      for (const p of [next.inL, next.inR, next.outL, next.outR]) {
        if (p) free_ptr(p, n);
      }
      throw new Error(`[DspKernelWasm] alloc(${n}) fehlgeschlagen – WASM-Heap erschöpft.`);
    }
    this.freeBuffers();
    this.ptr = next;
    this.capacity = n;
    this.viewCache = null;
  }

  private freeBuffers(): void {
    if (this.capacity === 0) return;
    const { free_ptr } = this.ex;
    for (const p of [this.ptr.inL, this.ptr.inR, this.ptr.outL, this.ptr.outR]) {
      if (p) free_ptr(p, this.capacity);
    }
    this.ptr = { inL: 0, inR: 0, outL: 0, outR: 0 };
    this.capacity = 0;
    this.viewCache = null;
  }

  /** Views werden neu gebaut, sobald `memory.grow` den ArrayBuffer ersetzt. */
  private views(): BufferViews {
    const buffer = this.ex.memory.buffer;
    if (!this.viewCache || this.viewCache.buffer !== buffer) {
      this.viewCache = {
        buffer,
        views: {
          inL: new Float32Array(buffer, this.ptr.inL, this.capacity),
          inR: new Float32Array(buffer, this.ptr.inR, this.capacity),
          outL: new Float32Array(buffer, this.ptr.outL, this.capacity),
          outR: new Float32Array(buffer, this.ptr.outR, this.capacity),
        },
      };
    }
    return this.viewCache.views;
  }
}
