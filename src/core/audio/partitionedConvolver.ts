/**
 * audioMONASTRY · Partitionierter Faltungshall, latenzfrei (ZUK-004)
 * ==================================================================
 * Uniform-partitionierte Overlap-Save-Faltung (UPOLS) mit radix-2-FFT und
 * **null zusätzlicher Latenz**: die erste Partition (Taps 0..P−1) wird
 * zeitdiskret gefaltet, alle weiteren Partitionen laufen über die
 * Frequenzbereichs-Verzögerungsleitung (frequency-domain delay line, FDL).
 *
 * Warum das latenzfrei ist
 * ------------------------
 * Die klassische blockweise Faltung liefert die Ausgabe eines Blocks erst,
 * wenn der Block komplett ist – bei P = 256 also 256 Samples Verzögerung.
 * Hier gilt für die Partition k (Taps kP..kP+P−1):
 *
 *     y[t] = Σ_k Σ_q h[kP+q] · x[t − kP − q]
 *
 * Für k ≥ 1 ist der jüngste benötigte Eingangswert x[t − P] – also älter als
 * ein ganzer Block. Die FFT-Beiträge der Partitionen 1..K−1 hängen deshalb
 * ausschließlich von *abgeschlossenen* Blöcken ab und können berechnet
 * werden, bevor der erste Sample des aktuellen Blocks eintrifft. Partition 0
 * (k = 0) braucht dagegen x[t] selbst und läuft deshalb direkt im
 * Sample-Takt über den 2P-Rahmen (letzte P Samples = Vorblock, zweite Hälfte
 * = aktueller Block). Ergebnis: `y[n]` hängt nur von `x[0..n]` ab, die
 * Ausgabe von Sample 0 entsteht im selben Aufruf wie die Eingabe von
 * Sample 0. Zusätzliche Latenz = **0 Samples** (gemessen in
 * `tests/partitionedConvolver.test.ts`).
 *
 * Preis dieser Entscheidung (bewusst, Latenz-Mandat 2026-10-13):
 * Partition 0 kostet P Multiplikationen pro Sample im Audio-Thread. Kleine
 * Partitionen (64/128) senken diese Kosten und erhöhen die Zahl der
 * FFT-Partitionen; große (512/1024) machen das Gegenteil. P = 256 ist ein
 * brauchbarer Kompromiss (bei 48 kHz: 12,3 M MAC/s für Partition 0).
 *
 * Gemessen (2026-10-24, Node 22, 1 Thread, `tests/partitionedConvolver.test.ts`)
 * ------------------------------------------------------------------------------
 * - Zusatzlatenz: **0 Samples** (Onset bei Impuls-IR exakt an Index N, erster
 *   Ausgangssample = h[0]·x[0]).
 * - Genauigkeit gegen direkte Faltung (Float64): RMS 4,8e-7 bei 1500 Taps/P=256,
 *   8,3e-7 bei 8192 Taps/P=64, 1,9e-6 bei 48000 Taps/P=1024 (relativ ~1e-8).
 * - Blockgrößen 1/37/64/128/256/1000/1024/4096: bit-identische Ausgabe.
 * - `process()` allokiert nichts: 200 000 Aufrufe → heapUsed unverändert
 *   (Δ < 0 nach GC, also Rauschen), 129 µs je 128-Sample-Block bei 12 000 Taps
 *   (= 4,8 % des 2,7-ms-Budgets bei 48 kHz).
 * - Teuer wird es bei sehr langen IRs: 10 s IR (480 000 Taps) mit P = 256
 *   kostet ~103 % eines Kerns; mit P = 1024 nur ~30 %. Für solche Fälle wäre
 *   nicht-uniforme Partitionierung der nächste Schritt (nicht Teil von ZUK-004).
 *
 * Reiner Baustein (Plattform-Grenze, AGENTS.md): kein AudioContext, kein DOM,
 * keine Worker, keine Timer. `process()` allokiert nichts – alle Puffer
 * entstehen in `loadImpulseResponse()`/im Konstruktor. Den WebAudio-Node
 * baut ein Adapter außerhalb von `src/core/**`.
 */

/** Kleinste erlaubte Partition (2 Samples reichen für radix-2 nicht sinnvoll). */
const MIN_PARTITION_SIZE = 4;
/** Obergrenze, damit die Bit-Reversal-Tabelle (1 << bits) nicht entgleist. */
const MAX_PARTITION_SIZE = 1 << 18;

