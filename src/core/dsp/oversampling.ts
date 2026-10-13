/**
 * audioMONASTRY · Oversampling fuer nichtlineare Saettiger (DSP-P1-OVS-001)
 * ========================================================================
 * Eigene Halbband-FIR-Implementierung (kein fremder Code). Ein Saettiger
 * (tanh/Waveshaper) erzeugt Oberwellen ueber Nyquist; bei 1x Abtastung falten
 * sie hoerbar zurueck (Aliasing). Hier laeuft die Kennlinie auf 2x bzw. 4x
 * Abtastrate: Hochtasten (Nullen einfuegen + Halbband-Tiefpass), Kennlinie,
 * Tiefpass + Heruntertasten.
 *
 * Aufbau:
 *  - Stufe 1 (Fs → 2Fs): Kaiser-gefensterter Halbband-Tiefpass, 47 Taps,
 *    Durchlass bis 0,4·Fs (Welligkeit < 0,01 dB), Sperrbereich ab 0,6·Fs
 *    mit ≥ 70 dB.
 *  - Stufe 2 (2Fs → 4Fs, nur 4x): 19 Taps, breiter Uebergang (Durchlass bis
 *    0,4·Fs, Sperrbereich ab 1,4·Fs relativ zur Basisrate) – was zwischen
 *    0,6·Fs und Fs zurueckfaltet, entfernt Stufe 1.
 *
 * Phase / Latenz (Live-Mandat, AGENTS.md §1.3):
 *  - `minimum` (Default): die Halbband-Koeffizienten werden beim Laden des
 *    Moduls per Cepstrum in ihre MINIMALPHASIGE Form gebracht (gleicher
 *    Betragsgang). Zusatzlatenz ≈ 3 Samples bei 2x statt 23 linearphasig.
 *    Die Gruppenlaufzeit ist frequenzabhaengig; gemeldet (und per PDC
 *    ausgeglichen) wird der gerundete Wert im Bassbereich (f → 0).
 *  - `linear`: symmetrisches Halbband, exakt ganzzahlige Latenz
 *    ((N−1)/2 je Stufe), fuer Stellen, an denen Phasentreue zaehlt.
 *
 * Echtzeit-Regeln (AGENTS.md §5): Koeffizienten sind vorab berechnet (Modul-
 * Load), der Zustand liegt je Kanal in festen Float64-Ringpuffern, `process()`
 * legt nichts an und ruft nur Zahlen-Arithmetik und `shaper.shape()`.
 * Faktor 1 = OFF: der Aufrufer nutzt seinen bisherigen 1x-Pfad unveraendert
 * (bit-identisch); `Oversampler.process` reicht dann direkt an `shape()` durch.
 */

/** Oversampling-Faktor. 1 = aus (bit-identisch zum bisherigen 1x-Pfad). */
export type OversamplingFactor = 1 | 2 | 4;
/** Filterphase der Halbband-Stufen. */
export type OversamplingPhase = 'minimum' | 'linear';

/** Kennlinie, die auf der hohen Rate laeuft (ein Objekt, keine Closure je Block). */
export interface SampleShaper {
  shape(x: number): number;
}

/** Default fuer alle Echtzeit-Saettiger: 2x, minimalphasig. */
export const DEFAULT_SATURATOR_OVERSAMPLING: OversamplingFactor = 2;
export const DEFAULT_SATURATOR_PHASE: OversamplingPhase = 'minimum';

/** Normalisiert beliebige Eingaben (Port-Nachricht, Parameter) auf 1 | 2 | 4. */
export function normalizeOversamplingFactor(value: unknown, fallback: OversamplingFactor = DEFAULT_SATURATOR_OVERSAMPLING): OversamplingFactor {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 1.5) return 1;
  if (n < 3) return 2;
  return 4;
}

// ---------------------------------------------------------------------------
// Filterentwurf (nur beim Modul-Load / in Tests, nie im Render-Pfad)
// ---------------------------------------------------------------------------

