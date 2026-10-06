import { describe, expect, it } from 'vitest';

import { EffectPluginAdapter } from '../src/plugins/adapters/EffectPluginAdapter';
import { DspPluginAdapter } from '../src/plugins/adapters/DspPluginAdapter';
import { EqPluginAdapter } from '../src/plugins/adapters/EqPluginAdapter';
import { MasterPluginAdapter } from '../src/plugins/adapters/MasterPluginAdapter';
import { SpatialPluginAdapter } from '../src/plugins/adapters/SpatialPluginAdapter';
import { MixerPluginAdapter } from '../src/plugins/adapters/MixerPluginAdapter';
import { RecordPluginAdapter } from '../src/plugins/adapters/RecordPluginAdapter';
import { SyntiSamplerPluginAdapter } from '../src/plugins/adapters/SyntiSamplerPluginAdapter';
import { DrumSamplerPluginAdapter } from '../src/plugins/adapters/DrumSamplerPluginAdapter';
import type { PluginInterface, PluginParameterValue } from '../src/plugins/plugin_interface';
import type { PluginState } from '../src/plugins/types';

const SR = 8000;

type Params = Record<string, PluginParameterValue['value']>;

/** Deterministische Quelle (kein Rauschen) für bit-genaue Vergleiche. */
function sine(frames: number, count = 1): Float32Array[] {
  return Array.from({ length: count }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => Math.sin((i + c) / 5) * 0.8),
  );
}

function constant(frames: number, count = 1, value = 1): Float32Array[] {
  return Array.from({ length: count }, () => Float32Array.from({ length: frames }, () => value));
}

function alternating(frames: number): Float32Array[] {
  return [Float32Array.from({ length: frames }, (_, i) => (i % 2 === 0 ? 1 : -1))];
}

/** Signalenergie – für Band-Aussagen („Band entfernt = Energie weg“). */
function energy(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return sum;
}

/** Energie des eingeschwungenen Teils (letztes Viertel) – ohne Einschwingen. */
function settledEnergy(samples: Float32Array): number {
  return energy(samples.subarray(Math.floor(samples.length * 0.75)));
}

/** Setzt Zustand/Parameter deterministisch und schickt EINEN Block durch. */
function runChannels(
  adapter: PluginInterface,
  channels: Float32Array[],
  params: Params = {},
  state: PluginState = 'PRO',
): Float32Array[] {
  adapter.restore({ pluginId: adapter.manifest.id, state, parameters: params });
  const block = adapter.process({
    channels,
    sampleRate: SR,
    timestamp: 0,
    frameCount: channels[0]?.length ?? 0,
  });
  return block.channels as Float32Array[];
}

/** Kurzform: ein Block aus Sinusquellen. */
function runBlock(
  adapter: PluginInterface,
  params: Params = {},
  state: PluginState = 'PRO',
  frames = 64,
  count = 1,
): Float32Array[] {
  return runChannels(adapter, sine(frames, count), params, state);
}