/** Öffentliche Prüfung, ob `value` als Partitionsgröße zulässig ist (ZUK-004‑Node). */
export function isSupportedPartitionSize(value: number): boolean {
  return isPowerOfTwo(value);
}

/** Kleinste erlaubte Partition (2 Samples reichen für radix-2 nicht sinnvoll). */
export const PARTITION_SIZE_MIN = MIN_PARTITION_SIZE;
/** Obergrenze, damit die Bit-Reversal-Tabelle (1 << bits) nicht entgleist. */
export const PARTITION_SIZE_MAX = MAX_PARTITION_SIZE;
/** Maximale Blocklänge, für die Scratch vorab belegt ist (Samples). */
export const PARTITIONED_CONVOLVER_MAX_BLOCK = 4096;

/** Puffer, auf denen die FFT rechnet (Float64 intern für Kopffreiraum). */
type RealBuffer = Float32Array | Float64Array;

/** Echte Potenzzwei-Prüfung (kein Log10-Rundungsfehler). */
function isPowerOfTwo(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_PARTITION_SIZE &&
    value <= MAX_PARTITION_SIZE &&
    (value & (value - 1)) === 0
  );
}

/** NaN/Infinity dürfen nie in den Frequenzbereich wandern (sonst ist alles verloren). */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Iterative radix-2-FFT (Cooley-Tukey, decimation in time) mit vorberechneter
 * Bit-Reversal-Permutation und Twiddle-Tabellen. Alle Tabellen entstehen im
 * Konstruktor; `forward`/`inverse` allokieren nichts.
 */
class Radix2Fft {
  readonly size: number;
  private readonly reverse: Uint32Array;
  /** cos(2πk/N) für k = 0..N/2−1 */
  private readonly cosTable: Float64Array;
  /** sin(2πk/N) für k = 0..N/2−1 */
  private readonly sinTable: Float64Array;

  constructor(size: number) {
    if (!isPowerOfTwo(size)) {
      throw new RangeError(`Radix2Fft: Größe muss eine Zweierpotenz in [${MIN_PARTITION_SIZE}, ${MAX_PARTITION_SIZE}] sein (war ${size})`);
    }
    this.size = size;
    let levels = 0;
    while (1 << levels < size) levels++;

    const reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let reversed = 0;
      for (let bit = 0; bit < levels; bit++) {
        reversed |= ((i >>> bit) & 1) << (levels - 1 - bit);
      }
      reverse[i] = reversed;
    }
    this.reverse = reverse;