/** Modifizierte Besselfunktion 0. Ordnung (Reihe) fuer das Kaiser-Fenster. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 64; k++) {
    const r = x / (2 * k);
    term *= r * r;
    sum += term;
    if (term < 1e-21 * sum) break;
  }
  return sum;
}

/**
 * Kaiser-gefensterter Halbband-Tiefpass (Grenze Fs/4 der hohen Rate).
 * `numTaps` muss 4k−1 sein (Randkoeffizienten ≠ 0); jeder zweite Koeffizient
 * ausser der Mitte ist exakt 0, die Mitte ist 0,5, die Summe ist 1 (DC-Gain 1).
 */
export function designHalfbandFir(numTaps: number, beta: number): Float64Array {
  if (!Number.isInteger(numTaps) || numTaps < 3 || (numTaps + 1) % 4 !== 0) {
    throw new Error(`designHalfbandFir: numTaps muss 4k-1 sein (war ${numTaps})`);
  }
  const center = (numTaps - 1) / 2;
  const h = new Float64Array(numTaps);
  const i0Beta = besselI0(beta);
  for (let i = 0; i < numTaps; i++) {
    const n = i - center;
    let ideal: number;
    if (n === 0) ideal = 0.5;
    else if (n % 2 === 0) ideal = 0; // Halbband: gerade Abstaende zur Mitte sind exakt 0
    else ideal = Math.sin((Math.PI * n) / 2) / (Math.PI * n);
    const r = (2 * i) / (numTaps - 1) - 1;
    h[i] = ideal * (besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0Beta);
  }
  // DC-Gain exakt 1, Mitte exakt 0,5: nur die Nicht-Mitte-Taps skalieren,
  // damit die Halbband-Eigenschaft (Mitte 0,5, Polyphasen-Zweige je 0,5) bleibt.
  let side = 0;
  for (let i = 0; i < numTaps; i++) if (i !== center) side += h[i];
  const scale = side !== 0 ? 0.5 / side : 1;
  for (let i = 0; i < numTaps; i++) if (i !== center) h[i] *= scale;
  h[center] = 0.5;
  return h;
}

/** Radix-2-FFT in place (nur Entwurf). `inverse` skaliert mit 1/n. */
function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/**
 * Minimalphasige Variante eines FIR mit gleichem Betragsgang (reelles
 * Cepstrum, gefaltet auf kausal). Laenge bleibt; DC-Gain wird auf 1 normiert.
 */
