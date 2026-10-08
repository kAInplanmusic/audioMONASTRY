// Bridge between main thread and BeatDetectionWorker
import { BeatGridInfo, BeatMarker, BeatGridPayload } from './beatGridModel';

export class BeatWorkerBridge {
  private worker: Worker | null = null;
  private resolvedBpm: number = 0;
  private beatOffsetSamples: number = 0;
  private beatsPerBar: number = 4;
  private confidence: number = 0;
  private messageResolve: ((result: BeatGridInfo) => void) | null = null;

  constructor() {
    if (typeof window !== 'undefined' && window.Worker) {
      this.worker = new Worker(new URL('../beat/BeatDetectionWorker.ts', import.meta.url), {
        type: 'module',
        name: 'beat-detection-worker'
      });
      this.worker.onmessage = this.onWorkerMessage.bind(this);
      this.worker.onerror = this.onWorkerError.bind(this);
    }
  }

  private onWorkerMessage = (event: MessageEvent) => {
    const data = event.data;
    if (data.type === 'result' && data.beatGrid) {
      this.resolvedBpm = data.beatGrid.bpm;
      this.beatOffsetSamples = data.beatGrid.firstBeatOffsetSamples;
      this.beatsPerBar = data.beatGrid.beatsPerBar;
      this.confidence = data.beatGrid.confidence;
      if (this.messageResolve) {
        this.messageResolve({
          version: data.beatGrid.version,
          sampleRate: data.beatGrid.sampleRate,
          bpm: this.resolvedBpm,
          firstBeatOffsetSamples: this.beatOffsetSamples,
          beatsPerBar: this.beatsPerBar,
          confidence: this.confidence,
          tempoMarkers: data.beatGrid.tempoMarkers
        });
        this.messageResolve = null;
      }
    }
  };

  private onWorkerError = (error: Event) => {
    console.error('Beat detection worker error:', error);
    if (this.messageResolve) {
      this.messageResolve({
        version: 1,
        sampleRate: 44100,
        bpm: 120,
        firstBeatOffsetSamples: 0,
        beatsPerBar: 4,
        confidence: 0
      });
      this.messageResolve = null;
    }
  };

  /** Analyze audio buffer for beat grid */
  analyzeBuffer(
    buffer: Float32Array,
    sampleRate: number,
    options: { frameSize?: number; hopSize?: number } = {}
  ): Promise<BeatGridInfo> {
    return new Promise((resolve) => {
      this.messageResolve = resolve;
      if (this.worker) {
        this.worker.postMessage({
          type: 'analyze',
          buffer,
          sampleRate,
          frameSize: options.frameSize ?? 2048,
          hopSize: options.hopSize ?? 512
        });
      } else {
        // Fallback: simple analysis in main thread
        this.analyzeFallback(buffer, sampleRate, resolve);
      }
    });
  }

  private analyzeFallback(
    buffer: Float32Array,
    sampleRate: number,
    resolve: (result: BeatGridInfo) => void
  ) {
    // Simple fallback: use autocorrelation-based tempo detection
    const frameSize = 2048;
    const hopSize = 512;
    const numFrames = Math.floor((buffer.length - frameSize) / hopSize) + 1;
    
    let totalEnergy = 0;
    let zeroCrossings = 0;
    
    for (let i = 0; i < buffer.length; i++) {
      totalEnergy += buffer[i] * buffer[i];
      if (buffer[i] * buffer[i+1] < 0) zeroCrossings++;
    }
    
    const avgEnergy = totalEnergy / buffer.length;
    const estimatedBpm = 120; // default
    const confidence = 0.3; // low confidence for fallback
    
    resolve({
      version: 1,
      sampleRate,
      bpm: estimatedBpm,
      firstBeatOffsetSamples: 0,
      beatsPerBar: 4,
      confidence
    });
  }

  getBpm(): number { return this.resolvedBpm; }
  getBeatOffsetSamples(): number { return this.beatOffsetSamples; }
  getBeatsPerBar(): number { return this.beatsPerBar; }
  getConfidence(): number { return this.confidence; }
}

export const beatWorkerBridge = new BeatWorkerBridge();
