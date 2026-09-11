import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '../src/utils/random';
import { makeNoiseBuffer, renderDrumBuffer, renderDrumBufferMath } from '../src/audio/drumRender';
import type { DrumSoundPreset } from '../src/data/drumKits';

// ---------------------------------------------------------------------------
// AUDIO-P1-002: Das Drum-Rendering liegt jetzt in `src/audio/drumRender.ts`.
// Geprüft wird die Wirkung (deterministisch, nicht still, klingt ab) mit einem
// Fake-Kontext – ohne echten AudioContext.
// ---------------------------------------------------------------------------

function fakeBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (ch: number) => data[ch] ?? data[0],
  } as unknown as AudioBuffer;
}

const fakeCtx = { createBuffer: fakeBuffer } as unknown as BaseAudioContext;

const kick: DrumSoundPreset = { id: 'k', name: 'Kick', type: 'kick', freq: 50, freqStart: 160, freqEnd: 50, decay: 0.3 };
const hat: DrumSoundPreset = { id: 'h', name: 'Hat', type: 'hat', decay: 0.08, noiseFilter: 8000 };

const rms = (buf: AudioBuffer, from: number, to: number): number => {
  const d = buf.getChannelData(0);
  let sum = 0;
  for (let i = from; i < to; i++) sum += d[i] * d[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};

describe('drumRender – makeNoiseBuffer', () => {
  it('füllt einen Buffer mit deterministischem Rauschen in −1..1', () => {
    const a = makeNoiseBuffer(fakeCtx, 0.01, 48000, createSeededRandom(42));
    const b = makeNoiseBuffer(fakeCtx, 0.01, 48000, createSeededRandom(42));
    expect(a.length).toBe(Math.max(64, Math.ceil(48000 * 0.01)));
    const da = a.getChannelData(0);
    const db = b.getChannelData(0);
    expect(Array.from(da.slice(0, 16))).toEqual(Array.from(db.slice(0, 16)));
    expect(Array.from(da).every((v) => v >= -1 && v <= 1)).toBe(true);
  });
});

describe('drumRender – Math-Fallback', () => {
  it('rendert einen Kick deterministisch, nicht still und abklingend', () => {
    const sr = 48000;
    const frames = 4800;
    const createBuffer = (len: number, rate: number) => fakeBuffer(1, len, rate);
    const first = renderDrumBufferMath(kick, sr, frames, createBuffer, createSeededRandom(7));
    const second = renderDrumBufferMath(kick, sr, frames, createBuffer, createSeededRandom(7));
    expect(first).not.toBeNull();
    expect(Array.from(first!.getChannelData(0).slice(0, 256))).toEqual(Array.from(second!.getChannelData(0).slice(0, 256)));
    // Anschlag laut, Ausklang leiser (Hüllkurve wirkt).
    expect(rms(first!, 0, 480)).toBeGreaterThan(rms(first!, frames - 480, frames) * 5);
    expect(Array.from(first!.getChannelData(0)).every((v) => Number.isFinite(v))).toBe(true);
  });

  it('liefert null, wenn keine Buffer-Factory vorhanden ist', () => {
    expect(renderDrumBufferMath(kick, 48000, 512, () => null, createSeededRandom(1))).toBeNull();
  });
});

describe('drumRender – renderDrumBuffer', () => {
  it('fällt ohne OfflineAudioContext sauber auf den Math-Renderer zurück', async () => {
    const buffer = await renderDrumBuffer(hat, 48000, {
      random: createSeededRandom(3),
      createBuffer: (len, rate) => fakeBuffer(1, len, rate),
      // OfflineCtor bewusst nicht gesetzt: in Node gibt es keinen.
    });
    expect(buffer).not.toBeNull();
    expect(buffer!.numberOfChannels).toBe(1);
    expect(rms(buffer!, 0, 200)).toBeGreaterThan(0);
  });

  it('liefert null, wenn weder OfflineAudioContext noch Factory verfügbar sind', async () => {
    const buffer = await renderDrumBuffer(kick, 48000, { random: createSeededRandom(1) });
    expect(buffer).toBeNull();
  });
});