describe('Adapter-Blockverarbeitung: effect (Bit-Tiefe + Dry/Wet)', () => {
  it('ist bei voller Bit-Tiefe transparent', () => {
    const adapter = new EffectPluginAdapter();
    const src = sine(64);
    expect(Array.from(runBlock(adapter)[0])).toEqual(Array.from(src[0]));
  });

  it('ist bei OFF transparent, auch mit niedriger Bit-Tiefe', () => {
    const adapter = new EffectPluginAdapter();
    const src = sine(64);
    expect(Array.from(runBlock(adapter, { bits: 3 }, 'OFF')[0])).toEqual(Array.from(src[0]));
  });

  it('quantisiert bei bits=4 auf Achtel-Schritte', () => {
    const adapter = new EffectPluginAdapter();
    const src = sine(64);
    const out = runBlock(adapter, { bits: 4, wet: 1 })[0];
    for (let i = 0; i < 64; i++) {
      expect(out[i]).toBeCloseTo(Math.round(src[0][i] * 8) / 8, 6);
    }
    expect(Array.from(out)).not.toEqual(Array.from(src[0]));
  });

  it('laesst bei wet=0 das trockene Signal stehen', () => {
    const adapter = new EffectPluginAdapter();
    const src = sine(64);
    expect(Array.from(runBlock(adapter, { bits: 4, wet: 0 })[0])).toEqual(Array.from(src[0]));
  });

  it('klemmt bits auf 1…16', () => {
    const adapter = new EffectPluginAdapter();
    const src = sine(16);
    // 99 -> 16 -> transparent
    expect(Array.from(runBlock(adapter, { bits: 99 }, 'PRO', 16)[0])).toEqual(Array.from(src[0]));
    // -3 -> 1 -> Stufen von 1.0 (alles auf -1/0/1 gerundet)
    const crushed = runBlock(adapter, { bits: -3, wet: 1 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) {
      expect(crushed[i]).toBeCloseTo(Math.round(src[0][i]), 6);
    }
  });

  it('arbeitet auf allen Kanaelen', () => {
    const adapter = new EffectPluginAdapter();
    const out = runBlock(adapter, { bits: 4, wet: 1 }, 'PRO', 32, 2);
    expect(out.length).toBe(2);
    for (const channel of out) {
      for (let i = 0; i < 32; i++) {
        expect(channel[i] * 8).toBeCloseTo(Math.round(channel[i] * 8), 6);
      }
    }
  });
});

describe('Adapter-Blockverarbeitung: master (Ausgangsverstaerkung)', () => {
  it('ist ohne Parameter transparent', () => {
    const adapter = new MasterPluginAdapter();
    const src = sine(32);
    expect(Array.from(runBlock(adapter, {}, 'PRO', 32)[0])).toEqual(Array.from(src[0]));
  });

  it('halbiert bei gain=0.5', () => {
    const adapter = new MasterPluginAdapter();
    const src = sine(32);
    const out = runBlock(adapter, { gain: 0.5 })[0];
    for (let i = 0; i < 32; i++) expect(out[i]).toBeCloseTo(src[0][i] * 0.5, 6);
  });

  it('klemmt gain auf 0…2', () => {
    const adapter = new MasterPluginAdapter();
    const src = sine(16);
    const doubled = runBlock(adapter, { gain: 5 })[0];
    for (let i = 0; i < 16; i++) expect(doubled[i]).toBeCloseTo(src[0][i] * 2, 6);

    const silent = runBlock(adapter, { gain: -1 })[0];
    for (let i = 0; i < 16; i++) expect(silent[i]).toBe(0);
  });
});

describe('Adapter-Blockverarbeitung: eq (3-Band-Tonregelung)', () => {
  it('ist in Einheitsstellung transparent', () => {
    const adapter = new EqPluginAdapter();
    const src = sine(64);
    expect(Array.from(runBlock(adapter, {}, 'PRO')[0])).toEqual(Array.from(src[0]));
    expect(Array.from(runBlock(adapter, { low: 0, mid: 0, high: 0 }, 'PRO')[0])).toEqual(
      Array.from(src[0]),
    );
  });

  it('ist bei OFF transparent', () => {
    const adapter = new EqPluginAdapter();
    const src = sine(64);
    expect(Array.from(runBlock(adapter, { low: 24 }, 'OFF')[0])).toEqual(Array.from(src[0]));
  });

  it('entfernt das Tiefton-Band bei low = -24 dB (Gleichanteil)', () => {
    const adapter = new EqPluginAdapter();
    const dry = constant(4000);
    const wet = runChannels(adapter, constant(4000), { low: -24 });
    // Eingeschwungen: -24 dB entspricht Faktor 0,063 -> rund 0,4 % der Energie.
    expect(settledEnergy(wet[0])).toBeLessThan(settledEnergy(dry[0]) * 0.01);
  });

  it('daempft das Hochton-Band bei high = -24 dB und hebt es bei +24 dB', () => {
    // Ein-Pol-Uebergaenge ueberlappen stark: das Mittenband traegt bei einem
    // Wechselsignal auch Energie. Geprueft wird deshalb die RICHTUNG, nicht die
    // vollstaendige Entfernung.
    const dry = settledEnergy(alternating(4000)[0]);
    const cut = settledEnergy(runChannels(new EqPluginAdapter(), alternating(4000), { high: -24 })[0]);
    const boost = settledEnergy(runChannels(new EqPluginAdapter(), alternating(4000), { high: 24 })[0]);
    expect(cut).toBeLessThan(dry);
    expect(boost).toBeGreaterThan(dry);
  });

  it('daempft das Mittenband bei mittleren Frequenzen (1 kHz)', () => {
    const mid = (frames: number) =>
      Float32Array.from({ length: frames }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / SR));
    const dryEnergy = settledEnergy(mid(4000));
    const cut = settledEnergy(runChannels(new EqPluginAdapter(), [mid(4000)], { mid: -24 })[0]);
    const boost = settledEnergy(runChannels(new EqPluginAdapter(), [mid(4000)], { mid: 24 })[0]);
    expect(cut).toBeLessThan(dryEnergy * 0.2);
    expect(boost).toBeGreaterThan(dryEnergy * 5);
  });

  it('verstaerkt das Tiefton-Band bei +24 dB und bleibt endlich', () => {
    const adapter = new EqPluginAdapter();
    const wet = runChannels(adapter, constant(4000), { low: 99 })[0];
    expect(Number.isFinite(wet[3999])).toBe(true);
    // +24 dB entspricht Faktor 15,85 auf dem Gleichanteil.
    expect(wet[3999]).toBeGreaterThan(10);
    expect(wet[3999]).toBeLessThan(20);
  });

  it('arbeitet auf beiden Kanaelen', () => {
    const adapter = new EqPluginAdapter();
    const out = runChannels(adapter, constant(2000, 2), { low: -24 });
    expect(out.length).toBe(2);
    const dryEnergy = settledEnergy(constant(2000)[0]);
    expect(settledEnergy(out[0])).toBeLessThan(dryEnergy * 0.01);
    expect(settledEnergy(out[1])).toBeLessThan(dryEnergy * 0.01);
  });
});

