/**
 * dropMONK · Spektral-Verdrahtung (SSOT DSP-P2-003)
 * =================================================
 * Belegt, dass der pure DSP-Kern (spectrum.ts) wirklich ANGEBUNDEN ist:
 *
 *   AnalyserNode (Fake, dB)  ->  readAnalyserFrame()  ->  Adapter-Frame
 *     -> MixerBridge.getSpectrum()/getEnergyState()   ->  DropContextAnalyzer
 *     -> analyzeDropAudio() (Feature-Profil, unveränderter Vertrag)
 *
 * Und dass der PEGEL-Weg unverändert bleibt, wenn kein Analyser existiert
 * (Headless/Tests/Plugin OFF/kein Audio). Alles ohne AudioContext.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MixerBridge,
  computeSpectrum,
  createFrameBuffer,
  createSpectrum,
  readAnalyserFrame,
  setDropAudioAdapter,
  type AnalyserLike,
  type DropAudioAdapter,
  type DropMixerChannelSnapshot,
  type DropSpectrum,
  type SpectrumFrame,
} from '../src/core/drop';
import { DropContextAnalyzer } from '../src/core/drop/DropContextAnalyzer';
import { analyzeDropAudio, deriveDropSuggestions } from '../src/core/drop/DropAudioAnalyzer';
import type { DropAnalysisRaw } from '../src/core/drop/DropAudioAnalyzer';
import { DROP_BANDS } from '../src/core/drop/spectrum';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 2048;
const BIN_WIDTH = SAMPLE_RATE / FFT_SIZE; // 23,4375 Hz
const BINS = FFT_SIZE / 2;

/** Analyser-Attrappe: liefert dB-Werte wie `getFloatFrequencyData`. */
function fakeAnalyser(
  values: Float32Array,
  opts: { sampleRate?: number | null; throws?: boolean } = {},
): AnalyserLike & { reads: number } {
  const analyser = {
    reads: 0,
    frequencyBinCount: values.length,
    fftSize: values.length * 2,
    context: opts.sampleRate === null ? null : { sampleRate: opts.sampleRate ?? SAMPLE_RATE },
    getFloatFrequencyData(target: Float32Array): void {
      if (opts.throws) throw new Error('Analyser nicht verfügbar');
      for (let i = 0; i < target.length; i += 1) target[i] = values[i];
      analyser.reads += 1;
    },
  };
  return analyser;
}

/** dB-Spektrum mit einem Ton (sonst Stille). */
function dbToneValues(hz: number, levelDb = -6, bins = BINS): Float32Array {
  const values = new Float32Array(bins).fill(-200);
  values[Math.round(hz / BIN_WIDTH)] = levelDb;
  return values;
}

const asFrame = (magnitudes: Float32Array): SpectrumFrame => ({
  magnitudes,
  sampleRate: SAMPLE_RATE,
  binWidthHz: BIN_WIDTH,
  scale: 'linear',
});

/** Frame mit EINEM Ton (sonst Stille). */
function toneFrame(hz: number, amplitude = 1): SpectrumFrame {
  const magnitudes = new Float32Array(BINS);
  magnitudes[Math.round(hz / BIN_WIDTH)] = amplitude;
  return asFrame(magnitudes);
}

/** Frame, in dem ganze Bänder mit einer Amplitude gefüllt sind. */
function bandFrame(fill: { bass?: number; mid?: number; treble?: number }): SpectrumFrame {
  const magnitudes = new Float32Array(BINS);
  for (let i = 1; i < BINS; i += 1) {
    const hz = i * BIN_WIDTH;
    if (hz < DROP_BANDS.bass[0] || hz >= DROP_BANDS.treble[1]) continue;
    if (hz < DROP_BANDS.bass[1]) magnitudes[i] = fill.bass ?? 0;
    else if (hz < DROP_BANDS.mid[1]) magnitudes[i] = fill.mid ?? 0;
    else magnitudes[i] = fill.treble ?? 0;
  }
  return asFrame(magnitudes);
}

