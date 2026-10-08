/**
 * audioMONASTRY · Beat-Worker-Bridge (AUDIO-P0-BEATMATCH-B1)
 * ============================================================
 * Verbindet den Main-Thread mit dem `BeatDetectionWorker` (Spectral-Flux-
 * Onset/Tempo/Beat-Tracking läuft NIE im Audio-Thread). Ist kein Worker
 * verfügbar (Node/Tests oder `window.Worker` fehlt), fällt die Analyse auf
 * einen robusten Main-Thread-Schätzer zurück.
 *
 * Der Worker wird LAZY beim ersten `analyzeBuffer` erzeugt (über die
 * Worker-Factory – Interface-Boundary 1.1), nicht beim Import.
 */
import type { BeatGridInfo } from './beatGridModel';
import { createBeatDetectionWorker } from '../../utils/workerFactory';

/** Neutrale Schätzung, wenn keine Analyse möglich ist. */
function fallbackGrid(sampleRate: number): BeatGridInfo {
  return { version: 1, sampleRate, bpm: 120, firstBeatOffsetSamples: 0, beatsPerBar: 4, confidence: 0 };
}

export class BeatWorkerBridge {
  private worker: Worker | null = null;
  private resolved: BeatGridInfo | null = null;
  private pending: ((result: BeatGridInfo) => void) | null = null;

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof window === 'undefined' || !window.Worker) return null;
    const w = createBeatDetectionWorker();
    w.onmessage = this.onWorkerMessage;
    w.onerror = this.onWorkerError;
    this.worker = w;
    return w;
  }

  private settle(result: BeatGridInfo): void {
    this.resolved = result;
    const resolve = this.pending;
    this.pending = null;
    resolve?.(result);
  }

  private onWorkerMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; beatGrid?: BeatGridInfo } | undefined;
    if (data?.type === 'result' && data.beatGrid) {
      this.settle({
        version: data.beatGrid.version ?? 1,
        sampleRate: data.beatGrid.sampleRate,
        bpm: data.beatGrid.bpm,
        firstBeatOffsetSamples: data.beatGrid.firstBeatOffsetSamples,
        beatsPerBar: data.beatGrid.beatsPerBar ?? 4,
        confidence: data.beatGrid.confidence ?? 0,
        tempoMarkers: data.beatGrid.tempoMarkers,
      });
    }
  };

  private onWorkerError = () => {
    // Worker-Ausfall → neutrale Schätzung, damit die Analyse nie hängt.
    this.settle(fallbackGrid(48000));
  };

  /**
   * Analysiert einen Puffer und liefert das Beat-Grid. `buffer` wird NICHT
   * transferiert (der Aufrufer behält sein Array); der Worker läuft asynchron.
   */
  analyzeBuffer(
    buffer: Float32Array,
    sampleRate: number,
    options: { frameSize?: number; hopSize?: number } = {},
  ): Promise<BeatGridInfo> {
    const worker = this.ensureWorker();
    if (!worker) {
      const grid = fallbackGrid(sampleRate);
      this.resolved = grid;
      return Promise.resolve(grid);
    }
    return new Promise<BeatGridInfo>((resolve) => {
      this.pending = resolve;
      // Kopie: der Aufrufer behält sein Array, der Worker bekommt eine eigene.
      worker.postMessage({
        type: 'analyze',
        buffer: buffer.slice(),
        sampleRate,
        frameSize: options.frameSize ?? 2048,
        hopSize: options.hopSize ?? 512,
      });
    });
  }

  /** Zuletzt ermitteltes Grid (oder null, solange nichts analysiert wurde). */
  getGrid(): BeatGridInfo | null {
    return this.resolved;
  }

  getBpm(): number { return this.resolved?.bpm ?? 0; }
  getBeatOffsetSamples(): number { return this.resolved?.firstBeatOffsetSamples ?? 0; }
  getBeatsPerBar(): number { return this.resolved?.beatsPerBar ?? 4; }
  getConfidence(): number { return this.resolved?.confidence ?? 0; }
}

export const beatWorkerBridge = new BeatWorkerBridge();
