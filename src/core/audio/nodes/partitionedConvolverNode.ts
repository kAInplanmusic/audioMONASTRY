/**
 * audioMONASTRY · Partitionierter Faltungshall im V2-Graph (ZUK-004)
 * ==============================================================
 * Bindet PartitionedConvolver (UPOLS, erste Partition zeitdiskret) als echten
 * IAudioNode in denselben V2-ProcessingPlan, den Worklet und Offline-Bounce
 * benutzen. Der Kern bleibt plattformfrei; dieser Node auch (kein AudioContext,
 * kein DOM, keine Timer) – die Verdrahtung macht der Host.
 *
 * Latenz: 0 Samples. latencySamples ist 0, weil die erste Partition
 * (Taps 0..P−1) im Zeitbereich gefaltet wird: y[n] hängt nur von x[0..n] ab.
 * (Beweis: tests/partitionedConvolver.test.ts – Impuls-IR, Onset bei 0,
 * Ausgabe == Eingabe bit-identisch).
 *
 * Kanäle
 * ------
 * Der Node hat zwei unabhängige Faltungsspuren (L/R). Ein mono-Eingang nutzt
 * Spur 0; ein stereo-Eingang Spur 0/1. Eine mono-IR wird in beide Spuren
 * geladen (kein Cross-Feed), eine stereo-IR in Spur 0/1. Der Ausgang hat so
 * viele Kanäle wie der Eingang – der Node erfindet keine Kanäle.
 *
 * Dry/Wet
 * -------
 * Die Mischung passiert hier, nicht im Kern: out = dry·(1−wet) + wet·conv(x).
 * wet = 0 oder enabled = 0 geben den Eingang bit-identisch zurück (der
 * Port-Puffer ist eine Kopie des Eingangs via copyInput), wet = 1 gibt exakt
 * den nassen Pfad aus (keine dry·0-Rundung).
 *
 * Allokationen
 * ------------
 * Scratch für den nassen Pfad liegt ab Konstruktion für Blocklängen bis
 * PARTITIONED_CONVOLVER_MAX_BLOCK (= 4096 Samples) bereit; process()
 * allokiert im eingeschwungenen Zustand nichts (gemessen in
 * tests/partitionedConvolverNode.test.ts: 1000 Blöcke, Heap-Δ ≈ 0). Ein
 * LÄNGERER Block legt den Scratch EINMAL neu an (Kapazität wächst nur, wie
 * ensureOutput bei Blockgrößenwechsel) – danach ist es wieder allocation-free.
 * IR-Wechsel/Partitionswechsel allokieren und gehören NICHT in den Audio-Thread
 * (setImpulseResponse/setPartitionSize); der laufende Zustand wird dabei
 * bewusst zurückgesetzt (Tail weg, dokumentierter Reset).
 */
import { AudioParameter } from '../AudioGraph';
import { BaseNode } from './basicNodes';
import {
  isSupportedPartitionSize,
  PartitionedConvolver,
  PARTITIONED_CONVOLVER_MAX_BLOCK,
} from '../partitionedConvolver';
import type { IProcessingContext } from '../types';
import type { AutomatableV2Node } from '../state/v2NodeAutomation';

export type ImpulseResponse = Float32Array | readonly Float32Array[];

/**
 * Latenzfreier partitionierter Faltungshall-Knoten im V2-Graphen.
 *
 * Parameter:
 *   enabled (0..1, default 0) – einschalten/ausschalten (bypass-transparent).
 *   wet   (0..1, default 1)   – Mischverhält trocken/nass.
 *
 * setImpulseResponse(ir): IR laden (Kopie, Host behält Referenz).
 * setPartitionSize(samples): Partitionsgröße ändert sich beim nächsten
 *   setImpulseResponse (oder sofort, wenn IR bereits geladen ist).
 *
 * dry / wet Mischung geschieht im Knoten, komplett frei von WebAudio.
 */
export class PartitionedConvolverNode extends BaseNode implements AutomatableV2Node {
  /** enabled (0..1, default 0) – Bypass transparent bei 0. */
  readonly enabled: AudioParameter;
  /** wet (0..1, default 1) – Nass/Trocken Mischung. */
  readonly wet: AudioParameter;
  /** Zusätzliche Latenz in Samples. Ist immer 0 (erste Partition zeitdiskret). */
  readonly latencySamples = 0;