/** Bandanalyse eines Frames (das, was `MixerBridge` intern tut). */
const spectrumOf = (frame: SpectrumFrame): DropSpectrum =>
  computeSpectrum(frame.magnitudes, { sampleRate: frame.sampleRate, binWidthHz: frame.binWidthHz, scale: frame.scale });

const channels: DropMixerChannelSnapshot[] = [
  { id: 'channel1', label: 'KICK', level: 0.8, pan: 0, muted: false, soloed: false },
  { id: 'channel2', label: 'HAT', level: 0.4, pan: 0, muted: false, soloed: false },
];

/** Adapter mit festen Kanal-Pegeln; `readSpectrumFrame` ist optional. */
function adapter(options: { frame?: SpectrumFrame | null; throws?: boolean; muted?: boolean } = {}): DropAudioAdapter {
  const base: DropAudioAdapter = {
    getChannels: () => channels.map((c) => ({ ...c, muted: options.muted ?? c.muted })),
    setChannelLevel: () => {},
    setChannelPan: () => {},
    setChannelMute: () => {},
    setPluginParameter: () => {},
    getBpm: () => 128,
    getActivePluginIds: () => ['synthesizer'],
  };
  if (options.frame === undefined && !options.throws) return base; // Adapter wie heute: kein Analyser
  return {
    ...base,
    readSpectrumFrame: () => {
      if (options.throws) throw new Error('Analyser kaputt');
      return options.frame ?? null;
    },
  };
}

const levelEnergy = Math.min(1, ((0.8 + 0.4) / 2) * 1.2); // 0,72 – der Pegel-Weg

beforeEach(() => {
  setDropAudioAdapter(null);
});

