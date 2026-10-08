// Beat detection using Spectral Flux in a Web Worker
// Handles onset detection, tempo detection, and beat tracking

let workerGlobal: Worker | null = null;

// Data model for beat information
export interface BeatGridInfo {
  version: number;
  sampleRate: number;
  bpm: number;
  firstBeatOffsetSamples: number;
  beatsPerBar: number;
  confidence: number;
  tempoMarkers?: BeatMarker[];
}

export interface BeatMarker {
  sample: number;
  bpm: number;
}

/** Compute Spectral Flux (onset detection) */
function computeSpectralFlux(
  buffer: Float32Array,
  sampleRate: number,
  frameSize: number = 2048,
  hopSize: number = 512
): Float32Array {
  const numFrames = Math.floor((buffer.length - frameSize) / hopSize) + 1;
  const flux = new Float32Array(numFrames);
  
  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    const frame = buffer.subarray(start, start + frameSize);
    
    // Compute FFT magnitudes
    const magnitudes1 = new Float32Array(frameSize / 2 + 1);
    const magnitudes2 = new Float32Array(frameSize / 2 + 1);
    
    // Simple real FFT approximation using DFT (for illustration)
    for (let k = 0; k <= frameSize / 2; k++) {
      let re1 = 0, im1 = 0;
      let re2 = 0, im2 = 0;
      for (let n = 0; n < frameSize; n++) {
        const phi1 = (2 * Math.PI * k * n) / frameSize;
        const phi2 = (2 * Math.PI * k * (frameSize - n)) / frameSize;
        re1 += frame[n] * Math.cos(phi1);
        im1 += frame[n] * Math.sin(phi1);
        re2 += frame[n] * Math.cos(phi2);
        im2 += frame[n] * Math.sin(phi2);
      }
      magnitudes1[k] = Math.hypot(re1, im1);
      magnitudes2[k] = Math.hypot(re2, im2);
    }
    
    // Compute flux (sum of positive differences)
    let fluxVal = 0;
    for (let k = 1; k <= frameSize / 2; k++) {
      const diff = magnitudes1[k] - magnitudes2[k];
      if (diff > 0) fluxVal += diff;
    }
    flux[f] = fluxVal;
  }
  
  return flux;
}

/** Apply envelope (half-wave rectification + smoothing) */
function applyEnvelope(flux: Float32Array, attackMs: number = 5, releaseMs: number = 50, sampleRate: number): Float32Array {
  const envelope = new Float32Array(flux.length);
  const attackSamples = attackMs * sampleRate / 1000;
  const releaseSamples = releaseMs * sampleRate / 1000;
  let state = 'release';
  let envVal = 0;
  
  for (let i = 0; i < flux.length; i++) {
    const sample = Math.max(0, flux[i]); // half-wave rectification
    
    if (state === 'attack') {
      envVal += (sample - envVal) * (1.0 / (attackSamples || 1));
      if (envVal >= sample) state = 'release';
    } else if (state === 'release') {
      envVal -= (envVal * 0.01); // slow release
      if (envVal < 0.01 && sample < 0.1) state = 'release';
      else if (sample > envVal) { envVal = sample; state = 'attack'; }
    } else {
      // detect attack
      if (sample > 0.1 && i > 0 && flux[i-1] < 0.1) {
        state = 'attack';
      }
      envVal = sample;
    }
    envelope[i] = envVal;
  }
  
  return envelope;
}

/** Detect tempo using autocorrelation */
function detectTempoAutocorrelation(
  fluxEnvelope: Float32Array,
  sampleRate: number,
  minBpm: number = 60,
  maxBpm: number = 200
): { bpm: number; confidence: number } {
  // We need to convert the flux envelope to a function we can autocorrelate
  // For simplicity, use the raw flux times and find peaks
  
  // Find peaks in the flux envelope
  const peaks: number[] = [];
  for (let i = 1; i < fluxEnvelope.length - 1; i++) {
    if (fluxEnvelope[i] > fluxEnvelope[i-1] && fluxEnvelope[i] > fluxEnvelope[i+1] && fluxEnvelope[i] > 0.3 * Math.max(...fluxEnvelope)) {
      peaks.push(i);
    }
  }
  
  if (peaks.length < 2) return { bpm: minBpm, confidence: 0 };
  
  // Compute differences between peaks (in frames)
  const differences: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    differences.push(peaks[i] - peaks[i-1]);
  }
  
  // Estimate tempo from average difference
  const avgDiff = differences.reduce((a, b) => a + b, 0) / differences.length;
  const bpm = 60 * sampleRate / (avgDiff * (2048 / 512)); // convert frame diff to BPM
  
  // Refine: check if the tempo is in the valid range
  let confidence = 0.5;
  let finalBpm = minBpm;
  if (bpm >= minBpm && bpm <= maxBpm) {
    finalBpm = bpm;
    confidence = Math.min(1.0, 0.5 + 0.5 * Math.exp(-Math.abs(bpm - 120) / 20));
  }
  
  return { bpm: finalBpm, confidence };
}

