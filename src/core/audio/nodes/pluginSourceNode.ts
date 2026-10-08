/**
 * audioMONASTRY · Plugin-Quellenknoten (C1 Teil 2)
 * ===============================================
 * Die 9 spielenden Plugins als je EIGENER Knoten - statt eines generischen
 * `SourceNode`. Der Knoten kennt seinen Vertrag: Format, Kanal, SYNC-Faehigkeit,
 * Bypass. Damit ist der Signalweg nicht mehr anonym: ein Knoten im Graph weiss,
 * WELCHES Plugin er ist.
 *
 * Warum das noetig war: In C0 trugen alle 8 Kanaele einen `SourceNode` mit der
 * ID `source:channelN`. Aus dem Graph liess sich damit nicht ablesen, ob auf
 * Kanal 1 dropMONK oder stemMONK liegt - die Zuordnung lebte nur in der
 * Kanalbelegung daneben. Wer im Graph etwas debuggen wollte, musste zwei
 * Stellen zusammendenken.
 *
 * Vertragstreue:
 * - `mono`-Quellen (voice) werden im Kanalzug auf Stereo gezogen. Das passiert
 *   HIER und nicht spaeter, damit die Kanalzug-Kette immer 2 Kanaele sieht.
 * - SYNC ist ein Zustand des Knotens, kein Audio-Effekt: er beeinflusst, WANN
 *   der Knoten seinen Buffer liefert (siehe `sampleStartFrame`), nicht wie er
 *   klingt.
 * - Bypass ist wie bei den Inserts ein Crossfade auf den trockenen Weg. Bei
 *   einer Quelle ist "trocken" die Stille - ein umgangener Kanal darf nicht
 *   weiterklingen.
 */
import { BaseNode } from './basicNodes';
import { copyChannel } from '../PortBuffers';
import { CONTRACT_BY_ID } from '../../../plugins/pluginContract';
import type { IProcessingContext } from '../types';

export class PluginSourceNode extends BaseNode {
  /** Kanonische Plugin-ID - der Knoten weiss, wer er ist. */
  readonly pluginId: string;
  /** Kanalformat aus dem Vertrag. */
  readonly format: 'mono' | 'stereo';
  /** Darf dieses Plugin SYNC gegen Main (Vertrag)? */
  readonly syncCapable: boolean;

  /**
   * Der aktuelle Block der Quelle. Bei einer spielenden Quelle ist das der
   * Sample-Inhalt; eine stumme Quelle liefert Stille.
   */
  private buffer: Float32Array[] | null = null;
  /** SYNC-Zustand (UI2-P0-003). Default an laut Betreiber-Vorgabe. */
  private synced = true;
  /** Ist die Quelle aktiv (Play)? Eine gestoppte Quelle liefert Stille. */
  private playing = false;

  /**
   * Startversatz in Frames innerhalb des Blocks: bei SYNC wird der Ton auf die
   * naechste Zaehlzeit gelegt. 0 = sofort.
   */
  private sampleStartFrame = 0;

  constructor(pluginId: string, sampleRate = 48000) {
    const contract = CONTRACT_BY_ID[pluginId];
    super(`plugin:${pluginId}`, 'plugin-source', 0, 1);
    this.pluginId = pluginId;
    this.format = contract?.format ?? 'stereo';
    this.syncCapable = contract?.syncCapable ?? false;
    void sampleRate;
  }

  /** Setzt den Quellinhalt (Sample/Pattern). `null` = Stille. */
  setBuffer(buffer: Float32Array[] | null): void {
    this.buffer = buffer;
  }

  /** Play/Stop. Eine gestoppte Quelle gibt Stille aus. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /**
   * SYNC gegen Main (UI2-P0-003). Nur wo der Vertrag es erlaubt; sonst bleibt
   * der Aufruf wirkungslos - kein stilles Umschalten an einem Plugin, das es
   * laut Vertrag nicht kann.
   */
  setSynced(synced: boolean): boolean {
    if (!this.syncCapable) return false;
    this.synced = synced;
    return true;
  }

  isSynced(): boolean {
    return this.synced;
  }

  /**
   * Startversatz auf die Zaehlzeit setzen. Bei SYNC an und einem Versatz > 0
   * beginnt der Ton erst an diesem Frame innerhalb des Blocks; davor liegt
   * Stille. Genau das ist die Quantisierung - sample-genau, nicht per Timer.
   */
  setSampleStartFrame(frame: number): void {
    this.sampleStartFrame = Math.max(0, Math.floor(frame));
  }

  process(ctx: IProcessingContext): void {
    const len = ctx.bufferSize;

    // Nicht spielend oder keine Daten: Stille. Ein umgangener/stummer Kanal
    // darf NICHT weiterklingen.
    // RT-AUDIT-P0-002: fester Port-Puffer statt Pool/Literal pro Block.
    if (!this.playing || !this.buffer) {
      const silent = this.ensureOutput(2, len);
      silent[0].fill(0);
      silent[1].fill(0);
      this.outputs[0].buffer = silent;
      return;
    }

    if (this.format === 'mono') {
      // Mono-Quelle auf Stereo ziehen - der Kanalzug sieht immer 2 Kanaele.
      const src = this.buffer[0] ?? this.silence.get(len);
      const out = this.ensureOutput(2, len);
      copyChannel(out[0], src, len);
      copyChannel(out[1], src, len);
      this.applyStartOffset(out, len);
      this.outputs[0].buffer = out;
      return;
    }

    const out = this.ensureOutput(Math.max(2, this.buffer.length), len);
    for (let ch = 0; ch < out.length; ch++) {
      const src = this.buffer[ch] ?? this.buffer[this.buffer.length - 1];
      if (src) copyChannel(out[ch], src, len);
      else out[ch].fill(0);
    }
    this.applyStartOffset(out, len);
    this.outputs[0].buffer = out;
  }

  /** Setzt alles vor `sampleStartFrame` auf 0 (SYNC-Quantisierung). */
  private applyStartOffset(out: Float32Array[], len: number): void {
    const start = this.synced ? Math.min(this.sampleStartFrame, len) : 0;
    if (start <= 0) return;
    for (let ch = 0; ch < out.length; ch++) out[ch].fill(0, 0, start);
  }

  reset(): void {
    this.outputs[0].buffer = null;
    this.buffer = null;
    this.playing = false;
    this.sampleStartFrame = 0;
    // SYNC bleibt auf seinem Default (an) - reset() setzt keinen Nutzerzustand.
  }
}
