import { describe, expect, it } from 'vitest';
import {
  ENVELOPE,
  NOTE_SECONDS,
  RENDER_SAMPLE_RATE,
  renderPresetSamples,
  renderPresetWav,
} from '../src/audio/sampleAudioRender';

/**
 * AI-P1-003 P4: Der Preset-Renderer speist den Audio-Embedding-Indexer. Er muss
 * exakt den Hörproben-Pfad der App spiegeln (`previewSynthesizedSample`) – sonst
 * indiziert der Indexer Klänge, die die App nie spielt.
 */
const EXPECTED_FRAMES = Math.ceil((NOTE_SECONDS + ENVELOPE.release) * RENDER_SAMPLE_RATE);

function readHeader(wav: Buffer) {
  return {
    riff: wav.toString('ascii', 0, 4),
    wave: wav.toString('ascii', 8, 12),
    fmt: wav.toString('ascii', 12, 16),
    data: wav.toString('ascii', 36, 40),
    channels: wav.readUInt16LE(22),
    sampleRate: wav.readUInt32LE(24),
    bits: wav.readUInt16LE(34),
    dataBytes: wav.readUInt32LE(40),
  };
}

/** Nulldurchgänge -> Grundfrequenz (billiger als FFT, reicht für einen Sinus). */
function zeroCrossingFrequency(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) crossings++;
  }
  return (crossings / 2) / (samples.length / RENDER_SAMPLE_RATE);
}

describe('renderPresetWav (Preset -> Audio für den Embedding-Indexer)', () => {
  it('schreibt ein gültiges 48-kHz-Mono-16-bit-WAV der App-Länge', () => {
    const wav = renderPresetWav({ frequency: 440, decay: 0.3, oscillatorType: 'sine' });
    const h = readHeader(wav);
    expect([h.riff, h.wave, h.fmt, h.data]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(h.channels).toBe(1);
    expect(h.sampleRate).toBe(RENDER_SAMPLE_RATE);
    expect(h.bits).toBe(16);
    expect(h.dataBytes).toBe(EXPECTED_FRAMES * 2);
    expect(wav.length).toBe(44 + EXPECTED_FRAMES * 2);
  });

  it('erzeugt hörbaren Inhalt (nicht still) und ist deterministisch', () => {
    const params = { frequency: 55, decay: 0.4, oscillatorType: 'sine' };
    const wav = renderPresetWav(params);
    const samples = renderPresetSamples(params);
    const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.5);
    // Gleiche Parameter -> identische Bytes (kein Zufall, keine Zeitabhängigkeit).
    expect(renderPresetWav(params).equals(wav)).toBe(true);
  });

  it('trifft die Grundfrequenz und spiegelt die App-Limits (Default 220 Hz)', () => {
    expect(zeroCrossingFrequency(renderPresetSamples({ frequency: 440, oscillatorType: 'sine' })))
      .toBeCloseTo(440, -1);
    // `params.frequency ?? 220` wie in previewSynthesizedSample.
    const fallback = renderPresetSamples({ oscillatorType: 'sine' });
    expect(zeroCrossingFrequency(fallback)).toBeCloseTo(220, -1);
  });

  it('fällt bei unbekanntem Oszillatortyp auf sine zurück (App-Verhalten)', () => {
    const unknown = renderPresetWav({ frequency: 300, oscillatorType: 'noise' });
    const sine = renderPresetWav({ frequency: 300, oscillatorType: 'sine' });
    expect(unknown.equals(sine)).toBe(true);
  });

  it('erzeugt für alle vier erlaubten Wellenformen unterschiedliches Audio', () => {
    const types = ['sine', 'triangle', 'square', 'sawtooth'];
    const rendered = types.map((t) => renderPresetWav({ frequency: 220, oscillatorType: t }).toString('base64'));
    expect(new Set(rendered).size).toBe(types.length);
  });
});
