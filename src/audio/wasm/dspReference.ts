/**
 * src/audio/wasm/dspReference.ts
 * ==============================
 * Reine TypeScript-Referenz des Rust/WASM-DSP-Kerns (`dspKernel_rs/src/lib.rs`).
 *
 * Wozu: solange in dieser Umgebung kein `wasm32-unknown-unknown`-Target liegt
 * (`rustup target add …`), gibt es kein frisch gebautes `.wasm` mit den neuen
 * Exporten. Die Referenz bildet die Rust-Algorithmen 1:1 nach, damit
 *
 *   1. die Konformitätstests (`tests/dspKernelWasm.test.ts`) gegen eine
 *      unabhängige Orakel-Formel laufen können, und
 *   2. bei vorhandenem Build ein Sample-für-Sample-Paritätstest gegen das
 *      echte Modul möglich ist.
 *
 * Rundung: jede Arithmetik-Operation wird wie im Rust-Kern auf `f32`
 * zurückgerundet (`Math.fround`), damit die Parität zum WASM-Modul nicht an
 * f64-Zwischenschritten scheitert. `tanh`/`log10`/`powf` stammen aus der
 * jeweiligen libm – dort bleiben Abweichungen in der Größenordnung weniger
 * ULP, weshalb der Paritätstest mit 1e-4 absolut prüft statt bitgenau.
 *
 * Diese Datei ist KEIN Produktionspfad: sie ist der Prüfstein, nicht der
 * Klang. Die Laufzeit nimmt `DspKernelWasm` (`dspKernelWasm.ts`).
 */

const f = Math.fround;

// --- Filtertypen (identisch zu den i32-Werten der C-ABI) ---------------------
const FILTER_LOWPASS = 0;
const FILTER_HIGHPASS = 1;
const FILTER_BANDPASS = 2;

const MIN_CUTOFF_HZ = 10;
const MIN_Q = 0.1;
const MAX_Q = 40;
const MIN_DRIVE = 1e-3;
const MAX_DRIVE = 100;
const MAX_TRIM = 4;
const MIN_TIME_S = 1e-4;
const MAX_TIME_S = 2;
const MIN_RATIO = 1;
const MAX_RATIO = 20;
const MIN_THRESHOLD_DB = -96;
const SILENCE_LIN = 1e-9;

// ---------------------------------------------------------------------------
// Typen / Vertrag
// ---------------------------------------------------------------------------

export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass';

export interface FilterParams {
  kind: BiquadKind;
  /** Abtastrate in Hz – die Koeffizienten hängen davon ab. */
  sampleRate: number;
  /** Grenz-/Mittenfrequenz in Hz. */
  cutoff: number;
  /** Güte. 0.7071 = Butterworth, höher = resonant. */
  q: number;
}

export interface SaturationParams {
  /** Eingangsverstärkung vor tanh (>0). Höher = stärker gesättigt. */
  drive: number;
  /** Ausgangstrim (linear). Begrenzt den Ausgang auf |trim|. */
  trim: number;
}

export interface CompressorParams {
  sampleRate: number;
  /** Threshold in dBFS (<= 0). */
  threshold: number;
  /** Verhältnis >= 1 (4 = 4:1). */
  ratio: number;
  /** Attack in Sekunden (63,2-%-Zeitkonstante). */
  attack: number;
  /** Release in Sekunden (63,2-%-Zeitkonstante). */
  release: number;
}

