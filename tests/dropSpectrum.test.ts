/**
 * dropMONK · Spektral-Kern (SSOT DSP-P2-003)
 * ==========================================
 * Belege für den REINEN DSP-Kern `src/core/drop/spectrum.ts`: echte
 * FFT-Bin-Arrays (synthetische Sinusse in Bass/Mitten/Höhen) müssen das
 * richtige Band als stärkstes ausweisen, flache Spektren dürfen keine
 * Ausreißer erzeugen, leere/zu kurze Eingaben einen definierten Null-Zustand
 * (nie NaN) liefern – und alles deterministisch.
 *
 * Die Erwartungswerte werden hier unabhängig aus der dokumentierten Formel
 * nachgerechnet (nicht aus dem Code übernommen), damit der Test eine echte
 * Gegenrechnung ist.
 */
import { describe, expect, it } from 'vitest';

import {
  DROP_BANDS,
  SPECTRUM_FLOOR_DB,
  computeSpectrum,
  createSpectrum,
  type ComputeSpectrumOptions,
  type DropSpectrum,
} from '../src/core/drop/spectrum';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 2048;
const BIN_WIDTH = SAMPLE_RATE / FFT_SIZE; // 23,4375 Hz
const BINS = FFT_SIZE / 2; // 1024

const options = (overrides: Partial<ComputeSpectrumOptions> = {}): ComputeSpectrumOptions => ({
  sampleRate: SAMPLE_RATE,
  binWidthHz: BIN_WIDTH,
  ...overrides,
});

/** Bin-Index, in dem eine Frequenz landet (wie bei einer echten FFT). */
const binOf = (hz: number): number => Math.round(hz / BIN_WIDTH);

/** Magnituden-Array mit EINEM Ton, sonst Stille. */
function toneMagnitudes(hz: number, amplitude = 1, bins = BINS): Float32Array {
  const magnitudes = new Float32Array(bins);
  magnitudes[binOf(hz)] = amplitude;
  return magnitudes;
}

/**
 * Magnituden-Array, in dem ganze Bänder mit einer Amplitude gefüllt sind.
 * Bass-Füllung trifft 6 Bins, Höhen-Füllung 597 – genau der Bandbreiten-
 * unterschied, den der Kern bandbreitenunabhängig behandeln muss.
 */
function bandMagnitudes(fill: { bass?: number; mid?: number; treble?: number }, bins = BINS): Float32Array {
  const magnitudes = new Float32Array(bins);
  for (let i = 1; i < bins; i += 1) {
    const hz = i * BIN_WIDTH;
    if (hz < DROP_BANDS.bass[0] || hz >= DROP_BANDS.treble[1]) continue;
    if (hz < DROP_BANDS.bass[1]) magnitudes[i] = fill.bass ?? 0;
    else if (hz < DROP_BANDS.mid[1]) magnitudes[i] = fill.mid ?? 0;
    else magnitudes[i] = fill.treble ?? 0;
  }
  return magnitudes;
}

/** Normierter Pegel nach der dokumentierten Formel (unabhängige Gegenrechnung). */
function expectedLevel(meanPower: number, floorDb = SPECTRUM_FLOOR_DB): number {
  if (meanPower <= 0) return 0;
  return Math.min(1, Math.max(0, (10 * Math.log10(meanPower) - floorDb) / -floorDb));
}

/** Zahl der Bins, die in ein Band fallen (DC-Bin bleibt außen vor). */
function bandBinCount(lo: number, hi: number, bins = BINS): number {
  let count = 0;
  for (let i = 1; i < bins; i += 1) {
    const hz = i * BIN_WIDTH;
    if (hz >= lo && hz < hi) count += 1;
  }
  return count;
}