export function toMinimumPhase(h: Float64Array, fftSize = 4096): Float64Array {
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  re.set(h);
  fftInPlace(re, im, false);
  for (let i = 0; i < fftSize; i++) {
    re[i] = Math.log(Math.max(Math.hypot(re[i], im[i]), 1e-10));
    im[i] = 0;
  }
  fftInPlace(re, im, true); // reelles Cepstrum
  for (let i = 1; i < fftSize / 2; i++) { re[i] *= 2; im[i] *= 2; }
  for (let i = fftSize / 2 + 1; i < fftSize; i++) { re[i] = 0; im[i] = 0; }
  fftInPlace(re, im, false);
  for (let i = 0; i < fftSize; i++) {
    const mag = Math.exp(re[i]);
    const ph = im[i];
    re[i] = mag * Math.cos(ph);
    im[i] = mag * Math.sin(ph);
  }
  fftInPlace(re, im, true);
  const out = new Float64Array(h.length);
  let sum = 0;
  for (let i = 0; i < h.length; i++) { out[i] = re[i]; sum += re[i]; }
  if (sum !== 0) for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/** Komplexer Frequenzgang bei normierter Frequenz f (Zyklen/Sample). */
function response(h: Float64Array, f: number): [number, number] {
  let re = 0;
  let im = 0;
  for (let n = 0; n < h.length; n++) {
    re += h[n] * Math.cos(2 * Math.PI * f * n);
    im -= h[n] * Math.sin(2 * Math.PI * f * n);
  }
  return [re, im];
}

/** Betrag in dB bei normierter Frequenz f (Zyklen/Sample). */
export function magnitudeDb(h: Float64Array, f: number): number {
  const [re, im] = response(h, f);
  return 20 * Math.log10(Math.max(1e-20, Math.hypot(re, im)));
}

/** Gruppenlaufzeit in Samples bei normierter Frequenz f (Re{Σ n·h·e / Σ h·e}). */
export function groupDelaySamples(h: Float64Array, f: number): number {
  let ar = 0; let ai = 0; let br = 0; let bi = 0;
  for (let n = 0; n < h.length; n++) {
    const c = Math.cos(2 * Math.PI * f * n);
    const s = -Math.sin(2 * Math.PI * f * n);
    ar += n * h[n] * c; ai += n * h[n] * s;
    br += h[n] * c; bi += h[n] * s;
  }
  return (ar * br + ai * bi) / (br * br + bi * bi);
}

// ---------------------------------------------------------------------------
// Vorab berechnete Koeffizienten (Modul-Load)
// ---------------------------------------------------------------------------

/** Stufe 1 (Fs ↔ 2Fs). */
export const STAGE1_TAPS = 47;
const STAGE1_BETA = 7;
/** Stufe 2 (2Fs ↔ 4Fs). */
export const STAGE2_TAPS = 19;
const STAGE2_BETA = 6;

interface StageDesign {
  readonly taps: Float64Array;
  /** Gruppenlaufzeit der Stufe (Samples der hohen Rate) im Bassbereich. */
  readonly delay: number;
}

function linearStage(numTaps: number, beta: number, padToEven: boolean): StageDesign {
  const h = designHalfbandFir(numTaps, beta);
  const delay = (numTaps - 1) / 2;
  if (!padToEven || delay % 2 === 0) return { taps: h, delay };
  // Eine fuehrende Null verschiebt Hoch- UND Runtertasten um je 1 Sample der
  // hohen Rate (= 1 Sample der mittleren Rate) → Gesamtlatenz ganzzahlig.
  const padded = new Float64Array(numTaps + 1);
  padded.set(h, 1);
  return { taps: padded, delay: delay + 1 };
}

function minimumStage(numTaps: number, beta: number): StageDesign {
  const taps = toMinimumPhase(designHalfbandFir(numTaps, beta));
  return { taps, delay: groupDelaySamples(taps, 0) };
}

/** Koeffizienten je Phase: [Stufe 1, Stufe 2]. Einmal beim Modul-Load. */
const DESIGNS: Record<OversamplingPhase, readonly [StageDesign, StageDesign]> = {
  linear: [linearStage(STAGE1_TAPS, STAGE1_BETA, false), linearStage(STAGE2_TAPS, STAGE2_BETA, true)],
  minimum: [minimumStage(STAGE1_TAPS, STAGE1_BETA), minimumStage(STAGE2_TAPS, STAGE2_BETA)],
};

/** Koeffizienten einer Stufe (Kopie; fuer Tests/Diagnose). */
export function oversamplingStageTaps(phase: OversamplingPhase, stage: 1 | 2): Float64Array {
  return Float64Array.from(DESIGNS[phase][stage - 1].taps);
}

/**
 * Zusatzlatenz des Oversamplings in Samples der BASISRATE (Hoch- + Runter-
 * tasten zusammen). Stufe 1 traegt ihre Gruppenlaufzeit (2·d Samples bei 2Fs
 * = d Basis-Samples), Stufe 2 die Haelfte ihrer (2·d bei 4Fs = d/2 Basis-
 * Samples). Linearphasig exakt ganzzahlig; minimalphasig der gerundete
 * Bassbereichs-Wert, den die PDC ausgleicht.
 */
export function oversamplingLatencySamples(factor: OversamplingFactor, phase: OversamplingPhase = DEFAULT_SATURATOR_PHASE): number {
  if (factor === 1) return 0;
  const [s1, s2] = DESIGNS[phase];
  const exact = factor === 2 ? s1.delay : s1.delay + s2.delay / 2;
  return Math.round(exact);
}

// ---------------------------------------------------------------------------
// Halbband-Stufe (ein Kanal): Hoch- und Runtertasten um 2
// ---------------------------------------------------------------------------

/**
 * Polyphasen-Zerlegung: beim Hochtasten liefert jede Eingangsprobe zwei
 * Ausgangsproben (Phase 0/1), jede nur aus den Taps ihrer Phase; Null-Taps
 * (Halbband) werden beim Aufbau entfernt. Beim Runtertasten wird nur jede
 * zweite Ausgangsprobe berechnet. Ringpuffer doppelt beschrieben → die
 * Faltung liest zusammenhaengend, ohne Modulo in der inneren Schleife.
 */
class HalfbandStage {
  private readonly up0c: Float64Array;
  private readonly up0d: Int32Array;
  private readonly up1c: Float64Array;
  private readonly up1d: Int32Array;
  private readonly dnc: Float64Array;
  private readonly dnd: Int32Array;
  private readonly xh: Float64Array;
  private readonly xs: number;
  private xw = 0;
  private readonly uh: Float64Array;
  private readonly us: number;
  private uw = 0;

  constructor(taps: Float64Array) {
    const p0c: number[] = []; const p0d: number[] = [];
    const p1c: number[] = []; const p1d: number[] = [];
    const dc: number[] = []; const dd: number[] = [];
    for (let i = 0; i < taps.length; i++) {
      const h = taps[i];
      if (Math.abs(h) < 1e-15) continue;
      // Hochtasten: y[2m+p] = 2·Σ_{i≡p} h[i]·x[m − (i−p)/2]
      if (i % 2 === 0) { p0c.push(2 * h); p0d.push(i / 2); } else { p1c.push(2 * h); p1d.push((i - 1) / 2); }
      // Runtertasten: y[m] = Σ h[i]·u[2m − i]
      dc.push(h); dd.push(i);
    }
    this.up0c = Float64Array.from(p0c); this.up0d = Int32Array.from(p0d);
    this.up1c = Float64Array.from(p1c); this.up1d = Int32Array.from(p1d);
    this.dnc = Float64Array.from(dc); this.dnd = Int32Array.from(dd);
    this.xs = Math.max(1, ...p0d, ...p1d) + 1;
    this.xh = new Float64Array(this.xs * 2);
    this.us = Math.max(1, ...dd) + 1;
    this.uh = new Float64Array(this.us * 2);
  }

  /** Neue Eingangsprobe (Basisrate dieser Stufe). */
  pushUp(x: number): void {
    let w = this.xw - 1;
    if (w < 0) w = this.xs - 1;
    this.xw = w;
    this.xh[w] = x;
    this.xh[w + this.xs] = x;
  }

  /** Hochgetastete Probe der Phase 0 (gerader Index). */
  upEven(): number {
    const c = this.up0c; const d = this.up0d; const h = this.xh; const w = this.xw;
    let acc = 0;
    for (let k = 0; k < c.length; k++) acc += c[k] * h[w + d[k]];
    return acc;
  }

  /** Hochgetastete Probe der Phase 1 (ungerader Index). */
  upOdd(): number {
    const c = this.up1c; const d = this.up1d; const h = this.xh; const w = this.xw;
    let acc = 0;
    for (let k = 0; k < c.length; k++) acc += c[k] * h[w + d[k]];
    return acc;
  }

  private pushDown(u: number): void {
    let w = this.uw - 1;
    if (w < 0) w = this.us - 1;
    this.uw = w;
    this.uh[w] = u;
    this.uh[w + this.us] = u;
  }

  /** Zwei Proben der hohen Rate rein, eine Probe der Basisrate raus. */
  down(u0: number, u1: number): number {
    this.pushDown(u0);
    const c = this.dnc; const d = this.dnd; const h = this.uh; const w = this.uw;
    let acc = 0;
    for (let k = 0; k < c.length; k++) acc += c[k] * h[w + d[k]];
    this.pushDown(u1);
    // Denormal-Schutz fuer die Ausklingphase (Zustand bleibt ohnehin begrenzt).
    return acc > -1e-30 && acc < 1e-30 ? 0 : acc;
  }

  reset(): void {
    this.xh.fill(0);
    this.uh.fill(0);
    this.xw = 0;
    this.uw = 0;
  }
}

// ---------------------------------------------------------------------------
// Oversampler (mehrkanalig)
// ---------------------------------------------------------------------------

/**
 * Oversampling-Huelle um eine Kennlinie, Zustand je Kanal. Speicher wird nur
 * im Konstruktor bzw. in `ensureChannels` bei MEHR Kanaelen angelegt (kein
 * Block-Takt-Fall); `process` ist allokationsfrei.
 */
export class Oversampler {
  private factorValue: OversamplingFactor;
  readonly phase: OversamplingPhase;
  private readonly stage1: HalfbandStage[] = [];
  private readonly stage2: HalfbandStage[] = [];
  private latency: number;

  constructor(factor: OversamplingFactor = DEFAULT_SATURATOR_OVERSAMPLING, phase: OversamplingPhase = DEFAULT_SATURATOR_PHASE, channels = 2) {
    this.factorValue = factor;
    this.phase = phase;
    this.latency = oversamplingLatencySamples(factor, phase);
    this.ensureChannels(channels);
  }

  get factor(): OversamplingFactor {
    return this.factorValue;
  }

  /** Zusatzlatenz in Basis-Samples (0 bei Faktor 1). */
  get latencySamples(): number {
    return this.latency;
  }

  get channelCount(): number {
    return this.stage1.length;
  }

  /** Legt Zustand fuer bis zu `channels` Kanaele an (nur bei Wachstum). */
  ensureChannels(channels: number): void {
    const [s1, s2] = DESIGNS[this.phase];
    while (this.stage1.length < channels) {
      this.stage1.push(new HalfbandStage(s1.taps));
      this.stage2.push(new HalfbandStage(s2.taps));
    }
  }

  /** Faktor umschalten (setzt den Filterzustand zurueck, keine Allokation). */
  setFactor(factor: OversamplingFactor): void {
    if (factor === this.factorValue) return;
    this.factorValue = factor;
    this.latency = oversamplingLatencySamples(factor, this.phase);
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < this.stage1.length; i++) {
      this.stage1[i].reset();
      this.stage2[i].reset();
    }
  }

  /**
   * Eine Probe der Basisrate durch die Kennlinie (oversampled). `ch` muss
   * < `channelCount` sein (vorher `ensureChannels`). NaN/Inf am Eingang wird
   * zu 0, damit der Filterzustand nicht dauerhaft vergiftet wird.
   */
  process(ch: number, x: number, shaper: SampleShaper): number {
    const factor = this.factorValue;
    if (factor === 1) return shaper.shape(x);
    const input = Number.isFinite(x) ? x : 0;
    const a = this.stage1[ch];
    a.pushUp(input);
    const u0 = a.upEven();
    const u1 = a.upOdd();
    if (factor === 2) return a.down(shaper.shape(u0), shaper.shape(u1));
    const b = this.stage2[ch];
    b.pushUp(u0);
    const v0 = b.down(shaper.shape(b.upEven()), shaper.shape(b.upOdd()));
    b.pushUp(u1);
    const v1 = b.down(shaper.shape(b.upEven()), shaper.shape(b.upOdd()));
    return a.down(v0, v1);
  }
}