    const half = size >>> 1;
    const cosTable = new Float64Array(half);
    const sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const angle = (2 * Math.PI * i) / size;
      cosTable[i] = Math.cos(angle);
      sinTable[i] = Math.sin(angle);
    }
    this.cosTable = cosTable;
    this.sinTable = sinTable;
  }

  /** Vorwärts-FFT (e^{−j2πkn/N}), in-place. */
  forward(re: RealBuffer, im: RealBuffer): void {
    this.transform(re, im, -1);
  }

  /** Rückwärts-FFT (e^{+j2πkn/N}) mit 1/N-Skalierung, in-place. */
  inverse(re: RealBuffer, im: RealBuffer): void {
    this.transform(re, im, 1);
    const scale = 1 / this.size;
    for (let i = 0; i < this.size; i++) {
      re[i] *= scale;
      im[i] *= scale;
    }
  }

  private transform(re: RealBuffer, im: RealBuffer, direction: number): void {
    const n = this.size;
    const reverse = this.reverse;
    for (let i = 0; i < n; i++) {
      const j = reverse[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    const cosTable = this.cosTable;
    const sinTable = this.sinTable;
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >>> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let j = 0; j < halfLen; j++) {
          const t = j * step;
          const wr = cosTable[t];
          const wi = direction * sinTable[t];
          const a = start + j;
          const b = a + halfLen;
          const br = re[b];
          const bi = im[b];
          const xr = br * wr - bi * wi;
          const xi = br * wi + bi * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/**
 * Zustand einer Faltungsspur. Alle Puffer werden beim Laden der Impulsantwort
 * angelegt – im Prozesspfad wird nichts mehr allokiert.
 */
interface ConvolutionLane {
  /** Partition 0 (Taps 0..P−1) für die zeitdiskrete, latenzfreie Faltung. */
  readonly h0: Float32Array;
  /** Anzahl gültiger Taps in `h0` (= min(P, irLength)). */
  readonly h0Length: number;
  /** Overlap-Save-Rahmen: [Vorblock (P) | aktueller Block (P)]. */
  readonly frame: Float64Array;
  /** FFT-Anteil (Partitionen ≥ 1) für den aktuellen Block, P Samples. */
  readonly fftBlock: Float64Array;
  /** FDL: Spektren der letzten (K−1) Eingangsrahmen, je N Werte. */
  readonly fdlRe: Float32Array;
  readonly fdlIm: Float32Array;
  /** Vorab berechnete Spektren der Partitionen 1..K−1, je N Werte. */
  readonly specRe: Float32Array;
  readonly specIm: Float32Array;
  /** Arbeitsspeicher der FFT / der Akkumulation (N Werte). */
  readonly workRe: Float64Array;
  readonly workIm: Float64Array;
  readonly accRe: Float64Array;
  readonly accIm: Float64Array;
}

/**
 * Latenzfreier partitionierter Faltungshall.
 *
 * ```ts
 * const conv = new PartitionedConvolver(256);      // Partition = 256 Samples
 * conv.loadImpulseResponse(irMono);                // mono  → 1→1
 * conv.process(input, output);                     // output.length === input.length
 *
 * const stereo = new PartitionedConvolver(256);
 * stereo.loadImpulseResponse([irL, irR]);          // stereo
 * stereo.process(input, interleavedOut);           // 1→2, L/R verschränkt
 * stereo.processStereo(inL, inR, outL, outR);      // 2→2, planar
 * ```
 *
 * Threading: `loadImpulseResponse()` und `reset()` gehören NICHT in den
 * Audio-Thread (sie allokieren). `process()`/`processStereo()` allokieren
 * nichts, sind deterministisch und blockgrößenunabhängig: dieselbe Eingabe
 * ergibt bei jeder Blockgröße bit-identische Ausgabe.
 */
export class PartitionedConvolver {
  /** Partitionsgröße P (Hop des Overlap-Save-Verfahrens). */
  readonly partitionSize: number;
  /** FFT-Länge N = 2P (Overlap-Save-Rahmen = ein Vorblock + ein Block). */
  readonly fftSize: number;
  /**
   * Zusätzliche Latenz in Samples. Immer 0: die erste Partition wird
   * zeitdiskret gefaltet, deshalb beginnt die Ausgabe bei Sample 0.
   */
  readonly latencySamples = 0;

  private readonly fft: Radix2Fft;
  private lanes: ConvolutionLane[] = [];
  private laneCount = 0;
  /** Anzahl Partitionen K = ceil(irLength / P). */
  private partitionCount = 0;
  private irSamples = 0;
  /** Position im aktuellen Block (0..P−1). */
  private blockPos = 0;
  /** Index des aktuellen Blocks (n). */
  private blockIndex = 0;

  constructor(partitionSize = 256) {
    if (!isPowerOfTwo(partitionSize)) {
      throw new RangeError(
        `PartitionedConvolver: partitionSize muss eine Zweierpotenz in [${MIN_PARTITION_SIZE}, ${MAX_PARTITION_SIZE}] sein (war ${partitionSize})`,
      );
    }
    this.partitionSize = partitionSize;
    this.fftSize = partitionSize * 2;
    this.fft = new Radix2Fft(this.fftSize);
  }

  /** Anzahl der IR-Kanäle (0 = noch keine Impulsantwort geladen). */
  get channels(): number {
    return this.laneCount;
  }

  /** Länge der geladenen Impulsantwort in Samples (Maximum über die Kanäle). */
  get impulseLength(): number {
    return this.irSamples;
  }

  /** Anzahl Partitionen K = ceil(impulseLength / partitionSize). */
  get partitions(): number {
    return this.partitionCount;
  }

  /**
   * Lädt eine mono- oder stereofone Impulsantwort und rechnet die Spektren der
   * Partitionen 1..K−1 vor. Partition 0 bleibt als Tap-Kopie für den
   * zeitdiskreten Pfad erhalten.
   *
   * Nicht RT-sicher (allokiert); einmalig vor dem Processing aufrufen.
   */
  loadImpulseResponse(ir: Float32Array | readonly Float32Array[]): void {
    const channelData: readonly Float32Array[] = ir instanceof Float32Array ? [ir] : ir;
    if (channelData.length < 1 || channelData.length > 2) {
      throw new RangeError(`loadImpulseResponse: 1 oder 2 Kanäle erwartet (waren ${channelData.length})`);
    }
    let irLength = 0;
    for (const channel of channelData) {
      if (!(channel instanceof Float32Array)) {
        throw new TypeError('loadImpulseResponse: jeder Kanal muss ein Float32Array sein');
      }
      if (channel.length === 0) {
        throw new RangeError('loadImpulseResponse: leerer Kanal');
      }
      if (channel.length > irLength) irLength = channel.length;
    }

    const p = this.partitionSize;
    const n = this.fftSize;
    const k = Math.max(1, Math.ceil(irLength / p));
    const slots = k - 1;
    const h0Length = Math.min(p, irLength);

    const lanes: ConvolutionLane[] = [];
    for (const data of channelData) {
      const h0 = new Float32Array(p);
      for (let i = 0; i < h0Length; i++) h0[i] = finiteOrZero(data[i]);

      const lane: ConvolutionLane = {
        h0,
        h0Length,
        frame: new Float64Array(n),
        fftBlock: new Float64Array(p),
        fdlRe: new Float32Array(slots * n),
        fdlIm: new Float32Array(slots * n),
        specRe: new Float32Array(slots * n),
        specIm: new Float32Array(slots * n),
        workRe: new Float64Array(n),
        workIm: new Float64Array(n),
        accRe: new Float64Array(n),
        accIm: new Float64Array(n),
      };

      // Partitionen 1..K−1: Taps [kP, (k+1)P) auf 2P nullauffüllen und vorrechnen.
      for (let partition = 1; partition < k; partition++) {
        const start = partition * p;
        const available = Math.max(0, Math.min(data.length, start + p) - start);
        lane.workRe.fill(0);
        lane.workIm.fill(0);
        for (let i = 0; i < available; i++) lane.workRe[i] = finiteOrZero(data[start + i]);
        this.fft.forward(lane.workRe, lane.workIm);
        const base = (partition - 1) * n;
        lane.specRe.set(lane.workRe, base);
        lane.specIm.set(lane.workIm, base);
      }

      lanes.push(lane);
    }

    this.lanes = lanes;
    this.laneCount = lanes.length;
    this.partitionCount = k;
    this.irSamples = irLength;
    this.reset();
  }

  /** Setzt den Faltungszustand zurück (Transport-Stop); die IR bleibt geladen. */
  reset(): void {
    for (const lane of this.lanes) {
      lane.frame.fill(0);
      lane.fftBlock.fill(0);
      lane.fdlRe.fill(0);
      lane.fdlIm.fill(0);
      lane.workRe.fill(0);
      lane.workIm.fill(0);
      lane.accRe.fill(0);
      lane.accIm.fill(0);
    }
    this.blockPos = 0;
    this.blockIndex = 0;
  }

  /**
   * Mono-Eingang. Ausgabe-Layout folgt der IR: mono → `output` braucht
   * `input.length` Samples, stereo-IR → `2 * input.length` Samples,
   * verschränkt (L, R, L, R, …). `output` darf `input` nicht überlappen.
   */
  process(input: Float32Array, output: Float32Array): void {
    this.assertLoaded();
    const length = input.length;
    if (length === 0) return;
    const channels = this.laneCount;
    const needed = length * channels;
    if (output.length < needed) {
      throw new RangeError(`process: output braucht ${needed} Samples für ${channels} Kanal/Kanäle (hat ${output.length})`);
    }

    const p = this.partitionSize;
    let index = 0;
    while (index < length) {
      if (this.blockPos === 0) this.beginBlock();
      const pos = this.blockPos;
      const take = Math.min(p - pos, length - index);
      if (channels === 1) {
        this.renderSegment(this.lanes[0], input, index, output, index, 1, take, pos);
      } else {
        this.renderSegment(this.lanes[0], input, index, output, index * 2, 2, take, pos);
        this.renderSegment(this.lanes[1], input, index, output, index * 2 + 1, 2, take, pos);
      }
      this.blockPos = pos + take;
      index += take;
      if (this.blockPos === p) {
        this.blockPos = 0;
        this.blockIndex++;
      }
    }
  }

  /**
   * Planarer Stereopfad (2→2): `outL`/`outR` bekommen je `inL.length` Samples.
   * Linker Kanal wird mit der linken IR gefaltet, rechter mit der rechten
   * (kein Cross-Feed).
   */
  processStereo(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void {
    this.assertLoaded();
    if (this.laneCount !== 2) {
      throw new Error('processStereo: nur mit stereofoner Impulsantwort (2 Kanäle) aufrufbar');
    }
    const length = Math.min(inL.length, inR.length);
    if (length === 0) return;
    if (outL.length < length || outR.length < length) {
      throw new RangeError('processStereo: outL/outR müssen mindestens inL.length Samples fassen');
    }

    const p = this.partitionSize;
    let index = 0;
    while (index < length) {
      if (this.blockPos === 0) this.beginBlock();
      const pos = this.blockPos;
      const take = Math.min(p - pos, length - index);
      this.renderSegment(this.lanes[0], inL, index, outL, index, 1, take, pos);
      this.renderSegment(this.lanes[1], inR, index, outR, index, 1, take, pos);
      this.blockPos = pos + take;
      index += take;
      if (this.blockPos === p) {
        this.blockPos = 0;
        this.blockIndex++;
      }
    }
  }

  /**
   * Blockanfang: (a) Rahmen des abgeschlossenen Vorblocks in die FDL schieben,
   * (b) FFT-Beitrag der Partitionen ≥ 1 für den *kommenden* Block rechnen,
   * (c) Rahmen um einen Block nach links schieben.
   *
   * (b) braucht nur Blöcke n−1 … n−K+1 – deshalb ist die Ausgabe von Block n
   * fertig, bevor dessen erster Sample eintrifft.
   */
  private beginBlock(): void {
    const p = this.partitionSize;
    const n = this.fftSize;
    const slots = this.partitionCount - 1;
    const block = this.blockIndex;
    const lanes = this.lanes;
    const laneCount = this.laneCount;

    if (slots > 0 && block > 0) {
      const slot = (block - 1) % slots;
      const base = slot * n;
      for (let c = 0; c < laneCount; c++) {
        const lane = lanes[c];
        const re = lane.workRe;
        const im = lane.workIm;
        const frame = lane.frame;
        for (let i = 0; i < n; i++) {
          re[i] = frame[i];
          im[i] = 0;
        }
        this.fft.forward(re, im);
        lane.fdlRe.set(re, base);
        lane.fdlIm.set(im, base);
      }
    }

    const active = slots > 0 && block > 0;
    for (let c = 0; c < laneCount; c++) {
      const lane = lanes[c];
      if (!active) {
        lane.fftBlock.fill(0);
      } else {
        const accRe = lane.accRe;
        const accIm = lane.accIm;
        const fdlRe = lane.fdlRe;
        const fdlIm = lane.fdlIm;
        const specRe = lane.specRe;
        const specIm = lane.specIm;
        accRe.fill(0);
        accIm.fill(0);
        for (let partition = 1; partition <= slots; partition++) {
          let slot = (block - partition) % slots;
          if (slot < 0) slot += slots;
          const fBase = slot * n;
          const hBase = (partition - 1) * n;
          for (let i = 0; i < n; i++) {
            const xr = fdlRe[fBase + i];
            const xi = fdlIm[fBase + i];
            const hr = specRe[hBase + i];
            const hi = specIm[hBase + i];
            accRe[i] += xr * hr - xi * hi;
            accIm[i] += xr * hi + xi * hr;
          }
        }
        this.fft.inverse(accRe, accIm);
        const fftBlock = lane.fftBlock;
        for (let i = 0; i < p; i++) fftBlock[i] = accRe[p + i];
      }
      // Vorblock wird zum linken Teil des nächsten Rahmens.
      lane.frame.copyWithin(0, p);
    }
  }

  /**
   * Samples [pos0, pos0+take) eines Blocks: Partition 0 zeitdiskret plus
   * FFT-Anteil. Keine Allokation, keine Verzweigung pro Tap.
   */
  private renderSegment(
    lane: ConvolutionLane,
    src: Float32Array,
    srcOffset: number,
    dst: Float32Array,
    dstOffset: number,
    dstStride: number,
    take: number,
    pos0: number,
  ): void {
    const p = this.partitionSize;
    const frame = lane.frame;
    const fftBlock = lane.fftBlock;
    const h0 = lane.h0;
    const taps = lane.h0Length;
    for (let j = 0; j < take; j++) {
      const pos = pos0 + j;
      const write = p + pos;
      frame[write] = finiteOrZero(src[srcOffset + j]);
      let acc = fftBlock[pos];
      for (let q = 0; q < taps; q++) acc += h0[q] * frame[write - q];
      dst[dstOffset + j * dstStride] = acc;
    }
  }

  private assertLoaded(): void {
    if (this.laneCount === 0) {
      throw new Error('PartitionedConvolver: keine Impulsantwort geladen (loadImpulseResponse fehlt)');
    }
  }
}
