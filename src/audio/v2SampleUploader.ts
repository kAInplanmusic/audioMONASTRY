/**
 * audioMONASTRY · V2-Sample-Uploader (RT-AUDIT-P1-010)
 * ====================================================
 * Bringt dekodierte Samples (AudioBuffer bzw. planare Float32Arrays) in den
 * Sample-Pool des V2-Sinks – EINMAL pro Sample und Prozessor, nicht pro
 * Pad-Schlag. Vorher schickte `audioEngine.triggerEvent()` bei jedem Schlag das
 * komplette Sample per strukturiertem Klonen an den Audio-Thread.
 *
 * Ablauf je Aufruf (Main-Thread):
 *   1. Sample-ID aus der Objekt-Identität (WeakMap: AudioBuffer bzw. linkes
 *      Array → ID). Gleiches Objekt = gleiche ID, Tracks teilen sich ein Sample.
 *   2. Kennt der AKTUELLE Prozessor die ID nicht (erstes Laden, neuer Knoten nach
 *      Neuaufbau, aus dem Pool verdrängt): Kanäle in NEUE Arrays kopieren
 *      (`copyFromChannel`), `prepare` anwenden, per Transfer laden.
 *   3. `assignSample` – sendet nur, wenn sich die Zuordnung des Kanals ändert.
 * Unverändertes Sample → keine einzige Port-Nachricht.
 *
 * Einfügepunkt für RT-AUDIT-P1-009 (Resampling): `prepare` läuft genau einmal
 * pro Ladevorgang auf den frischen Kopien, VOR `loadSample`. Die Kopien gehören
 * dem Uploader und dürfen dort in-place oder durch neue Arrays ersetzt werden.
 *
 * Annahme: dekodierte Samples werden nach dem Laden nicht mehr in-place
 * verändert (AudioBuffer aus decodeAudioData). Wer Daten ändert, übergibt ein
 * neues Objekt.
 */
import { copyAudioBufferChannels, type V2LiveSink } from '../core/audio/backends/V2LiveSink';
import type { TrackType } from '../types';

/** Ein zum Laden vorbereitetes Sample (Arrays gehören dem Uploader). */
export interface V2PreparedSample {
  left: Float32Array;
  right: Float32Array | null;
  sourceRate: number;
}

/** Vorbereitungsschritt vor `loadSample` (z. B. Resampling, RT-AUDIT-P1-009). */
export type V2SamplePrepare = (sample: V2PreparedSample) => V2PreparedSample;

export interface V2SampleUploaderDeps {
  getSink(): V2LiveSink;
  /** Optional: Vorbereitung vor dem Laden (Default: unverändert). */
  prepare?: V2SamplePrepare;
}

export class V2SampleUploader {
  private readonly ids = new WeakMap<object, string>();
  private serial = 0;

  constructor(private readonly deps: V2SampleUploaderDeps) {}

  /** AudioBuffer → V2-Kanal. Sendet Sample-Daten nur, wenn der Prozessor sie noch nicht hat. */
  bridgeAudioBuffer(track: TrackType, buffer: AudioBuffer): boolean {
    if (!buffer || buffer.numberOfChannels === 0 || buffer.length === 0) return false;
    return this.bridge(track, buffer, () => {
      const { left, right } = copyAudioBufferChannels(buffer);
      return { left, right, sourceRate: buffer.sampleRate };
    });
  }

  /**
   * Planare Samples → V2-Kanal. Schlüssel ist das `left`-Array; der Aufrufer
   * behält seine Arrays (es werden Kopien übertragen).
   */
  bridgeDecoded(track: TrackType, left: Float32Array, right: Float32Array | null | undefined, sourceRate: number): boolean {
    if (!left || left.length === 0) return false;
    return this.bridge(track, left, () => ({
      left: left.slice(),
      right: right && right.length > 0 ? right.slice() : null,
      sourceRate,
    }));
  }

  private bridge(track: TrackType, key: object, materialize: () => V2PreparedSample): boolean {
    const sink = this.deps.getSink();
    if (!sink.isConnected) return false;
    const id = this.idFor(key);
    if (!sink.hasPooledSample(id)) {
      const raw = materialize();
      const sample = this.deps.prepare ? this.deps.prepare(raw) : raw;
      if (!sink.loadSample(id, sample.left, sample.right, sample.sourceRate)) return false;
    }
    return sink.assignSample(track, id);
  }

  private idFor(key: object): string {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = `smp:${++this.serial}`;
      this.ids.set(key, id);
    }
    return id;
  }
}
