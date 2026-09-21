/**
 * dropMONK – Spektral-Kern (echte FFT-Bänder) · SSOT DSP-P2-003
 * ============================================================
 * Reiner, deterministischer DSP-Kern: aus einem echten FFT-Bin-Array
 * (Magnituden) werden Band-Energien (Bass/Mitten/Höhen), normalisierte Pegel
 * (0..1), Anteile am Gesamtspektrum und der Peak-Bin gerechnet.
 *
 * Warum: `DropContextAnalyzer.calculateEnergyFromChannels()` und
 * `MixerBridge.getEnergyLevel()` schätzten die Energie eines Mixes bisher NUR
 * aus den Kanal-Pegeln (gemittelte Fader). Ein leiser, brillanter
 * Percussion-Loop und ein dumpfer Bass-Loop mit gleichem Pegel galten damit als
 * gleich „energetisch" – obwohl der Typ-Kommentar des Analyzers „basierend auf
 * Levels + Frequencies" versprach.
 *
 * Eigenschaften (bewusst so):
 *  - keine Seiteneffekte, keine Netz-/Storage-/Plattform-Zugriffe,
 *  - deterministisch: gleiche Eingabe -> bitgleiches Ergebnis,
 *  - NaN-fest: leere/zu kurze/unbrauchbare Eingaben ergeben den definierten
 *    Null-Zustand statt NaN,
 *  - allokationsfrei im Hot Path, solange ein Ergebnisobjekt (`out`,
 *    siehe `createSpectrum()`) wiederverwendet wird. Ohne `out` wird genau ein
 *    Objekt angelegt.
 *
 * Skalen: Magnituden sind standardmäßig LINEAR (0..1 = Vollaussteuerung, 0 =
 * Stille). Ein AnalyserNode liefert dB – dafür `scale: 'db'` setzen; der Kern
 * rechnet dann je Bin `10 ** (db / 20)` (siehe spectrumTap.ts). Achtung in der
 * dB-Skala: 0 dB heißt VOLLAUSSTEUERUNG, Stille ist -Infinity bzw. ≤ -200; ein
 * in dB gelesener Puffer muss deshalb vollständig beschrieben sein (der
 * Analyser tut das, `createFrameBuffer` legt -Infinity vor).
 */

/** Frequenzbänder in Hz (untere Grenze inklusiv, obere exklusiv). */
export const DROP_BANDS: Record<'bass' | 'mid' | 'treble', readonly [number, number]> = {
  bass: [20, 160],
  mid: [160, 2000],
  treble: [2000, 16000],
};

/** Untere Pegelgrenze der 0..1-Normalisierung (dBFS). */
export const SPECTRUM_FLOOR_DB = -90;

/**
 * Ab welchem Verhältnis zum Mittel der drei Bänder ein Band als Schwerpunkt
 * gilt. Darunter ist der Mix breitbandig und `dominantBand` bleibt `'none'`:
 * Bei einem flachen Spektrum ist JEDE Bandwahl willkürlich (Bass-Bänder haben
 * wenige, breite Höhen-Bänder viele Bins), deshalb wird dann bewusst kein
 * Schwerpunkt behauptet.
 */
export const SPECTRUM_DOMINANCE_RATIO = 1.5;

/** Absoluter Nullpunkt für dB-Eingaben (darunter gilt als Stille). */
const DB_SILENCE = -200;

export type SpectrumBand = 'bass' | 'mid' | 'treble';

export interface SpectrumBandValues {
  bass: number;
  mid: number;
  treble: number;
}

/** Ein FFT-Frame, wie ihn ein Analyser liefert (Bin-Breite = sampleRate/fftSize). */
export interface SpectrumFrame {
  /** FFT-Bin-Magnituden (linear 0..1 oder dB – siehe `scale`). */
  magnitudes: Float32Array;
  /** Abtastrate in Hz. */
  sampleRate: number;
  /** Abstand zweier Bins in Hz (sampleRate / fftSize). */
  binWidthHz: number;
  /** Skala der Magnituden; Default `'linear'` (AnalyserNode liefert `'db'`). */
  scale?: 'linear' | 'db';
}

