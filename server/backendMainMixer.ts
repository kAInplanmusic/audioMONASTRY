import { BACKEND_MAIN_RATES, type BackendMainRate } from '../src/core/transport/backendMainProtocol';

const MIN_SAMPLE = -8388608;
const MAX_SAMPLE = 8388607;
interface Segment { start: number; end: number; pcm: Buffer }
interface Track { sequence: number; segments: Segment[]; bytes: number }
export interface MainMixResult { startFrame: number; frames: number; pcm: Buffer; clippedSamples: number; missingSamples: number }

/** Bounded, sample-aligned stereo timeline. Gaps are silence; overlapping input is rejected. */
export class BackendMainMixer {
  readonly sampleRate: BackendMainRate;
  readonly maxAheadFrames: number;
  readonly maxPacketFrames: number;
  readonly maxTracks = 4;
  frame = 0;
  private tracks = new Map<string, Track>();
  constructor(sampleRate: BackendMainRate = 96000) {
    if (!BACKEND_MAIN_RATES.includes(sampleRate)) throw new Error('Unsupported sample rate');
    this.sampleRate = sampleRate;
    this.maxAheadFrames = sampleRate * 2;
    this.maxPacketFrames = Math.ceil(sampleRate / 4);
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
    const sum = new Int32Array(frames * 2);
    let covered = 0;
    for (const track of this.tracks.values()) {
      for (const segment of track.segments) {
        const from = Math.max(startFrame, segment.start), to = Math.min(end, segment.end);
        for (let f = from; f < to; f++) {
          const src = (f - segment.start) * 6, dest = (f - startFrame) * 2;
          sum[dest] += segment.pcm.readIntLE(src, 3); sum[dest + 1] += segment.pcm.readIntLE(src + 3, 3);
        }
        covered += Math.max(0, to - from) * 2;
      }
      track.segments = track.segments.filter(s => { if (s.end <= end) { track.bytes -= s.pcm.length; return false; } return true; });
    }
    const pcm = Buffer.allocUnsafe(frames * 6); let clippedSamples = 0;
    for (let i = 0; i < sum.length; i++) {
      const value = Math.max(MIN_SAMPLE, Math.min(MAX_SAMPLE, sum[i]));
      if (value !== sum[i]) clippedSamples++;
      pcm.writeIntLE(value, i * 3, 3);
    }
    this.frame = end;
    return { startFrame, frames, pcm, clippedSamples, missingSamples: this.tracks.size * frames * 2 - covered };
  }
}