/**
 * OFFLINE (nicht im Render-Pfad): formt einen ganzen Puffer in place mit
 * oversampelter Kennlinie. Linearphasig, die Filterlatenz wird exakt
 * herausgerechnet (Ausgang zeitgleich zum Eingang) – offline kostet das nichts.
 * Fuer vorab gerenderte Klaenge (z. B. Drum-Synthese beim Trigger).
 */
export function shapeBufferOversampled(buf: Float32Array, shaper: SampleShaper, factor: OversamplingFactor = DEFAULT_SATURATOR_OVERSAMPLING): Float32Array {
  if (factor === 1) {
    for (let i = 0; i < buf.length; i++) buf[i] = shaper.shape(buf[i]);
    return buf;
  }
  const os = new Oversampler(factor, 'linear', 1);
  const latency = os.latencySamples;
  const total = buf.length + latency;
  // Lesen bei i, Schreiben bei i − latency (bereits gelesen) → in place sicher.
  for (let i = 0; i < total; i++) {
    const y = os.process(0, i < buf.length ? buf[i] : 0, shaper);
    if (i >= latency) buf[i - latency] = y;
  }
  return buf;
}

/**
 * Die tanh-Drive-Kennlinie der DSP-Saettiger: `tanh(x·pre) / norm`. Ein
 * Objekt je Knoten; `pre`/`norm` werden je Block gesetzt (keine Closure).
 */
export class TanhDriveShaper implements SampleShaper {
  pre = 1;
  norm = 1;
  shape(x: number): number {
    return Math.tanh(x * this.pre) / this.norm;
  }
}