/** Ergebnis der Bandanalyse (wiederverwendbar, siehe `createSpectrum()`). */
export interface DropSpectrum {
  /** Normalisierter Pegel je Band (0..1, dB-Skala von floorDb..0 dBFS). */
  bass: number;
  mid: number;
  treble: number;
  /** Pegel über alle hörbaren Bänder (0..1) – der Wert, der als Energie dient. */
  overall: number;
  /** Mittlere Leistung je Bin (linear) – bandbreitenunabhängig vergleichbar. */
  energy: SpectrumBandValues;
  /** Anteil am Gesamtspektrum (0..1, Summe ≈ 1; bei Stille jeweils 0). */
  share: SpectrumBandValues;
  /** Schwerpunkt-Band (Energiedichte); `'none'` = breitbandig oder Stille. */
  dominantBand: SpectrumBand | 'none';
  /** Bin-Index des stärksten Bins (DC ausgenommen); -1 = kein hörbarer Peak. */
  peakBin: number;
  /** Frequenz des Peak-Bins in Hz (0, wenn kein Peak). */
  peakHz: number;
  /** Pegel des Peak-Bins in dBFS (mindestens `floorDb`). */
  peakDbfs: number;
  /** Zahl der gelesenen Bins (inkl. DC). */
  bins: number;
  /** Übernommene Abtastrate in Hz (0 = unbrauchbar). */
  sampleRate: number;
  /** Bin-Breite in Hz (0 = unbrauchbar). */
  binWidthHz: number;
}