describe('Adapter-Blockverarbeitung: spatial (Pan/Breite je Kanal)', () => {
  it('ist ohne Parameter transparent', () => {
    const adapter = new SpatialPluginAdapter();
    const src = sine(64, 2);
    const out = runChannels(adapter, sine(64, 2));
    expect(Array.from(out[0])).toEqual(Array.from(src[0]));
    expect(Array.from(out[1])).toEqual(Array.from(src[1]));
  });

  it('ist bei OFF transparent', () => {
    const adapter = new SpatialPluginAdapter();
    const src = sine(64, 2);
    const out = runChannels(adapter, sine(64, 2), { pan: 1, width: 2 }, 'OFF');
    expect(Array.from(out[0])).toEqual(Array.from(src[0]));
  });

  it('legt bei pan=-1 den linken Kanal auf Spitze, den rechten auf null', () => {
    const src = constant(32, 2, 1);
    const out = runChannels(new SpatialPluginAdapter(), [src[0].slice(), src[1].slice()], { pan: -1 });
    // cos(0) = 1 \u2192 links unver\u00e4ndert, sin(0) = 0 \u2192 rechts still.
    expect(out[0][31]).toBeCloseTo(1, 6);
    expect(out[1][31]).toBeCloseTo(0, 6);
  });

  it('legt bei pan=+1 den rechten Kanal auf Spitze, den linken auf null', () => {
    const src = constant(32, 2, 1);
    const out = runChannels(new SpatialPluginAdapter(), [src[0].slice(), src[1].slice()], { pan: 1 });
    expect(out[0][31]).toBeCloseTo(0, 6);
    expect(out[1][31]).toBeCloseTo(1, 6);
  });

  it('haelt die Leistung bei pan=0 (Mitte) konstant', () => {
    const src = constant(32, 2, 1);
    const out = runChannels(new SpatialPluginAdapter(), [src[0].slice(), src[1].slice()], { pan: 0.0001 });
    const power = out[0][31] ** 2 + out[1][31] ** 2;
    expect(power).toBeCloseTo(1, 3);
  });

  it('klemmt pan auf -1…1', () => {
    const src = constant(16, 2, 1);
    const out = runChannels(new SpatialPluginAdapter(), [src[0].slice(), src[1].slice()], { pan: 99 });
    expect(out[1][15]).toBeCloseTo(1, 6);
  });

  it('komprimiert bei width=0 auf Mono (beide Kanaele gleich)', () => {
    const left = Float32Array.from({ length: 32 }, () => 1);
    const right = Float32Array.from({ length: 32 }, () => -1);
    const out = runChannels(new SpatialPluginAdapter(), [left, right], { width: 0 });
    // M = (1 + -1)/2 = 0 \u2192 beide Kan\u00e4le 0.
    expect(out[0][31]).toBeCloseTo(0, 6);
    expect(out[1][31]).toBeCloseTo(0, 6);
  });

  it('verdoppelt bei width=2 die Differenz zum Mittenbild', () => {
    const left = Float32Array.from({ length: 32 }, () => 0.4);
    const right = Float32Array.from({ length: 32 }, () => 0.2);
    const out = runChannels(new SpatialPluginAdapter(), [left, right], { width: 2 });
    // M = 0.3; L = 0.3 + (0.4-0.3)*2 = 0.5; R = 0.3 + (0.2-0.3)*2 = 0.1
    expect(out[0][31]).toBeCloseTo(0.5, 6);
    expect(out[1][31]).toBeCloseTo(0.1, 6);
  });
});

