// Beat Grid Model - serializable, versioned data structure
export interface BeatGridInfo {
  version: number;        // Model version
  sampleRate: number;     // Original sample rate
  bpm: number;            // Detected BPM
  firstBeatOffsetSamples: number;  // Offset of first beat from start
  beatsPerBar: number;    // Number of beats per bar (e.g., 4 for 4/4)
  confidence: number;     // Confidence 0..1
  tempoMarkers?: BeatMarker[];  // Optional: tempo changes over time
}

export interface BeatMarker {
  sample: number;       // Sample position of marker
  bpm: number;          // BPM at that position
}

/** Export for worker communication */
export interface BeatGridPayload {
  grid: BeatGridInfo;
  rawFluxPeaks?: number[];  // For debugging/analysis
}