/** Beat tracking via dynamic programming (simplified Ellis-style) */
function beatTracking(
  fluxEnvelope: Float32Array,
  bpm: number,
  sampleRate: number,
  beatsPerBar: number = 4
): { firstBeatOffsetSamples: number; beatsPerBar: number; confidence: number } {
  const beatDurationMs = 60.0 / bpm * 1000;
  const beatDurationSamples = beatDurationMs * sampleRate / 1000;
  const barDurationSamples = beatDurationSamples * beatsPerBar;
  
  // Find strong beats (peaks in flux envelope above threshold)
  const threshold = 0.5 * Math.max(...fluxEnvelope);
  const strongBeatIndices: number[] = [];
  
  for (let i = 0; i < fluxEnvelope.length; i++) {
    if (fluxEnvelope[i] > threshold) {
      strongBeatIndices.push(i);
    }
  }
  
  if (strongBeatIndices.length === 0) {
    return { firstBeatOffsetSamples: 0, beatsPerBar, confidence: 0 };
  }
  
  // Simple beat tracking: assign beats to strong positions, quantize to beat grid
  const beatTimes: number[] = [];
  for (const idx of strongBeatIndices) {
    const timeSamples = idx;
    // Check if this is close to a multiple of the beat duration
    const nBeats = Math.round(timeSamples / beatDurationSamples);
    const quantizedPos = nBeats * beatDurationSamples;
    const error = Math.abs(timeSamples - quantizedPos);
    if (error < beatDurationSamples * 0.3) { // within 30% of a beat
      beatTimes.push(quantizedPos);
    }
  }
  
  // If we have enough beats, determine the first beat offset
  let firstBeatOffsetSamples = 0;
  let confidence = 0.5;
  
  if (beatTimes.length >= 4) {
    // Sort and find the most common inter-beat interval
    const intervals: number[] = [];
    for (let i = 1; i < beatTimes.length; i++) {
      intervals.push(beatTimes[i] - beatTimes[i-1]);
    }
    
    if (intervals.length > 0) {
      // Find the most common interval mode
      const intervalCounts: Map<number, number> = new Map();
      for (const interval of intervals) {
        intervalCounts.set(interval, (intervalCounts.get(interval) || 0) + 1);
      }
      
      let maxCount = 0;
      let mostCommonInterval = intervals[0];
      for (const [interval, count] of intervalCounts) {
        if (count > maxCount) {
          maxCount = count;
          mostCommonInterval = interval;
        }
      }
      
      // Use the most common interval as the beat duration
      firstBeatOffsetSamples = Math.round(beatTimes[0] % mostCommonInterval);
      confidence = Math.min(1.0, intervalCounts.size / 8);
    }
  }
  
  return { firstBeatOffsetSamples, beatsPerBar, confidence };
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  
  if (data.type === 'analyze') {
    const { buffer, sampleRate } = data;
    
    // Compute spectral flux
    const frameSize = data.frameSize || 2048;
    const hopSize = data.hopSize || 512;
    const flux = computeSpectralFlux(buffer, sampleRate, frameSize, hopSize);
    
    // Apply envelope
    const envelope = applyEnvelope(flux, 5, 50, sampleRate);
    
    // Detect tempo
    const tempoResult = detectTempoAutocorrelation(envelope, sampleRate, 60, 200);
    
    // Beat tracking
    const beatResult = beatTracking(envelope, tempoResult.bpm, sampleRate, 4);
    
    // Send result back
    self.postMessage({
      type: 'result',
      beatGrid: {
        version: 1,
        sampleRate,
        bpm: tempoResult.bpm,
        firstBeatOffsetSamples: beatResult.firstBeatOffsetSamples,
        beatsPerBar: beatResult.beatsPerBar,
        confidence: tempoResult.confidence * beatResult.confidence,
        tempoMarkers: undefined // could be computed for variable tempo tracks
      }
    });
  }
};