describe('Adapter-Blockverarbeitung: mixer (Kanal-Gains/Pan als Summe)', () => {
  it('ist ohne Parameter transparent', () => {
    const adapter = new MixerPluginAdapter();
    const src = sine(64, 2);
    const out = runChannels(adapter, sine(64, 2));
    expect(Array.from(out[0])).toEqual(Array.from(src[0]));
    expect(Array.from(out[1])).toEqual(Array.from(src[1]));
  });

  it('ist bei OFF transparent', () => {
    const adapter = new MixerPluginAdapter();
    const src = sine(64, 2);
    const out = runChannels(adapter, sine(64, 2), { gain: 2 }, 'OFF');
    expect(Array.from(out[0])).toEqual(Array.from(src[0]));
  });

  it('halbiert bei gain=0.5 alle Kanaele', () => {
    const src = sine(32, 2);
    const out = runChannels(new MixerPluginAdapter(), sine(32, 2), { gain: 0.5 });
    for (let i = 0; i < 32; i++) {
      expect(out[0][i]).toBeCloseTo(src[0][i] * 0.5, 6);
      expect(out[1][i]).toBeCloseTo(src[1][i] * 0.5, 6);
    }
  });

  it('klemmt gain auf 0…2', () => {
    const src = sine(16, 1);
    const doubled = runChannels(new MixerPluginAdapter(), sine(16, 1), { gain: 9 })[0];
    for (let i = 0; i < 16; i++) expect(doubled[i]).toBeCloseTo(src[0][i] * 2, 6);

    const silent = runChannels(new MixerPluginAdapter(), sine(16, 1), { gain: -3 })[0];
    for (let i = 0; i < 16; i++) expect(silent[i]).toBe(0);
  });

  it('summiert kanalweise Gains getrennt (gain:0 / gain:1)', () => {
    const src = sine(32, 2);
    const out = runChannels(new MixerPluginAdapter(), sine(32, 2), { 'gain:0': 0.5, 'gain:1': 0 });
    for (let i = 0; i < 32; i++) {
      expect(out[0][i]).toBeCloseTo(src[0][i] * 0.5, 6);
      // gain=0 ergibt -0 statt +0 (Vorzeichen des Quellsignals) – beide sind null.
      expect(Math.abs(out[1][i])).toBe(0);
    }
  });

  it('schickt einen Kanal-Pan auf den anderen Kanal', () => {
    const src = constant(32, 2, 1);
    const out = runChannels(new MixerPluginAdapter(), [src[0].slice(), src[1].slice()], { pan: 1 });
    expect(out[0][31]).toBeCloseTo(0, 6);
    expect(out[1][31]).toBeCloseTo(1, 6);
  });

  it('haelt die Leistung bei Pan in der Mitte', () => {
    const src = constant(32, 2, 1);
    const out = runChannels(new MixerPluginAdapter(), [src[0].slice(), src[1].slice()], { pan: 0.0001 });
    const power = out[0][31] ** 2 + out[1][31] ** 2;
    expect(power).toBeCloseTo(1, 3);
  });
});

