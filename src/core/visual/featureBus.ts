/**
 * audioMONASTRY · VisualMONK – Audio-Feature-Bus
 * ==============================================
 * Liest einen Analyser-Tap am Master-Ausgang und liefert normalisierte
 * Features (bass/mid/treble/rms/onset/energy) für die Visualisierung.
 *
 * Die Bandzuordnung ist **rein** (testbar ohne WebAudio); der Bus kapselt nur
 * die Analyser-Aufrufe. Es wird NICHTS im Audio-Thread gerechnet – der Abgriff
 * ist ein reiner Fan-out (`audioEngine.createVisualAnalyser()`).
 */
import type { AudioFeatures } from './types';
import { clamp01 } from './audioReactive';

/** Frequenzbänder in Hz. */
export const BANDS = {
  bass: [20, 160],
  mid: [160, 2000],
  treble: [2000, 16000],
} as const;

export interface BandEnergies {
  bass: number;
  mid: number;
  treble: number;
}

/**
 * Mittlere Energie je Band aus `getByteFrequencyData` (0..255 je Bin).
 * `fftSize` bestimmt den Bin-Abstand (`sampleRate / fftSize`).
 */
export function bandEnergies(freq: Uint8Array, sampleRate: number, fftSize: number): BandEnergies {
  const bins = freq.length;
  if (bins === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(fftSize) || fftSize <= 0) {
    return { bass: 0, mid: 0, treble: 0 };
  }
  const hzPerBin = sampleRate / fftSize;
  const mean = (lo: number, hi: number): number => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < bins; i += 1) {
      const hz = i * hzPerBin;
      if (hz >= lo && hz < hi) {
        sum += freq[i];
        count += 1;
      }
    }
    return count === 0 ? 0 : sum / count / 255;
  };
  return {
    bass: clamp01(mean(BANDS.bass[0], BANDS.bass[1])),
    mid: clamp01(mean(BANDS.mid[0], BANDS.mid[1])),
    treble: clamp01(mean(BANDS.treble[0], BANDS.treble[1])),
  };
}

/** RMS aus `getFloatTimeDomainData` (-1..1), mit etwas Headroom auf 0..1. */
export function rmsFromTimeDomain(time: Float32Array): number {
  if (time.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < time.length; i += 1) sum += time[i] * time[i];
  return clamp01(Math.sqrt(sum / time.length) * 2);
}

/** Onset-Stärke aus dem Pegelanstieg (0 wenn fallend/gleich). */
export function detectOnset(rms: number, prevRms: number, gain = 2.5): number {
  return clamp01(Math.max(0, rms - prevRms) * gain);
}

export interface ComputeOptions {
  sampleRate: number;
  fftSize: number;
  prevRms?: number;
  onsetGain?: number;
  /**
   * Transport-Tempo in BPM. Der Wert wird NICHT aus dem Audiosignal geschätzt
   * (teuer + unzuverlässig), sondern vom V2-Transport übernommen. 0 = unbekannt.
   */
  bpm?: number;
}

/** Reine Feature-Berechnung aus den beiden Analyser-Puffern. */
export function computeFeatures(
  freq: Uint8Array,
  time: Float32Array,
  opts: ComputeOptions,
): AudioFeatures {
  const bands = bandEnergies(freq, opts.sampleRate, opts.fftSize);
  const rms = rmsFromTimeDomain(time);
  const onset = detectOnset(rms, opts.prevRms ?? 0, opts.onsetGain ?? 2.5);
  const energy = clamp01((bands.bass + bands.mid + bands.treble) / 3);
  const bpm = Number.isFinite(opts.bpm) && (opts.bpm ?? 0) > 0 ? Math.round(opts.bpm as number) : 0;
  return { ...bands, rms, onset, energy, bpm };
}

/**
 * Bus um einen AnalyserNode. `read()` puffert in wiederverwendete Arrays
 * (keine Allokation pro Frame).
 */
export class VisualFeatureBus {
  private readonly freq: Uint8Array;
  private readonly time: Float32Array;
  private prevRms = 0;

  constructor(
    private readonly analyser: AnalyserNode,
    private readonly context: { sampleRate: number } = analyser.context,
    /**
     * Liefert das aktuelle Transport-Tempo in BPM (0 = unbekannt/gestoppt).
     * Bewusst injiziert statt intern geschätzt: Das Tempo kommt sample-genau
     * aus dem V2-Transport und kostet hier keinen Rechenaufwand.
     */
    private readonly bpmProvider: () => number = () => 0,
  ) {
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Float32Array(analyser.fftSize);
  }

  /** Liest ein Feature-Set (einmal pro Frame aufrufen). */
  read(): AudioFeatures {
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.time);
    const features = computeFeatures(this.freq, this.time, {
      sampleRate: this.context.sampleRate,
      fftSize: this.analyser.fftSize,
      prevRms: this.prevRms,
      bpm: this.bpmProvider(),
    });
    this.prevRms = features.rms;
    return features;
  }

  /** Setzt die Onset-Historie zurück (z. B. nach Stop). */
  reset(): void {
    this.prevRms = 0;
  }
}