/** Alle Zahlenfelder des Ergebnisses – für die NaN-/Endlichkeits-Prüfung. */
function numericValues(spectrum: DropSpectrum): number[] {
  return [
    spectrum.bass,
    spectrum.mid,
    spectrum.treble,
    spectrum.overall,
    spectrum.energy.bass,
    spectrum.energy.mid,
    spectrum.energy.treble,
    spectrum.share.bass,
    spectrum.share.mid,
    spectrum.share.treble,
    spectrum.peakBin,
    spectrum.peakHz,
    spectrum.peakDbfs,
    spectrum.bins,
    spectrum.sampleRate,
    spectrum.binWidthHz,
  ];
}

/** Synthetische Töne je Band (Frequenz -> binOf-Treffer liegt sicher im Band). */
const TONES = [
  { band: 'bass' as const, hz: 80, lo: DROP_BANDS.bass[0], hi: DROP_BANDS.bass[1] },
  { band: 'mid' as const, hz: 1000, lo: DROP_BANDS.mid[0], hi: DROP_BANDS.mid[1] },
  { band: 'treble' as const, hz: 8000, lo: DROP_BANDS.treble[0], hi: DROP_BANDS.treble[1] },
];

describe('dropMONK · Spektral-Kern (echte FFT-Bänder)', () => {
  describe('Sinus im Band -> richtiges Band ist das stärkste', () => {
    for (const tone of TONES) {
      it(`erkennt ${tone.hz} Hz als ${tone.band}`, () => {
        const spectrum = computeSpectrum(toneMagnitudes(tone.hz), options());

        expect(spectrum.dominantBand).toBe(tone.band);
        expect(spectrum.peakBin).toBe(binOf(tone.hz));
        expect(spectrum.peakHz).toBeCloseTo(binOf(tone.hz) * BIN_WIDTH, 6);
        expect(spectrum.peakDbfs).toBeCloseTo(0, 6); // Vollaussteuerung = 0 dBFS

        const levels = { bass: spectrum.bass, mid: spectrum.mid, treble: spectrum.treble };
        // Das Band mit dem Ton: Mittelwert der Bin-Leistung im Band.
        expect(levels[tone.band]).toBeCloseTo(expectedLevel(1 / bandBinCount(tone.lo, tone.hi)), 6);
        // Gegenprobe: die anderen Bänder sind exakt still.
        for (const other of ['bass', 'mid', 'treble'] as const) {
          if (other === tone.band) continue;
          expect(levels[other]).toBe(0);
          expect(spectrum.share[other]).toBe(0);
        }
        expect(spectrum.share[tone.band]).toBeCloseTo(1, 6);
        expect(spectrum.overall).toBeCloseTo(expectedLevel(1 / bandBinCount(20, 16000)), 6);
      });
    }

    it('ändert das Ergebnis, wenn derselbe Ton verschoben wird (Gegenprobe)', () => {
      const bass = computeSpectrum(toneMagnitudes(80), options());
      const treble = computeSpectrum(toneMagnitudes(8000), options());

      expect(bass.dominantBand).toBe('bass');
      expect(treble.dominantBand).toBe('treble');
      // Die Verschiebung darf NICHT spurlos bleiben: anderes Band, anderer Peak.
      expect(treble.bass).toBe(0);
      expect(bass.treble).toBe(0);
      expect(treble.peakBin).toBeGreaterThan(bass.peakBin);
      expect(bass.share.bass).toBeGreaterThan(treble.share.bass);
      expect(treble.share.treble).toBeGreaterThan(bass.share.treble);
    });

    it('ist monoton: lautere Amplitude -> höhere Bandenergie (Leistung ∝ Amplitude²)', () => {
      const quiet = computeSpectrum(toneMagnitudes(80, 0.25), options());
      const loud = computeSpectrum(toneMagnitudes(80, 0.5), options());

      expect(loud.bass).toBeGreaterThan(quiet.bass);
      expect(loud.energy.bass).toBeCloseTo(quiet.energy.bass * 4, 9);
      expect(loud.peakDbfs).toBeCloseTo(-6.0206, 3); // 20·log10(0,5)
    });
  });

  describe('Gleichverteilung -> keine Ausreißer', () => {
    it('meldet für ein flaches Spektrum in jedem Band dieselbe Energiedichte', () => {
      const flat = new Float32Array(BINS).fill(0.5);
      const spectrum = computeSpectrum(flat, options());

      // Gleiche Leistung je Bin => gleiche MITTLERE Leistung je Band (0,5² = 0,25).
      expect(spectrum.energy.bass).toBeCloseTo(0.25, 9);
      expect(spectrum.energy.mid).toBeCloseTo(0.25, 9);
      expect(spectrum.energy.treble).toBeCloseTo(0.25, 9);
      expect(spectrum.bass).toBeCloseTo(spectrum.mid, 9);
      expect(spectrum.mid).toBeCloseTo(spectrum.treble, 9);
      expect(spectrum.mid - spectrum.bass).toBeCloseTo(0, 9);
      expect(spectrum.treble - spectrum.mid).toBeCloseTo(0, 9);

      // Gleichstand wird NICHT willkürlich aufgelöst: ohne klaren Vorsprung
      // meldet der Kern 'none' (breitbandig) statt eines Schein-Schwerpunktes.
      expect(spectrum.dominantBand).toBe('none');

      // Anteile: echte Energieanteile, Summe 1. Sie folgen der BIN-ANZAHL des
      // Bandes (Bass ist schmal) – deshalb wird hier nur die Invariante geprüft,
      // nicht Gleichheit. Genau dafür gibt es `energy` (bandbreitenunabhängig).
      const shareSum = spectrum.share.bass + spectrum.share.mid + spectrum.share.treble;
      expect(shareSum).toBeCloseTo(1, 9);
      for (const share of [spectrum.share.bass, spectrum.share.mid, spectrum.share.treble]) {
        expect(share).toBeGreaterThan(0);
        expect(share).toBeLessThan(1);
      }
      expect(spectrum.share.treble).toBeGreaterThan(spectrum.share.bass);
      expect(spectrum.share.treble).toBeCloseTo(bandBinCount(2000, 16000) / bandBinCount(20, 16000), 9);

      // Kein Ausreißer, keine NaN.
      for (const value of numericValues(spectrum)) expect(Number.isFinite(value)).toBe(true);
      expect(spectrum.peakDbfs).toBeCloseTo(-6.0206, 3); // 20·log10(0,5)
    });

    it('benennt ein Schwerpunkt-Band nur bei klarem Vorsprung (sonst breitbandig)', () => {
      // Knappe Bass-Anhebung: Energiedichte 0,04 gegen 0,0324 – nur 1,15× das
      // Mittel der drei Bänder (SPECTRUM_DOMINANCE_RATIO verlangt 1,5×).
      const mild = computeSpectrum(bandMagnitudes({ bass: 0.2, mid: 0.18, treble: 0.18 }), options());
      expect(mild.energy.bass).toBeGreaterThan(mild.energy.mid);
      expect(mild.dominantBand).toBe('none');

      // Deutliche Bass-Anhebung: 0,09 gegen 0,0324 => 1,74× Mittel.
      const strong = computeSpectrum(bandMagnitudes({ bass: 0.3, mid: 0.18, treble: 0.18 }), options());
      expect(strong.dominantBand).toBe('bass');

      // Spiegelbild: nur die Höhen gefüllt -> 'treble' (nicht etwa Bass, weil
      // das Bass-Band weniger Bins hat).
      const bright = computeSpectrum(bandMagnitudes({ treble: 0.3 }), options());
      expect(bright.dominantBand).toBe('treble');
      expect(bright.energy.treble).toBeGreaterThan(bright.energy.bass);

      // Bandbreiten-Falle: gleicher Pegel in allen Bändern -> keine Aussage,
      // obwohl die ANTEILE wegen der Bin-Anzahl stark auseinanderliegen.
      const flatBands = computeSpectrum(bandMagnitudes({ bass: 0.3, mid: 0.3, treble: 0.3 }), options());
      expect(flatBands.energy.bass).toBeCloseTo(flatBands.energy.treble, 12);
      expect(flatBands.dominantBand).toBe('none');
      expect(flatBands.share.treble).toBeGreaterThan(flatBands.share.bass);
    });
  });

  describe('leere/zu kurze/unbrauchbare Eingabe -> definierter Null-Zustand (kein NaN)', () => {
    const unusable: Array<{ label: string; magnitudes: Float32Array | null; opts: ComputeSpectrumOptions }> = [
      { label: 'leeres Array', magnitudes: new Float32Array(0), opts: options() },
      { label: 'nur DC-Bin', magnitudes: new Float32Array(1), opts: options() },
      { label: 'null', magnitudes: null, opts: options() },
      { label: 'sampleRate 0', magnitudes: toneMagnitudes(80), opts: options({ sampleRate: 0 }) },
      { label: 'binWidthHz 0', magnitudes: toneMagnitudes(80), opts: options({ binWidthHz: 0 }) },
      { label: 'negative Bin-Breite', magnitudes: toneMagnitudes(80), opts: options({ binWidthHz: -1 }) },
      {
        label: 'durchgehend NaN',
        magnitudes: new Float32Array(BINS).fill(Number.NaN),
        opts: options(),
      },
    ];

    for (const { label, magnitudes, opts } of unusable) {
      it(`liefert für ${label} den Null-Zustand`, () => {
        const spectrum = computeSpectrum(magnitudes, opts);

        for (const value of numericValues(spectrum)) {
          expect(Number.isNaN(value), `${label}: NaN gefunden`).toBe(false);
          expect(Number.isFinite(value), `${label}: nicht-endlicher Wert gefunden`).toBe(true);
        }
        expect(spectrum.bass).toBe(0);
        expect(spectrum.mid).toBe(0);
        expect(spectrum.treble).toBe(0);
        expect(spectrum.overall).toBe(0);
        expect(spectrum.share.bass).toBe(0);
        expect(spectrum.share.mid).toBe(0);
        expect(spectrum.share.treble).toBe(0);
        expect(spectrum.dominantBand).toBe('none');
        expect(spectrum.peakBin).toBe(-1);
        expect(spectrum.peakHz).toBe(0);
        expect(spectrum.peakDbfs).toBe(SPECTRUM_FLOOR_DB);
      });
    }

    it('behandelt ein sehr kurzes, aber nutzbares Spektrum definiert', () => {
      // DC + genau ein Bin bei 23,4 Hz (Bass).
      const spectrum = computeSpectrum(new Float32Array([0, 1]), options());

      expect(spectrum.bins).toBe(2);
      expect(spectrum.peakBin).toBe(1);
      expect(spectrum.dominantBand).toBe('bass');
      expect(spectrum.share.bass).toBeCloseTo(1, 9);
      expect(spectrum.mid).toBe(0);
      expect(spectrum.treble).toBe(0);
    });

    it('wertet NaN-Bins als Stille und findet den echten Ton daneben', () => {
      const magnitudes = toneMagnitudes(1000);
      magnitudes[10] = Number.NaN;
      magnitudes[500] = Number.NaN;

      const spectrum = computeSpectrum(magnitudes, options());

      expect(spectrum.dominantBand).toBe('mid');
      expect(spectrum.peakBin).toBe(binOf(1000));
      for (const value of numericValues(spectrum)) expect(Number.isFinite(value)).toBe(true);
    });
  });

  describe('Determinismus und Allokations-Verhalten', () => {
    it('liefert zweimal dasselbe Ergebnis', () => {
      const magnitudes = toneMagnitudes(1000);

      const first = computeSpectrum(magnitudes, options());
      const second = computeSpectrum(magnitudes, options());

      expect(second).toEqual(first);
      expect({ ...second, energy: { ...second.energy }, share: { ...second.share } }).toEqual({
        ...first,
        energy: { ...first.energy },
        share: { ...first.share },
      });
    });

    it('schreibt in ein wiederverwendetes Ergebnisobjekt (keine Neuanlage im Hot Path)', () => {
      const reusable = createSpectrum();
      const magnitudes = toneMagnitudes(1000);

      const returned = computeSpectrum(magnitudes, options(), reusable);
      expect(returned).toBe(reusable);
      expect(reusable).toEqual(computeSpectrum(magnitudes, options()));

      // Zweiter Frame in DENSELBEN Puffer: alte Werte dürfen nicht überleben.
      const shifted = toneMagnitudes(8000);
      computeSpectrum(shifted, options(), reusable);
      expect(reusable.dominantBand).toBe('treble');
      expect(reusable.mid).toBe(0);
      expect(reusable.share.bass).toBe(0);
      expect(reusable).toEqual(computeSpectrum(shifted, options()));
    });

    it('verweigert keinen Aufruf ohne out-Objekt (ein Objekt pro Aufruf)', () => {
      const a = computeSpectrum(toneMagnitudes(80), options());
      const b = computeSpectrum(toneMagnitudes(80), options());
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('Skalen und Normalisierung', () => {
    it('liest dB-Magnituden (AnalyserNode) wie lineare Magnituden', () => {
      const linear = new Float32Array(BINS);
      linear[binOf(80)] = 0.1;
      // In der dB-Skala ist 0 dB VOLLAUSSTEUERUNG – Stille muss explizit
      // -Infinity/-200 sein (der Analyser beschreibt alle Bins).
      const decibel = new Float32Array(BINS).fill(-200);
      decibel[binOf(80)] = -20; // 20·log10(0,1)

      const fromLinear = computeSpectrum(linear, options());
      const fromDecibel = computeSpectrum(decibel, options({ scale: 'db' }));

      // Die dB-Umrechnung ist bis auf Float-Rundung identisch (10^(-20/20) ≈ 0,1).
      expect(fromDecibel.bass).toBeCloseTo(fromLinear.bass, 8);
      expect(fromDecibel.energy.bass).toBeCloseTo(fromLinear.energy.bass, 10);
      expect(fromDecibel.share.bass).toBeCloseTo(fromLinear.share.bass, 10);
      expect(fromDecibel.peakDbfs).toBeCloseTo(fromLinear.peakDbfs, 6);
      expect(fromDecibel.peakDbfs).toBeCloseTo(-20, 6);
      expect(fromDecibel.dominantBand).toBe('bass');
    });

    it('meldet dB-Stille (-200) als Stille statt als Restpegel', () => {
      const silence = new Float32Array(BINS).fill(-200);

      const spectrum = computeSpectrum(silence, options({ scale: 'db' }));

      expect(spectrum.dominantBand).toBe('none');
      expect(spectrum.overall).toBe(0);
      expect(spectrum.peakBin).toBe(-1);
      expect(spectrum.peakDbfs).toBe(SPECTRUM_FLOOR_DB);
      expect(Number.isFinite(spectrum.peakDbfs)).toBe(true);
    });

    it('normiert auf die konfigurierbare Pegelgrenze', () => {
      const magnitudes = toneMagnitudes(80, 0.1); // Bin-Leistung 0,01 = -20 dB

      const wide = computeSpectrum(magnitudes, options());
      const narrow = computeSpectrum(magnitudes, options({ floorDb: -30 }));

      expect(narrow.bass).toBeLessThan(wide.bass);
      expect(narrow.bass).toBeCloseTo(expectedLevel(0.01 / bandBinCount(20, 160), -30), 6);
      expect(wide.bass).toBeCloseTo(expectedLevel(0.01 / bandBinCount(20, 160)), 6);
    });

    it('hält alle Pegel im Bereich 0..1', () => {
      // Absurd laute Bins (Analyser-Boost) dürfen den Pegel nicht über 1 treiben.
      const hot = new Float32Array(BINS).fill(10);

      const spectrum = computeSpectrum(hot, options());

      for (const level of [spectrum.bass, spectrum.mid, spectrum.treble, spectrum.overall]) {
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(1);
      }
    });
  });
});