describe('dropMONK · Spektral-Verdrahtung', () => {
  describe('readAnalyserFrame: Analyser -> Frame-Vertrag', () => {
    it('liest dB-Bins und rechnet die Bin-Breite aus sampleRate/fftSize', () => {
      const analyser = fakeAnalyser(dbToneValues(80));
      const buffer = createFrameBuffer(analyser);

      const frame = readAnalyserFrame(analyser, buffer, SAMPLE_RATE);

      expect(frame).not.toBeNull();
      expect(frame?.scale).toBe('db');
      expect(frame?.magnitudes).toBe(buffer); // kein zweiter Puffer (Hot Path)
      expect(frame?.sampleRate).toBe(SAMPLE_RATE);
      expect(frame?.binWidthHz).toBeCloseTo(BIN_WIDTH, 9);
      expect(analyser.reads).toBe(1);
      // Der Datenpfad ist echt: der Bin des Tons trägt den dB-Wert …
      expect(buffer[Math.round(80 / BIN_WIDTH)]).toBe(-6);
      // … und der Kern findet daraus das Bass-Band.
      expect(spectrumOf(frame!).dominantBand).toBe('bass');
    });

    it('fällt auf die übergebene Rate zurück, wenn der Kontext keine hat', () => {
      const analyser = fakeAnalyser(dbToneValues(80), { sampleRate: null });

      const frame = readAnalyserFrame(analyser, createFrameBuffer(analyser), 44100);

      expect(frame?.sampleRate).toBe(44100);
    });

    it('meldet null statt Fake-Daten, wenn kein Analyser/Puffer passt', () => {
      const analyser = fakeAnalyser(dbToneValues(80));

      expect(readAnalyserFrame(null, createFrameBuffer(analyser))).toBeNull();
      expect(readAnalyserFrame(analyser, null)).toBeNull();
      // Falsche Puffergröße: lieber null als ein halb gefülltes Spektrum.
      expect(readAnalyserFrame(analyser, new Float32Array(8))).toBeNull();
      // Analyser ohne Bins.
      expect(readAnalyserFrame({ ...analyser, frequencyBinCount: 0, fftSize: 0 }, new Float32Array(0))).toBeNull();
    });

    it('übersteht einen werfenden Analyser (Pegel-Weg statt Absturz)', () => {
      const analyser = fakeAnalyser(dbToneValues(80), { throws: true });

      expect(readAnalyserFrame(analyser, createFrameBuffer(analyser))).toBeNull();
    });

    it('liest einen nicht gefüllten dB-Puffer als Stille, nicht als Vollaussteuerung', () => {
      const mute: AnalyserLike = {
        frequencyBinCount: BINS,
        fftSize: FFT_SIZE,
        context: { sampleRate: SAMPLE_RATE },
        getFloatFrequencyData: () => {}, // schreibt nichts
      };
      const buffer = createFrameBuffer(mute);
      // 0 wäre in dB Vollaussteuerung (0 dBFS) – Vorbelegung ist -Infinity.
      expect(buffer[0]).toBe(Number.NEGATIVE_INFINITY);

      const spectrum = spectrumOf(readAnalyserFrame(mute, buffer, SAMPLE_RATE)!);

      expect(spectrum.dominantBand).toBe('none');
      expect(spectrum.overall).toBe(0);
      expect(spectrum.peakBin).toBe(-1);
      expect(Number.isFinite(spectrum.peakDbfs)).toBe(true);
    });
  });

  describe('MixerBridge: Spektrum bevorzugt, Pegel bleibt Fallback', () => {
    it('liefert ohne Analyser den bisherigen Pegel-Weg', () => {
      setDropAudioAdapter(adapter());
      const bridge = new MixerBridge();

      expect(bridge.getSpectrum()).toBeNull();
      const state = bridge.getEnergyState();
      expect(state.source).toBe('levels');
      expect(state.spectrum).toBeNull();
      expect(state.energy).toBeCloseTo(levelEnergy, 9);
      expect(state.energy).toBeCloseTo(bridge.getEnergyLevel(), 9);
    });

    it('rechnet bei vorhandenem Frame echte FFT-Bänder', () => {
      setDropAudioAdapter(adapter({ frame: toneFrame(80) }));
      const bridge = new MixerBridge();

      const spectrum = bridge.getSpectrum();

      expect(spectrum).not.toBeNull();
      expect(spectrum?.dominantBand).toBe('bass');
      expect(spectrum?.peakHz).toBeCloseTo(Math.round(80 / BIN_WIDTH) * BIN_WIDTH, 6);
      expect(spectrum?.mid).toBe(0);
      const state = bridge.getEnergyState();
      expect(state.source).toBe('spectrum');
      expect(state.energy).toBeCloseTo(spectrum!.overall, 9);
      // Die Herkunft ist belegt: hier ist die Energie NICHT der Pegel-Wert.
      expect(state.energy).not.toBeCloseTo(levelEnergy, 3);
    });

    it('meldet null statt stiller Null-Energie, wenn der Frame unbrauchbar ist', () => {
      const broken: SpectrumFrame = {
        magnitudes: new Float32Array(BINS).fill(1),
        sampleRate: 0,
        binWidthHz: 0,
        scale: 'linear',
      };
      setDropAudioAdapter(adapter({ frame: broken }));
      const bridge = new MixerBridge();

      expect(bridge.getSpectrum()).toBeNull();
      expect(bridge.getEnergyState().source).toBe('levels');
      expect(bridge.getEnergyState().energy).toBeCloseTo(levelEnergy, 9);
    });

    it('fällt bei werfendem Analyser auf den Pegel-Weg zurück', () => {
      setDropAudioAdapter(adapter({ throws: true }));
      const bridge = new MixerBridge();

      expect(bridge.getSpectrum()).toBeNull();
      expect(bridge.getEnergyState().energy).toBeCloseTo(levelEnergy, 9);
    });

    it('behält den Vertrag von getEnergyLevel(): stummgeschaltete Kanäle bleiben 0', () => {
      setDropAudioAdapter(adapter({ muted: true }));
      const bridge = new MixerBridge();

      expect(bridge.getEnergyLevel()).toBe(0);
      expect(bridge.getEnergyState().source).toBe('levels');
      expect(bridge.getEnergyState().energy).toBe(0);
    });

    it('unterscheidet gleiche Pegel mit unterschiedlichen Spektren (SSOT-Kernpunkt)', () => {
      const bridge = new MixerBridge();

      // Dumpfer Bass-Loop: nur die tiefen Bänder tragen Energie.
      setDropAudioAdapter(adapter({ frame: bandFrame({ bass: 0.2 }) }));
      const dullState = bridge.getEnergyState();
      const dullLevels = bridge.getEnergyLevel();

      // Heller, breitbandiger Percussion-Loop: dieselben Fader, mehr Spektralenergie.
      setDropAudioAdapter(adapter({ frame: bandFrame({ bass: 0.2, mid: 0.2, treble: 0.2 }) }));
      const brightState = bridge.getEnergyState();
      const brightLevels = bridge.getEnergyLevel();

      // Die Fader sind identisch, der Pegel-Weg sieht KEINEN Unterschied ...
      expect(dullLevels).toBeCloseTo(brightLevels, 12);
      expect(dullLevels).toBeCloseTo(levelEnergy, 9);
      // ... die FFT-Energie und der Schwerpunkt schon.
      expect(dullState.source).toBe('spectrum');
      expect(brightState.source).toBe('spectrum');
      expect(brightState.energy).toBeGreaterThan(dullState.energy);
      expect(dullState.energy).not.toBeCloseTo(brightState.energy, 3);
      expect(dullState.spectrum?.dominantBand).toBe('bass');
      expect(brightState.spectrum?.dominantBand).toBe('none'); // breitbandig
      expect(dullState.spectrum?.share.bass).toBeCloseTo(1, 6);
      expect(brightState.spectrum?.share.treble).toBeGreaterThan(dullState.spectrum?.share.treble ?? 1);
    });

    it('liefert ohne out je Aufruf ein frisches Ergebnis (kein Nachleben)', () => {
      const bridge = new MixerBridge();

      setDropAudioAdapter(adapter({ frame: bandFrame({ bass: 0.2 }) }));
      const dull = bridge.getEnergyState();
      setDropAudioAdapter(adapter({ frame: bandFrame({ bass: 0.2, mid: 0.2, treble: 0.2 }) }));
      const bright = bridge.getEnergyState();

      expect(dull.spectrum).not.toBe(bright.spectrum);
      expect(dull.spectrum?.dominantBand).toBe('bass'); // bleibt der alte Frame
      expect(bright.spectrum?.dominantBand).toBe('none');

      // Hot Path mit eigenem out: EIN Objekt, keine Neuanlage.
      const reusable = createSpectrum();
      expect(bridge.getSpectrum(reusable)).toBe(reusable);
      expect(reusable.dominantBand).toBe('none');
    });
  });

  describe('DropContextAnalyzer: ein Feature-Vertrag (Pegel + Bänder)', () => {
    const contextChannels = [{ id: 'channel1', level: 0.5, isMuted: false }];

    it('bleibt ohne Spektrum exakt beim Pegel-Weg', () => {
      const analyzer = new DropContextAnalyzer();

      const context = analyzer.analyzeCurrentMix(128, ['synth'], contextChannels);

      expect(context.currentEnergy).toBe(0.5);
      expect(context.energySource).toBe('levels');
      expect(context.spectrum).toBeNull();
    });

    it('zieht die Energie aus dem Spektrum, wenn eines vorliegt', () => {
      const analyzer = new DropContextAnalyzer();
      const bass = spectrumOf(bandFrame({ bass: 0.3 }));
      const treble = spectrumOf(bandFrame({ treble: 0.3 }));

      const bassContext = analyzer.analyzeCurrentMix(128, ['synth'], contextChannels, undefined, undefined, '4/4', bass);
      const trebleContext = analyzer.analyzeCurrentMix(128, ['synth'], contextChannels, undefined, undefined, '4/4', treble);

      expect(bassContext.energySource).toBe('spectrum');
      expect(bassContext.currentEnergy).toBeCloseTo(bass.overall, 9);
      expect(bassContext.spectrum).toBe(bass);
      expect(bassContext.spectrum?.dominantBand).toBe('bass');
      // Gleiche Kanäle, anderes Spektrum -> andere Energie und anderer Schwerpunkt.
      expect(trebleContext.energySource).toBe('spectrum');
      expect(trebleContext.currentEnergy).toBeGreaterThan(bassContext.currentEnergy);
      expect(trebleContext.currentEnergy).not.toBeCloseTo(bassContext.currentEnergy, 3);
      expect(trebleContext.spectrum?.dominantBand).toBe('treble');
    });

    it('lässt eine ausdrücklich durchgereichte Energie gewinnen (Vertrag von vorher)', () => {
      const analyzer = new DropContextAnalyzer();
      const spectrum = spectrumOf(bandFrame({ bass: 0.3 }));

      const context = analyzer.analyzeCurrentMix(128, ['synth'], contextChannels, 0.9, undefined, '4/4', spectrum);

      expect(context.currentEnergy).toBe(0.9);
      expect(context.energySource).toBe('provided');
    });
  });

  describe('DropAudioAnalyzer: Profil nutzt das Spektrum, Vertrag bleibt', () => {
    const baseRaw = (): DropAnalysisRaw => ({
      fileName: 'loop.wav',
      durationSeconds: 4,
      dsp: { bpm: 140, key: 'F minor', loudnessLufs: -9.4, peakDbfs: -1.2, transientStrength: 0.5 },
    });

    it('bleibt ohne Spektrum beim bisherigen Lautheits-Proxy', () => {
      const features = analyzeDropAudio(baseRaw());

      expect(features.energy).toBeCloseTo((-9.4 + 24) / 18, 2); // 0,81
      expect(features.energySource).toBe('levels');
      expect(features.spectrum).toBeUndefined();
      expect(features.estimated.energy).toBe(true);
    });

    it('bricht den bestehenden Profil-Vertrag nicht', () => {
      const features = analyzeDropAudio(baseRaw());

      expect(Object.keys(features).sort()).toEqual(
        [
          'bpm',
          'danceability',
          'durationSeconds',
          'energy',
          'energySource',
          'estimated',
          'fileName',
          'genreAffinity',
          'instrument',
          'key',
          'loudnessLufs',
          'peakDbfs',
          'spectrum',
          'topLabel',
          'transient',
          'type',
          'vocal',
        ].sort(),
      );
    });

    it('nimmt die Energie aus den Bändern samt Peak, wenn ein Spektrum vorliegt', () => {
      const spectrum = spectrumOf(toneFrame(60, 0.3)); // Ton bei 70,3 Hz, -10,5 dBFS
      const raw = baseRaw();
      raw.dsp.spectrum = spectrum;

      const features = analyzeDropAudio(raw);

      expect(features.energySource).toBe('spectrum');
      expect(features.energy).toBeCloseTo(spectrum.overall, 2);
      expect(features.spectrum?.dominantBand).toBe('bass');
      expect(features.spectrum?.peakHz).toBeCloseTo(70.3, 1);
      expect(features.spectrum?.peakDbfs).toBeCloseTo(-10.5, 1); // 20·log10(0,3)
      // Transparenz für den Nutzer.
      const notes = deriveDropSuggestions(features, { tempo: 140 }).filter((s) => s.kind === 'note');
      expect(notes.some((n) => n.reason.includes('echter FFT'))).toBe(true);
      expect(notes.some((n) => n.reason.includes('Peak'))).toBe(true);
    });

    it('unterscheidet gleiche DSP-Werte mit unterschiedlichem Spektrum', () => {
      const dullRaw = baseRaw();
      dullRaw.dsp.spectrum = spectrumOf(bandFrame({ bass: 0.3 }));
      const brightRaw = baseRaw();
      brightRaw.dsp.spectrum = spectrumOf(bandFrame({ treble: 0.3 }));

      const dull = analyzeDropAudio(dullRaw);
      const bright = analyzeDropAudio(brightRaw);

      expect(dull.energySource).toBe('spectrum');
      expect(bright.energySource).toBe('spectrum');
      expect(bright.energy).toBeGreaterThan(dull.energy);
      expect(bright.energy).not.toBeCloseTo(dull.energy, 2);
      expect(dull.spectrum?.dominantBand).toBe('bass');
      expect(bright.spectrum?.dominantBand).toBe('treble');
    });

    it('lässt ein Embedding-Modell weiter gewinnen', () => {
      const raw = baseRaw();
      raw.dsp.spectrum = spectrumOf(bandFrame({ bass: 0.3 }));
      raw.embeddings = { energy: 0.82, danceability: 0.76 };

      const features = analyzeDropAudio(raw);

      expect(features.energy).toBe(0.82);
      expect(features.energySource).toBe('embedding');
      expect(features.estimated.energy).toBe(false);
    });

    it('kopiert das Spektrum (kein Nachleben des wiederverwendeten Objekts)', () => {
      const spectrum = spectrumOf(toneFrame(60, 0.3)); // der Hot-Path-Puffer der Bridge
      const raw = baseRaw();
      raw.dsp.spectrum = spectrum;

      const features = analyzeDropAudio(raw);
      // Der Puffer wird für den nächsten Frame überschrieben …
      computeSpectrum(toneFrame(9000, 0.3).magnitudes, { sampleRate: SAMPLE_RATE, binWidthHz: BIN_WIDTH }, spectrum);

      // … das Profil bleibt trotzdem beim Bass.
      expect(features.spectrum?.dominantBand).toBe('bass');
      expect(features.spectrum?.peakHz).toBeCloseTo(70.3, 1);
      expect(spectrum.dominantBand).toBe('treble');
    });
  });

  describe('Gesamtkette: AnalyserNode -> Bridge -> Kontext -> Profil', () => {
    it('führt einen echten dB-Frame ohne Browser durch die ganze Kette', () => {
      const analyser = fakeAnalyser(dbToneValues(60, -6));
      const frame = readAnalyserFrame(analyser, createFrameBuffer(analyser), SAMPLE_RATE);
      expect(frame).not.toBeNull();

      setDropAudioAdapter(adapter({ frame }));
      const bridge = new MixerBridge();
      const state = bridge.getEnergyState();
      expect(state.source).toBe('spectrum');
      expect(state.spectrum?.dominantBand).toBe('bass');

      const analyzer = new DropContextAnalyzer();
      const context = analyzer.analyzeCurrentMix(
        128,
        bridge.getCurrentMixerState().map((c) => c.id),
        bridge.getCurrentMixerState().map((c) => ({ id: c.id, level: c.level, isMuted: c.muted })),
        undefined,
        undefined,
        '4/4',
        state.spectrum,
      );
      expect(context.energySource).toBe('spectrum');
      expect(context.currentEnergy).toBeCloseTo(state.spectrum!.overall, 9);

      const features = analyzeDropAudio({
        fileName: 'bb.mp3',
        durationSeconds: 3.2,
        dsp: {
          bpm: 124,
          key: 'D minor',
          loudnessLufs: -12,
          peakDbfs: -2,
          transientStrength: 0.4,
          spectrum: state.spectrum,
        },
      });
      expect(features.energySource).toBe('spectrum');
      expect(features.spectrum?.dominantBand).toBe('bass');
      expect(features.energy).toBeCloseTo(state.spectrum!.overall, 2);
      expect(Number.isFinite(features.energy)).toBe(true);
    });

    it('bleibt ohne AudioContext vollständig im Pegel-Weg (Headless)', () => {
      setDropAudioAdapter(adapter()); // Adapter wie heute: kein Analyser
      const bridge = new MixerBridge();

      const state = bridge.getEnergyState();
      expect(state.source).toBe('levels');
      expect(state.spectrum).toBeNull();

      const analyzer = new DropContextAnalyzer();
      const context = analyzer.analyzeCurrentMix(128, [], [{ id: 'channel1', level: 0.8, isMuted: false }], state.energy);
      expect(context.currentEnergy).toBeCloseTo(levelEnergy, 9);

      const features = analyzeDropAudio({
        fileName: 'x.wav',
        durationSeconds: 1,
        dsp: { bpm: 120, key: 'A minor', loudnessLufs: -9.4, peakDbfs: -1, transientStrength: 0.2 },
      });
      expect(features.energySource).toBe('levels');
      expect(features.spectrum).toBeUndefined();
      expect(features.energy).toBeCloseTo((-9.4 + 24) / 18, 2);
    });
  });
});