  /** Kopien der geladenen Impulsantworten (mono oder stereo). */
  private impulse: Float32Array[] = [];
  /** Zwei unabhängige ConvolutionLanes (L und R). */
  private readonly convolvers: PartitionedConvolver[] = [];
  /** Scratch-Puffer für den nassen Pfad, immer für MAX_BLOCK belegt. */
  private scratch: Float32Array[] = [];
  /** Zählt pro setImpulseResponse/Scope, um Neubauten zu invalidieren. */
  private irVersion = 0;
  /** Aktuell gebaute Kanalzahl (bei -1: noch nicht gebaut). */
  private builtChannels = -1;
  /** Aktuell gebaute PartitionSize. */
  private builtPartitionSize = -1;
  /** Zählt Version für Neubauten (inkrementiert bei setImpulseResponse). */
  private builtVersion = -1;
  /** Aktuell konfigurierte Partitionsgröße (wirkt beim nächsten process()-Aufruf). */
  private partitionSizeValue: number;

  /**
   * Erzeugt einen neuen Partitionierten Faltungshall-Knoten.
   *
   * @param id            Eindeutige ID für den Node.
   * @param partitionSize Partitionsgröße P (Zweierpotenz, Standard 256).
   *                      muss in [4, 262144] liegen und eine Zweierpotenz sein.
   */
  constructor(id: string, partitionSize = 256) {
    if (!isSupportedPartitionSize(partitionSize)) {
      throw new RangeError(
        `PartitionedConvolverNode: partitionSize muss eine Zweierpotenz in [${4}, ${1 << 18}] sein (war ${partitionSize})`,
      );
    }
    super(id, 'partitioned-convolver', 1, 1);
    this.partitionSizeValue = partitionSize;
    this.enabled = new AudioParameter('enabled', 0, 1, 0);
    this.wet = new AudioParameter('wet', 0, 1, 1);
    this.parameters.push(this.enabled, this.wet);
    // Scratch-Puffer ab Konstruktion für MAX_BLOCK pro Kanal (L/R) belegen.
    this.scratch = [
      new Float32Array(PARTITIONED_CONVOLVER_MAX_BLOCK),
      new Float32Array(PARTITIONED_CONVOLVER_MAX_BLOCK),
    ];
  }

  /** @returns die konfigurierte Partitionsgröße. */
  get partitionSize(): number {
    return this.partitionSizeValue;
  }

  /** @returns die Anzahl der Kanäle der geladenen Impulsantwort (1 oder 2). */
  get impulseLength(): number {
    return this.impulse.length;
  }

  /** Setzt die Impulsantwort und baut die internen Faltungsspuren neu. */
  setImpulseResponse(ir: ImpulseResponse): void {
    const list: readonly Float32Array[] = ir instanceof Float32Array ? [ir] : ir;
    if (list.length < 1 || list.length > 2) {
      throw new RangeError(
        `setImpulseResponse: 1 oder 2 Kanäle erwartet (waren ${list.length})`,
      );
    }
    const copies: Float32Array[] = [];
    for (const channel of list) {
      if (!(channel instanceof Float32Array)) {
        throw new TypeError('setImpulseResponse: jeder Kanal muss ein Float32Array sein');
      }
      if (channel.length === 0) {
        throw new RangeError('setImpulseResponse: leerer Kanal');
      }
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      copies.push(copy);
    }
    this.impulse = copies;
    this.irVersion++;
    // Neue Spuren bauen – dies passiert einmalig hier (RT-unfähig, wie
    // loadImpulseResponse im Kern). Der Zustand wird zurückgesetzt (Tail weg).
    this.rebuild();
  }

  /** Setzt die Partitionsgröße. Wirksam wird die neue Größe beim nächsten
   *  process()-Aufruf (der Spuren werden dann neu aufgebaut). Solange der
   *  laufende Hall unverändert bleibt (kein Glitch, dokumentierter Reset). */
  setPartitionSize(samples: number): void {
    if (!isSupportedPartitionSize(samples)) {
      throw new RangeError(
        `setPartitionSize: Zweierpotenz in [${4}, ${1 << 18}] erwartet (war ${samples})`,
      );
    }
    if (samples === this.partitionSizeValue) return;
    this.partitionSizeValue = samples;
    // Kein sofortiger Effekt – gilt beim nächsten process().
    // (Solange der laufende Hall unverändert bleibt – kein Reset, kein Glitch.)
  }

  /** Rekonstruiert die internen ConvolutionLanes aus dem aktuellen IR und
   *  der aktuellen Partitionsgröße. Der alte Tail wird dabei bewusst
   *  zurückgesetzt (dokumentierter Reset). */
  private rebuild(): void {
    this.convolvers.length = 0;
    const size = this.partitionSizeValue;
    for (let ch = 0; ch < this.impulse.length; ch++) {
      // maximal so viele Spuren bauen wie IR-Kanäle, aber nie mehr als 2
      const convolver = new PartitionedConvolver(size);
      convolver.loadImpulseResponse(this.impulse[ch]);
      this.convolvers.push(convolver);
    }
    // Fehlende Spuren (falls Eingang mehr Kanäle als IR-Kanäle hat) bleiben
    // trocken (out ist schon die bit-identische Kopie des Eingangs).
    this.builtChannels = this.impulse.length;
    this.builtPartitionSize = size;
    this.builtVersion = this.irVersion;
  }