describe('Adapter-Blockverarbeitung: dsp (resonanter Tiefpass + Drive)', () => {
  const tone = (frames: number, hz: number) =>
    [Float32Array.from({ length: frames }, (_, i) => Math.sin((2 * Math.PI * hz * i) / SR) * 0.5)];

  it('ist ohne Parameter transparent (cutoff ueber Nyquist)', () => {
    const src = sine(64);
    expect(Array.from(runChannels(new DspPluginAdapter(), sine(64))[0])).toEqual(Array.from(src[0]));
  });

  it('ist bei OFF transparent', () => {
    const src = sine(64);
    expect(Array.from(runChannels(new DspPluginAdapter(), sine(64), { cutoff: 400 }, 'OFF')[0])).toEqual(
      Array.from(src[0]),
    );
  });

  it('daempft oberhalb der Grenzfrequenz deutlich', () => {
    const dry = settledEnergy(tone(4000, 3000)[0]);
    const wet = settledEnergy(runChannels(new DspPluginAdapter(), tone(4000, 3000), { cutoff: 500 })[0]);
    expect(wet).toBeLessThan(dry * 0.05);
  });

  it('laesst unterhalb der Grenzfrequenz durch', () => {
    const dry = settledEnergy(tone(4000, 100)[0]);
    const wet = settledEnergy(runChannels(new DspPluginAdapter(), tone(4000, 100), { cutoff: 500 })[0]);
    expect(wet).toBeGreaterThan(dry * 0.8);
  });

  it('hebt bei Resonanz die Grenzfrequenz an', () => {
    const dry = settledEnergy(tone(4000, 1000)[0]);
    const wet = settledEnergy(runChannels(new DspPluginAdapter(), tone(4000, 1000), { cutoff: 1000, resonance: 0.9 })[0]);
    expect(wet).toBeGreaterThan(dry * 5);
  });

  it('begrenzt mit Drive die Amplitude (Soft-Clip)', () => {
    const loud = [Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i / 7) * 4)];
    const out = runChannels(new DspPluginAdapter(), loud, { drive: 1 }, 'PRO')[0];
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeLessThanOrEqual(1.0001);
    expect(peak).toBeGreaterThan(0.5);
  });

  it('arbeitet auf beiden Kanaelen', () => {
    const out = runChannels(new DspPluginAdapter(), [tone(2000, 3000)[0], tone(2000, 3000)[0]], { cutoff: 500 });
    expect(out.length).toBe(2);
    expect(settledEnergy(out[0])).toBeLessThan(settledEnergy(tone(2000, 3000)[0]) * 0.05);
    expect(settledEnergy(out[1])).toBeLessThan(settledEnergy(tone(2000, 3000)[0]) * 0.05);
  });
});

