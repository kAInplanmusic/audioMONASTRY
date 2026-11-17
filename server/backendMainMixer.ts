import { BACKEND_MAIN_RATES, type BackendMainRate } from '../src/core/transport/backendMainProtocol';
import { BackendMainProcessors, type MainProcessorSnapshot } from './backendMainProcessors';

const MIN_SAMPLE = -8388608;
const MAX_SAMPLE = 8388607;
interface Segment { start: number; end: number; pcm: Buffer }
interface Track { sequence: number; segments: Segment[]; bytes: number }
/**
 * R16 §P3: numbers only. The waveform telemetry never carries audio frames; the
 * frontend must show "unknown" rather than fall back to a local meter reading.
 * R20: truePeakL/truePeakR now populated from limiter True-Peak detection (4x oversampling).
 */
export interface MainWaveform { frame: number; frames: number; sampleRate: number; peakL: number; peakR: number; rmsL: number; rmsR: number; clipped: number; truePeakL?: number; truePeakR?: number }
export interface MainMixResult { startFrame: number; frames: number; pcm: Buffer; clippedSamples: number; missingSamples: number; waveform: MainWaveform }
/** R20: True-Peak to linear amplitude conversion factor. */
const TP_LIN_FACTOR = Math.LN10 / 20;

/** Bounded, sample-aligned stereo timeline. Gaps are silence; overlapping input is rejected. */
export class BackendMainMixer {
  readonly sampleRate: BackendMainRate;
  readonly maxAheadFrames: number;
  readonly maxPacketFrames: number;
  readonly maxTracks = 16;
  frame = 0;
  private tracks = new Map<string, Track>();
  readonly processors: BackendMainProcessors;
  constructor(sampleRate: BackendMainRate = 96000, private readonly processorSnapshot?: () => MainProcessorSnapshot) {
    if (!BACKEND_MAIN_RATES.includes(sampleRate)) throw new Error('Unsupported sample rate');
    this.sampleRate = sampleRate;
    this.maxAheadFrames = sampleRate * 2;
    this.maxPacketFrames = Math.ceil(sampleRate / 4);
    this.processors = new BackendMainProcessors(sampleRate);
  }
  enqueue(trackId: string, sequence: number, startFrame: number, pcm: Uint8Array): void {
    const frames = pcm.byteLength / 6;
    if (!trackId || !Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(startFrame) || startFrame < this.frame || !Number.isInteger(frames) || frames < 1 || frames > this.maxPacketFrames || startFrame + frames > this.frame + this.maxAheadFrames) throw new Error('Invalid or out-of-window Main input');
    let track = this.tracks.get(trackId);
    if (!track) {
      if (this.tracks.size >= this.maxTracks) throw new Error('Main track limit');
      track = { sequence: -1, segments: [], bytes: 0 }; this.tracks.set(trackId, track);
    }
    if (sequence <= track.sequence || track.segments.some(s => startFrame < s.end && startFrame + frames > s.start) || track.bytes + pcm.byteLength > this.maxAheadFrames * 6 || track.segments.length >= 256) throw new Error('Duplicate, overlapping, or full Main input');
    track.sequence = sequence;
    track.segments.push({ start: startFrame, end: startFrame + frames, pcm: Buffer.from(pcm) });
    track.segments.sort((a, b) => a.start - b.start);
    track.bytes += pcm.byteLength;
  }
  /** Disconnect retains queued audio; callers may discard explicitly when authorization changes. */
  removeTrack(trackId: string): void { this.tracks.delete(trackId); }
  /** Free disconnected track slots only after their queued samples have played. */
  pruneDrainedTracks(active: ReadonlySet<string>): void {
    for (const [id, track] of this.tracks) if (!active.has(id) && track.segments.length === 0) this.tracks.delete(id);
  }
  mix(frames: number): MainMixResult {
    if (!Number.isInteger(frames) || frames < 1 || frames > this.maxPacketFrames) throw new Error('Invalid mix size');
    const startFrame = this.frame, end = startFrame + frames;
    const sources = new Map<string, Float32Array>();
    let covered = 0;
    for (const [id, track] of this.tracks) {
      const aligned = new Float32Array(frames * 2);
      sources.set(id, aligned);
      for (const segment of track.segments) {
        const from = Math.max(startFrame, segment.start), to = Math.min(end, segment.end);
        for (let f = from; f < to; f++) {
          const src = (f - segment.start) * 6, dest = (f - startFrame) * 2;
          aligned[dest] = segment.pcm.readIntLE(src, 3) / 8388608;
          aligned[dest + 1] = segment.pcm.readIntLE(src + 3, 3) / 8388608;
        }
        covered += Math.max(0, to - from) * 2;
      }
      track.segments = track.segments.filter(s => { if (s.end <= end) { track.bytes -= s.pcm.length; return false; } return true; });
    }
    const sum = this.processors.process(sources, this.processorSnapshot?.() ?? {}, frames);
    let peakL = 0, peakR = 0, sumL = 0, sumR = 0;
    const pcm = Buffer.allocUnsafe(frames * 6); let clippedSamples = 0;
    for (let i = 0; i < sum.length; i++) {
      const sample = sum[i] * 8388608;
      if (!Number.isFinite(sample)) throw new Error('Non-finite Main processor output');
      const rounded = Math.round(sample);
      const value = Math.max(MIN_SAMPLE, Math.min(MAX_SAMPLE, rounded));
      if (value !== rounded) clippedSamples++;
      const clean = value / 8388608;
      if ((i & 1) === 0) { const a = clean < 0 ? -clean : clean; if (a > peakL) peakL = a; sumL += clean * clean; }
      else { const a = clean < 0 ? -clean : clean; if (a > peakR) a > peakR && (peakR = a); sumR += clean * clean; }
      pcm.writeIntLE(value, i * 3, 3);
    }
    // R20: Extract True-Peak from limiter report (4x oversampled)
    const limiterReport = this.processors.lastReport.limiter;
    const truePeakDb = limiterReport?.truePeakDb;
    // Convert dB to linear amplitude for frontend display
    // True-Peak is the max of both channels' oversampled peaks
    const truePeakLin = truePeakDb && truePeakDb > -140 ? Math.exp(truePeakDb * TP_LIN_FACTOR) : (peakL > peakR ? peakL : peakR);
    const waveform: MainWaveform = {
      frame: startFrame, frames, sampleRate: this.sampleRate,
      peakL, peakR, rmsL: Math.sqrt(sumL / frames), rmsR: Math.sqrt(sumR / frames), clipped: clippedSamples,
      // R20: True-Peak from 4x oversampling detector
      truePeakL: truePeakDb !== undefined ? truePeakLin : undefined,
      truePeakR: truePeakDb !== undefined ? truePeakLin : undefined
    };
    this.frame = end;
    return { startFrame, frames, pcm, clippedSamples, missingSamples: this.tracks.size * frames * 2 - covered, waveform };
  }
}