  /** Sorgt dafür, dass `convolvers` für die kommende Blockverarbeitung
   *  die richtige Anzahl an Spuren bereithält (Allokation nur bei
   *  Kanal- oder IR-Wechsel, genau wie `ensureReverbs` in
   *  `HqReverbNode`). */
  private ensureConvolvers(channels: number): void {
    if (
      this.builtChannels === channels &&
      this.builtPartitionSize === this.partitionSizeValue &&
      this.builtVersion === this.irVersion
    ) {
      return;
    }
    this.builtChannels = channels;
    this.builtPartitionSize = this.partitionSizeValue;
    this.builtVersion = this.irVersion;
    // Spuren neu bauen (Allokation, wie `ensureOutput` bei Blockgrößenwechsel).
    this.convolvers.length = channels;
    const size = this.partitionSizeValue;
    for (let ch = 0; ch < channels; ch++) {
      const convolver = new PartitionedConvolver(size);
      convolver.loadImpulseResponse(this.impulse[Math.min(ch, this.impulse.length - 1)]);
      this.convolvers[ch] = convolver;
    }
  }

  /** Sorgt für einen Scratch-Puffer der genügend Kapazität für `len`
   *  Samples hat (mindestens PARTITIONED_CONVOLVER_MAX_BLOCK). Bei längerer
   *  Blocklänge wächst der Puffer einmalig (dokumentiert, wie
   *  `ensureOutput` bei Blockgrößenwechsel). */
  private ensureScratch(channels: number, len: number): Float32Array[] {
    const needed = Math.max(len, PARTITIONED_CONVOLVER_MAX_BLOCK);
    if (this.scratch.length >= channels && this.scratch[0].length >= needed) return this.scratch;
    const next: Float32Array[] = new Array<Float32Array>(channels);
    for (let ch = 0; ch < channels; ch++) {
      next[ch] = new Float32Array(needed);
    }
    this.scratch = next;
    return next;
  }

  /** Vollständiger Verarbeitungszyklus. */
  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { out, len } = block;

    const active = this.enabled.getValueAtTime(ctx.currentTime) > 0.5;
    const wet = Math.min(1, Math.max(0, this.wet.getValueAtTime(ctx.currentTime)));

    // Aus, trocken oder ohne IR: der Port-Puffer ist bereits die bit-identische
    // Kopie des Eingangs (copyInput in BaseNode). Kein Filterrest, keine Kosten.
    if (!active || wet <= 0 || this.impulse.length === 0) {
      this.outputs[0].buffer = out;
      return;
    }

    const channels = out.length;
    this.ensureConvolvers(channels);
    const scratch = this.ensureScratch(channels, len);

    for (let ch = 0; ch < channels; ch++) {
      const convolver = this.convolvers[ch];
      if (!convolver) continue;

      const wetChannel = scratch[ch];
      // `out[ch]` ist die trockene Kopie mit exakt `len` Samples. Der Kern
      // liest input.length Samples – hier sind das genau `len`, also passgenau.
      convolver.process(out[ch], wetChannel);
      // NaN-Schutz nach Convolution: sicherstellen, dass nass-Signal kein NaN enthält
      for (let i = 0; i < len; i++) {
        if (!Number.isFinite(wetChannel[i])) wetChannel[i] = 0;
      }
      const dryChannel = out[ch];

      if (wet >= 1) {
        for (let i = 0; i < len; i++) {
          const s = wetChannel[i];
          dryChannel[i] = Number.isFinite(s) ? s : 0;
        }
      } else if (wet > 0) {
        const dryGain = 1 - wet;
        for (let i = 0; i < len; i++) {
          const s = dryChannel[i] * dryGain + wetChannel[i] * wet;
          dryChannel[i] = Number.isFinite(s) ? s : 0;
        }
      } else {
        // wet <= 0 bereits oben abgefangen, aber schutzhalber:
        this.outputs[0].buffer = out;
        return;
      }
    }
    this.outputs[0].buffer = out;
  }

  /** Setzt alle Parameter zurück (enabled → 0, wet → 1) und leert den
   *  Ausgangs-Port-Puffer. Die Impulsantwort (IR) bleibt erhalten. */
  reset(): void {
    this.enabled.reset();
    this.wet.reset();
    for (const convolver of this.convolvers) convolver.reset();
    this.outputs[0].buffer = null;
  }
}