export interface ComputeSpectrumOptions {
  sampleRate: number;
  /** Bin-Breite in Hz (sampleRate / fftSize). */
  binWidthHz: number;
  scale?: 'linear' | 'db';
  /** Untere Pegelgrenze der Normalisierung (dBFS, muss < 0 sein). */
  floorDb?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** dBFS -> lineare Magnitude (Werte unterhalb des Nullpunkts = 0). */
function dbToMagnitude(db: number): number {
  if (!Number.isFinite(db) || db <= DB_SILENCE) return 0;
  return 10 ** (db / 20);
}

/** Mittlere Leistung -> normierter Pegel 0..1 (monoton, NaN-fest). */
function levelFromPower(power: number, floorDb: number): number {
  if (!Number.isFinite(power) || power <= 0) return 0;
  const db = 10 * Math.log10(power);
  return clamp01((db - floorDb) / -floorDb);
}

/**
 * Legt ein wiederverwendbares Ergebnisobjekt im Null-Zustand an.
 * Wer `computeSpectrum` im Hot Path aufruft, übergibt dasselbe Objekt als
 * `out` – dann entsteht pro Frame keine neue Allokation.
 */
export function createSpectrum(): DropSpectrum {
  return {
    bass: 0,
    mid: 0,
    treble: 0,
    overall: 0,
    energy: { bass: 0, mid: 0, treble: 0 },
    share: { bass: 0, mid: 0, treble: 0 },
    dominantBand: 'none',
    peakBin: -1,
    peakHz: 0,
    peakDbfs: SPECTRUM_FLOOR_DB,
    bins: 0,
    sampleRate: 0,
    binWidthHz: 0,
  };
}

/**
 * Rechnet Band-Energien, normierte Pegel, Spektralanteile und den Peak-Bin aus
 * einem FFT-Bin-Array.
 *
 * Definitionen:
 *  - Leistung je Bin = magnitude²; `energy.<band>` = Mittelwert der Leistung
 *    über die Bins des Bandes (dadurch sind schmale und breite Bänder
 *    vergleichbar; ein voller Bass bei 21-Hz-Bins wird nicht durch die
 *    Bin-Anzahl der Höhen benachteiligt).
 *  - `share.<band>` = Summe der Leistung im Band / Summe über alle hörbaren
 *    Bins (echter Energieanteil, Summe ≈ 1). Achtung: Anteile folgen auch der
 *    Bandbreite (Bass 140 Hz, Höhen 14 kHz) – für Vergleiche zwischen Bändern
 *    ist `energy` die richtige Zahl.
 *  - `dominantBand` = Band mit der höchsten Energiedichte, aber nur bei
 *    klarem Vorsprung (`SPECTRUM_DOMINANCE_RATIO` gegen das Mittel der drei
 *    Bänder); sonst `'none'` (breitbandig).
 *  - Pegel = `10·log10(Energie)` auf `floorDb..0 dBFS` abgebildet und auf 0..1
 *    geklemmt.
 *
 * Der DC-Bin (Index 0) und alles außerhalb 20 Hz..16 kHz bleiben außen vor.
 * Leere, zu kurze (< 2 Bins) oder unbrauchbare Eingaben (sampleRate/binWidth
 * ≤ 0, nicht-finite Werte) ergeben den Null-Zustand: alle Pegel 0,
 * `peakBin = -1`, `dominantBand = 'none'` – nie NaN.
 */
export function computeSpectrum(
  magnitudes: ArrayLike<number> | null | undefined,
  options: ComputeSpectrumOptions,
  out: DropSpectrum = createSpectrum(),
): DropSpectrum {
  const bins = magnitudes && Number.isFinite(magnitudes.length) ? magnitudes.length : 0;
  const rawSampleRate = options?.sampleRate;
  const rawBinWidth = options?.binWidthHz;
  const sampleRate = Number.isFinite(rawSampleRate) && (rawSampleRate as number) > 0 ? (rawSampleRate as number) : 0;
  const binWidthHz = Number.isFinite(rawBinWidth) && (rawBinWidth as number) > 0 ? (rawBinWidth as number) : 0;
  const floorDb =
    Number.isFinite(options?.floorDb) && (options?.floorDb as number) < 0 ? (options!.floorDb as number) : SPECTRUM_FLOOR_DB;
  const scale = options?.scale === 'db' ? 'db' : 'linear';

  // Null-Zustand in das (ggf. wiederverwendete) Ergebnis schreiben.
  out.bass = 0;
  out.mid = 0;
  out.treble = 0;
  out.overall = 0;
  out.energy.bass = 0;
  out.energy.mid = 0;
  out.energy.treble = 0;
  out.share.bass = 0;
  out.share.mid = 0;
  out.share.treble = 0;
  out.dominantBand = 'none';
  out.peakBin = -1;
  out.peakHz = 0;
  out.peakDbfs = floorDb;
  out.bins = bins;
  out.sampleRate = sampleRate;
  out.binWidthHz = binWidthHz;

  // Es braucht mindestens einen Bin neben dem DC und eine nutzbare Bin-Breite.
  if (bins < 2 || binWidthHz <= 0 || sampleRate <= 0) return out;

  const [audibleLow, trebleHigh] = [DROP_BANDS.bass[0], DROP_BANDS.treble[1]];
  const bassHigh = DROP_BANDS.bass[1];
  const midHigh = DROP_BANDS.mid[1];

  let bassSum = 0;
  let midSum = 0;
  let trebleSum = 0;
  let bassCount = 0;
  let midCount = 0;
  let trebleCount = 0;
  let totalSum = 0;
  let totalCount = 0;
  let peakBin = -1;
  let peakMagnitude = 0;

  for (let i = 1; i < bins; i += 1) {
    const rawValue = magnitudes![i];
    const value = Number.isFinite(rawValue) ? (rawValue as number) : scale === 'db' ? DB_SILENCE : 0;
    const magnitude = scale === 'db' ? dbToMagnitude(value) : value > 0 ? value : 0;

    if (magnitude > peakMagnitude) {
      peakMagnitude = magnitude;
      peakBin = i;
    }

    const hz = i * binWidthHz;
    if (hz < audibleLow || hz >= trebleHigh) continue;

    const power = magnitude * magnitude;
    totalSum += power;
    totalCount += 1;
    if (hz < bassHigh) {
      bassSum += power;
      bassCount += 1;
    } else if (hz < midHigh) {
      midSum += power;
      midCount += 1;
    } else {
      trebleSum += power;
      trebleCount += 1;
    }
  }

  const bassEnergy = bassCount > 0 ? bassSum / bassCount : 0;
  const midEnergy = midCount > 0 ? midSum / midCount : 0;
  const trebleEnergy = trebleCount > 0 ? trebleSum / trebleCount : 0;
  const totalEnergy = totalCount > 0 ? totalSum / totalCount : 0;

  out.energy.bass = bassEnergy;
  out.energy.mid = midEnergy;
  out.energy.treble = trebleEnergy;

  out.bass = levelFromPower(bassEnergy, floorDb);
  out.mid = levelFromPower(midEnergy, floorDb);
  out.treble = levelFromPower(trebleEnergy, floorDb);
  out.overall = levelFromPower(totalEnergy, floorDb);

  if (totalSum > 0) {
    out.share.bass = bassSum / totalSum;
    out.share.mid = midSum / totalSum;
    out.share.treble = trebleSum / totalSum;
  }

  if (totalSum > 0) {
    // Schwerpunkt über die ENERGIE DICHTE (Leistung je Bin) – sonst gewinnt
    // immer das schmale Bass-Band allein wegen der Bin-Anzahl. Nur ab einem
    // klaren Vorsprung (`SPECTRUM_DOMINANCE_RATIO`) wird ein Band benannt;
    // Gleichstand (breitbandig) bleibt `'none'`, Tie-Break bass → mid → treble.
    const densityMean = (bassEnergy + midEnergy + trebleEnergy) / 3;
    const strongest = Math.max(bassEnergy, midEnergy, trebleEnergy);
    if (densityMean > 0 && strongest >= densityMean * SPECTRUM_DOMINANCE_RATIO) {
      if (bassEnergy === strongest) out.dominantBand = 'bass';
      else if (midEnergy === strongest) out.dominantBand = 'mid';
      else out.dominantBand = 'treble';
    }
  }

  if (peakBin >= 0 && peakMagnitude > 0) {
    out.peakBin = peakBin;
    out.peakHz = peakBin * binWidthHz;
    out.peakDbfs = Math.max(floorDb, 20 * Math.log10(peakMagnitude));
  }

  return out;
}
