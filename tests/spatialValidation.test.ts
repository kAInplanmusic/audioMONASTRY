import { describe, expect, it } from 'vitest';
import {
  StereoSpatialRenderer,
  BinauralSpatialRenderer,
  MultichannelSpatialRenderer,
} from '../src/core/spatial/spatialRenderers';
import type { AudioSignal, SpatialSource } from '../src/core/interfaces';

/** DCT-112: Spatial-Renderer-Validierung (deterministisch, NaN-frei, Kanalzahl). */
const makeSignal = (channels = 1, len = 64): AudioSignal => ({
  sampleRate: 48000,
  channelData: Array.from({ length: channels }, () => {
    const a = new Float32Array(len);
    for (let i = 0; i < len; i++) a[i] = Math.sin((i / len) * Math.PI * 2);
    return a;
  }),
});

const source: SpatialSource = { id: 'src-1', x: 0.5, y: 0.3, gain: 0.8, spread: 0.5 };

const allFinite = (sig: AudioSignal): boolean =>
  sig.channelData.every((ch) => ch.every((v) => Number.isFinite(v)));

describe('Spatial-Renderer (DCT-112)', () => {
  it('Stereo-Renderer liefert 2 Kanäle und ist NaN-frei', () => {
    const renderer = new StereoSpatialRenderer();
    renderer.setSetup('2.0');
    const out = renderer.render(makeSignal(1), source);
    expect(out.channelData).toHaveLength(2);
    expect(allFinite(out)).toBe(true);
  });

  it('Binaural-Renderer liefert 2 Kanäle und ist NaN-frei', () => {
    const renderer = new BinauralSpatialRenderer();
    const out = renderer.render(makeSignal(1), source);
    expect(out.channelData).toHaveLength(2);
    expect(allFinite(out)).toBe(true);
  });

  it('Multichannel-Renderer (5.1) liefert 6 Kanäle und ist NaN-frei', () => {
    const renderer = new MultichannelSpatialRenderer();
    renderer.setSetup('5.1');
    const out = renderer.render(makeSignal(2), source);
    expect(out.channelData.length).toBeGreaterThanOrEqual(6);
    expect(allFinite(out)).toBe(true);
  });

  it('Ungültiges Setup fällt auf 2.0 zurück (Stereo)', () => {
    const renderer = new StereoSpatialRenderer();
    renderer.setSetup('kaputt');
    expect(renderer.getSetup()).toBe('2.0');
  });
});