/** Gemeinsamer Vertrag von WASM-Kern und TS-Referenz. */
export interface DspKernelLike {
  setFilter(params: FilterParams): void;
  resetFilter(): void;
  processFilter(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void;

  setSaturation(params: SaturationParams): void;
  processSaturation(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void;

  setCompressor(params: CompressorParams): void;
  resetCompressor(): void;
  processCompressor(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void;
  /** Aktuelle Gain-Reduktion in dB (<= 0). */
  compressorGainDb(): number;
}

// ---------------------------------------------------------------------------
// Helfer (1:1 zu lib.rs)
// ---------------------------------------------------------------------------

function clampOr(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback;
}

function sanitize(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

function linToDb(lin: number): number {
  return lin <= SILENCE_LIN ? -200 : f(20 * f(Math.log10(lin)));
}

function dbToLin(db: number): number {
  return db <= -200 ? 0 : f(Math.pow(10, f(db * 0.05)));
}

/** Ein-Pol-Koeffizient; nach `timeS` Sekunden sind 63,2 % des Ziels erreicht. */
function onePoleCoeff(timeS: number, sampleRate: number): number {
  const t = clampOr(timeS, MIN_TIME_S, MAX_TIME_S, MIN_TIME_S);
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  return f(Math.exp(-1 / (t * sr)));
}

function filterKindToInt(kind: BiquadKind): number {
  if (kind === 'highpass') return FILTER_HIGHPASS;
  if (kind === 'bandpass') return FILTER_BANDPASS;
  return FILTER_LOWPASS;
}

// ---------------------------------------------------------------------------
// Biquad
// ---------------------------------------------------------------------------

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const BYPASS_COEFFS: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

/**
 * RBJ-Audio-EQ-Cookbook. `kind` als i32 wie in der C-ABI (0/1/2).
 * Grenzen werden geklemmt; ungültige Abtastrate ergibt Bypass.
 */
function designBiquad(kind: number, sampleRate: number, cutoff: number, q: number): BiquadCoeffs {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return { ...BYPASS_COEFFS };
  const sr = sampleRate;
  const nyquist = f(0.5 * sr);
  const maxF = Math.max(f(nyquist * 0.99), 1);
  const minF = Math.min(MIN_CUTOFF_HZ, f(maxF * 0.5));
  const f0 = clampOr(cutoff, minF, maxF, minF);
  const qq = clampOr(q, MIN_Q, MAX_Q, Math.SQRT1_2);

  const w0 = f(f(f(2 * Math.PI) * f0) / sr);
  const cosW0 = f(Math.cos(w0));
  const sinW0 = f(Math.sin(w0));
  const alpha = f(sinW0 / f(2 * qq));

  let b0: number;
  let b1: number;
  let b2: number;
  if (kind === FILTER_HIGHPASS) {
    const g = f((1 + cosW0) * 0.5);
    b0 = g;
    b1 = f(-(1 + cosW0));
    b2 = g;
  } else if (kind === FILTER_BANDPASS) {
    // 0-dB-Peak-Gain-Form: |H(f0)| = 1.
    b0 = alpha;
    b1 = 0;
    b2 = f(-alpha);
  } else {
    const g = f((1 - cosW0) * 0.5);
    b0 = g;
    b1 = f(1 - cosW0);
    b2 = g;
  }

  const a0 = f(1 + alpha);
  const invA0 = f(1 / a0);
  return {
    b0: f(b0 * invA0),
    b1: f(b1 * invA0),
    b2: f(b2 * invA0),
    a1: f(f(-2 * cosW0) * invA0),
    a2: f(f(1 - alpha) * invA0),
  };
}

function isBypass(c: BiquadCoeffs): boolean {
  return c.a1 === 0 && c.a2 === 0 && c.b1 === 0 && c.b2 === 0;
}

/** Filterzustand eines Kanals (Transposed Direct Form II). */
class BiquadState {
  private z1 = 0;
  private z2 = 0;

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  process(c: BiquadCoeffs, x: number): number {
    const xi = sanitize(x);
    if (isBypass(c)) return xi;
    const y = f(f(c.b0 * xi) + this.z1);
    const z1 = f(f(f(c.b1 * xi) - f(c.a1 * y)) + this.z2);
    const z2 = f(f(c.b2 * xi) - f(c.a2 * y));
    if (!Number.isFinite(y) || !Number.isFinite(z1) || !Number.isFinite(z2)) {
      this.reset();
      return 0;
    }
    this.z1 = z1;
    this.z2 = z2;
    return y;
  }
}

// ---------------------------------------------------------------------------
// Sättigung
// ---------------------------------------------------------------------------

function saturateSample(x: number, drive: number, trim: number): number {
  const d = clampOr(drive, MIN_DRIVE, MAX_DRIVE, 1);
  const t = clampOr(trim, -MAX_TRIM, MAX_TRIM, 1);
  const y = f(f(Math.tanh(f(sanitize(x) * d))) * t);
  return Number.isFinite(y) ? y : 0;
}

// ---------------------------------------------------------------------------
// Kompressor
// ---------------------------------------------------------------------------

class CompressorCore {
  private thresholdDb = 0;
  private ratio = 1;
  private slope = 0;
  private attackCoeff = 1;
  private releaseCoeff = 1;
  private gainDb = 0;

  /** Wie `Compressor::new`/`set` im Rust-Kern. */
  set(sampleRate: number, thresholdDb: number, ratio: number, attackS: number, releaseS: number): void {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      this.disable();
      return;
    }
    this.thresholdDb = clampOr(thresholdDb, MIN_THRESHOLD_DB, 0, -20);
    this.ratio = clampOr(ratio, MIN_RATIO, MAX_RATIO, 1);
    this.slope = f(1 - 1 / this.ratio);
    this.attackCoeff = onePoleCoeff(attackS, sampleRate);
    this.releaseCoeff = onePoleCoeff(releaseS, sampleRate);
  }

  disable(): void {
    this.thresholdDb = 0;
    this.ratio = 1;
    this.slope = 0;
    this.attackCoeff = 1;
    this.releaseCoeff = 1;
    this.gainDb = 0;
  }

  reset(): void {
    this.gainDb = 0;
  }

  get currentGainDb(): number {
    return this.gainDb;
  }

  get threshold(): number {
    return this.thresholdDb;
  }

  get ratioValue(): number {
    return this.ratio;
  }

  /** Ein Sample-Stereopaar; stereo-verkoppelt über `max(|l|,|r|)`. */
  processSample(l: number, r: number): [number, number] {
    const li = sanitize(l);
    const ri = sanitize(r);
    const level = Math.max(Math.abs(li), Math.abs(ri));
    const over = f(linToDb(level) - this.thresholdDb);
    const targetDb = over > 0 ? f(-over * this.slope) : 0;

    const coeff = targetDb < this.gainDb ? this.attackCoeff : this.releaseCoeff;
    const next = f(targetDb + f(f(this.gainDb - targetDb) * coeff));
    this.gainDb = Number.isFinite(next) ? Math.min(Math.max(next, -96), 0) : 0;

    const g = dbToLin(this.gainDb);
    return [f(li * g), f(ri * g)];
  }
}

// ---------------------------------------------------------------------------
// Referenz-Kernel (gleiche Methodenfläche wie DspKernelWasm)
// ---------------------------------------------------------------------------

/**
 * Vollständige TS-Referenz. Reihenfolge der Stufen wie im WASM-Kernel:
 * Filter → Sättigung → Kompressor, jeweils pro Block.
 */
export class ReferenceDspKernel implements DspKernelLike {
  private coeffs: BiquadCoeffs = { ...BYPASS_COEFFS };
  private left = new BiquadState();
  private right = new BiquadState();
  private drive = 1;
  private trim = 1;
  private readonly comp = new CompressorCore();

  setFilter(params: FilterParams): void {
    this.coeffs = designBiquad(filterKindToInt(params.kind), params.sampleRate, params.cutoff, params.q);
  }

  resetFilter(): void {
    this.left.reset();
    this.right.reset();
  }

  processFilter(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const n = Math.min(inL.length, inR.length, outL.length, outR.length);
    for (let i = 0; i < n; i++) {
      outL[i] = this.left.process(this.coeffs, inL[i]);
      outR[i] = this.right.process(this.coeffs, inR[i]);
    }
  }

  setSaturation(params: SaturationParams): void {
    this.drive = params.drive;
    this.trim = params.trim;
  }

  processSaturation(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const n = Math.min(inL.length, inR.length, outL.length, outR.length);
    for (let i = 0; i < n; i++) {
      outL[i] = saturateSample(inL[i], this.drive, this.trim);
      outR[i] = saturateSample(inR[i], this.drive, this.trim);
    }
  }

  setCompressor(params: CompressorParams): void {
    this.comp.set(params.sampleRate, params.threshold, params.ratio, params.attack, params.release);
  }

  resetCompressor(): void {
    this.comp.reset();
  }

  compressorGainDb(): number {
    return this.comp.currentGainDb;
  }

  processCompressor(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const n = Math.min(inL.length, inR.length, outL.length, outR.length);
    for (let i = 0; i < n; i++) {
      const [l, r] = this.comp.processSample(inL[i], inR[i]);
      outL[i] = l;
      outR[i] = r;
    }
  }
}