describe('Adapter-Blockverarbeitung: syntisampler (Gain + Velocity)', () => {
  it('ist ohne Parameter transparent', () => {
    const adapter = new SyntiSamplerPluginAdapter();
    const src = sine(32);
    expect(Array.from(runBlock(adapter, {}, 'PRO', 32)[0])).toEqual(Array.from(src[0]));
  });

  it('ist bei OFF transparent', () => {
    const adapter = new SyntiSamplerPluginAdapter();
    const src = sine(32);
    expect(Array.from(runBlock(adapter, { gain: 0 }, 'OFF', 32)[0])).toEqual(Array.from(src[0]));
  });

  it('haelt Pegel bei gain=1 und velocity=1', () => {
    const src = sine(32);
    const out = runBlock(new SyntiSamplerPluginAdapter(), { gain: 1, velocity: 1 }, 'PRO', 32)[0];
    for (let i = 0; i < 32; i++) expect(out[i]).toBeCloseTo(src[0][i], 6);
  });

  it('skaliert mit gain=0.5', () => {
    const src = sine(32);
    const out = runBlock(new SyntiSamplerPluginAdapter(), { gain: 0.5, velocity: 1 }, 'PRO', 32)[0];
    for (let i = 0; i < 32; i++) expect(out[i]).toBeCloseTo(src[0][i] * 0.5, 6);
  });

  it('skaliert mit velocity=0.5', () => {
    const src = sine(32);
    const out = runBlock(new SyntiSamplerPluginAdapter(), { gain: 1, velocity: 0.5 }, 'PRO', 32)[0];
    for (let i = 0; i < 32; i++) expect(out[i]).toBeCloseTo(src[0][i] * 0.5, 6);
  });

  it('klemmt gain auf 0…2', () => {
    const src = sine(16);
    const dbl = runBlock(new SyntiSamplerPluginAdapter(), { gain: 5 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) expect(dbl[i]).toBeCloseTo(src[0][i] * 2, 6);
    const silent = runBlock(new SyntiSamplerPluginAdapter(), { gain: -1 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) expect(silent[i]).toBe(0);
  });

  it('kombiniert gain und velocity', () => {
    const src = sine(16);
    const out = runBlock(new SyntiSamplerPluginAdapter(), { gain: 2, velocity: 0.5 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(src[0][i] * 1, 6);
  });

  it('arbeitet auf beiden Kanaelen', () => {
    const src = sine(32, 2);
    const srcCopy = src.map(ch => ch.slice());
    const out = runChannels(new SyntiSamplerPluginAdapter(), srcCopy, { gain: 0.5 });
    expect(out.length).toBe(2);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < 32; i++) {
        expect(out[c][i]).toBeCloseTo(src[c][i] * 0.5, 6);
      }
    }
  });
});

describe('Adapter-Blockverarbeitung: drumsampler (Gain + Velocity)', () => {
  it('ist ohne Parameter transparent', () => {
    const adapter = new DrumSamplerPluginAdapter();
    const src = sine(32);
    expect(Array.from(runBlock(adapter, {}, 'PRO', 32)[0])).toEqual(Array.from(src[0]));
  });

  it('ist bei OFF transparent', () => {
    const adapter = new DrumSamplerPluginAdapter();
    const src = sine(32);
    expect(Array.from(runBlock(adapter, { gain: 0 }, 'OFF', 32)[0])).toEqual(Array.from(src[0]));
  });

  it('haelt Pegel bei gain=1 und velocity=1', () => {
    const src = sine(32);
    const out = runBlock(new DrumSamplerPluginAdapter(), { gain: 1, velocity: 1 }, 'PRO', 32)[0];
    for (let i = 0; i < 32; i++) expect(out[i]).toBeCloseTo(src[0][i], 6);
  });

  it('skaliert mit gain=0.5', () => {
    const src = sine(32);
    const out = runBlock(new DrumSamplerPluginAdapter(), { gain: 0.5, velocity: 1 }, 'PRO', 32)[0];
    for (let i = 0; i < 32; i++) expect(out[i]).toBeCloseTo(src[0][i] * 0.5, 6);
  });

  it('skaliert mit velocity=0.5', () => {
    const src = sine(32);
    const out = runBlock(new DrumSamplerPluginAdapter(), { gain: 1, velocity: 0.5 }, 'PRO', 32)[0];
    for (let i = 0; i < 32; i++) expect(out[i]).toBeCloseTo(src[0][i] * 0.5, 6);
  });

  it('klemmt gain auf 0…2', () => {
    const src = sine(16);
    const dbl = runBlock(new DrumSamplerPluginAdapter(), { gain: 5 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) expect(dbl[i]).toBeCloseTo(src[0][i] * 2, 6);
    const silent = runBlock(new DrumSamplerPluginAdapter(), { gain: -1 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) expect(silent[i]).toBe(0);
  });

  it('klemmt velocity auf 0…1', () => {
    const src = sine(16);
    const clamped = runBlock(new DrumSamplerPluginAdapter(), { velocity: 2 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) expect(clamped[i]).toBeCloseTo(src[0][i] * 1, 6);
    const zero = runBlock(new DrumSamplerPluginAdapter(), { velocity: -0.1 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) expect(zero[i]).toBe(0);
  });

  it('kombiniert gain und velocity', () => {
    const src = sine(16);
    const out = runBlock(new DrumSamplerPluginAdapter(), { gain: 2, velocity: 0.5 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(src[0][i] * 1, 6);
  });

  it('arbeitet auf beiden Kanaelen', () => {
    const src = sine(32, 2);
    const srcCopy = src.map(ch => ch.slice());
    const out = runChannels(new DrumSamplerPluginAdapter(), srcCopy, { gain: 0.5 });
    expect(out.length).toBe(2);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < 32; i++) {
        expect(out[c][i]).toBeCloseTo(src[c][i] * 0.5, 6);
      }
    }
  });
});

describe('Adapter-Blockverarbeitung: record (Steuerungs-Adapter, KEIN DSP-Glied)', () => {
  // BELEGTE ENTSCHEIDUNG: `record` ist laut MANIFEST `kind: 'recording'` mit
  // `capabilities: ['recording']`, `latencySamples: 0`, `tailSamples: 0` und
  // reagiert ausschliesslich ueber `onCommand` (start/stop/bounce). Der Ton
  // fliesst NICHT durch den Adapter; aufgenommen wird von der Aufnahme-Engine
  // ausserhalb der Plugin-Kette. Ein Verarbeitungsglied mit null Latenz und
  // null Tail waere fuer eine Aufnahme widersinnig.
  it('nutzt den Bypass der Basisklasse (kein eigener Block-Eingriff)', () => {
    // BasePluginAdapter:79-81 liefert den Block unveraendert zurueck. `record`
    // ueberschreibt onProcess NICHT - der Beleg, dass kein DSP-Eingriff gewollt
    // ist. Ein eigener Eingriff muesste hier als eigene Methode stehen.
    const own = Object.getOwnPropertyNames(RecordPluginAdapter.prototype);
    expect(own).not.toContain('onProcess');
    expect(own).toContain('onCommand');
  });

  it('ist NUR Steuerung: kind=recording, capabilities=[recording]', () => {
    const manifest = (RecordPluginAdapter as unknown as { MANIFEST: { kind: string; capabilities: string[] } }).MANIFEST;
    expect(manifest.kind).toBe('recording');
    expect(manifest.capabilities).toEqual(['recording']);
  });

  it('laesst einen Block unveraendert durch die Kette', () => {
    // Ohne onProcess ist der Adapter fuer das Audiosignal transparent.
    const src = sine(32);
    const out = runBlock(new RecordPluginAdapter(), {}, 'PRO', 32)[0];
    expect(Array.from(out)).toEqual(Array.from(src[0]));
  });
});
