import { describe, expect, it } from 'vitest';
import { createBandlimitedTable, createMipMaps, createMorphWavetables, sampleWavetable } from '../src/core/instrument/wavetable';
import { createTonewheelTable, LeslieSim } from '../src/core/instrument/tonewheel';
import { renderEpianoNote } from '../src/core/instrument/epiano';
import { humanize, renderHat, renderKick, renderSnare } from '../src/core/instrument/drumSynth';
import { renderAdditiveMorph, renderEarlyReflectionsImpulse } from '../src/core/instrument/earlyReflections';

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

describe('Wavetable (Mip-Map)', () => {
  it('Tabelle ist deterministisch, normalisiert und endlich', () => {
    const t1 = createBandlimitedTable([1, 0.5, 0.25]);
    const t2 = createBandlimitedTable([1, 0.5, 0.25]);
    expect(t1).toEqual(t2);
    for (let i = 0; i < t1.length; i++) expect(Number.isFinite(t1[i])).toBe(true);
  });

  it('Morph zwischen Sinus und Sägezahn verändert den Klang', () => {
    const { sine, saw } = createMorphWavetables(1024);
    const a = sampleWavetable(sine, saw, 0, 0.3, 0);
    const b = sampleWavetable(sine, saw, 1, 0.3, 0);
    expect(a).not.toBe(b);
    expect(createMipMaps(createBandlimitedTable([1])).length).toBeGreaterThan(3);
  });
});

describe('Tonewheel + Leslie', () => {
  it('Drawbar-Mix ist deterministisch und geclampt', () => {
    const t = createTonewheelTable([8, 0, 8, 4, 0, 2, 0, 0, 1]);
    expect(t).toEqual(createTonewheelTable([8, 0, 8, 4, 0, 2, 0, 0, 1]));
    for (let i = 0; i < t.length; i++) expect(Math.abs(t[i])).toBeLessThanOrEqual(1);
  });

  it('Leslie: Fast-Speed moduliert Amplitude messbar', () => {
    const leslie = new LeslieSim(48000, { slowHz: 0.5, fastHz: 5, rampSec: 0.1 });
    const slow = [];
    for (let i = 0; i < 4800; i++) slow.push(leslie.process(1));
    leslie.setFast(true);
    const fast = [];
    for (let i = 0; i < 4800; i++) fast.push(leslie.process(1));
    const slowVar = Math.max(...slow) - Math.min(...slow);
    const fastVar = Math.max(...fast) - Math.min(...fast);
    expect(fastVar).toBeGreaterThan(slowVar);
  });
});

describe('E-Piano (Physical Modeling)', () => {
  it('Note klingt ab, ist endlich und deterministisch', () => {
    const a = renderEpianoNote(220, 0.5);
    const b = renderEpianoNote(220, 0.5);
    expect(a).toEqual(b);
    expect(rms(a)).toBeGreaterThan(1e-4);
    for (let i = 0; i < a.length; i++) expect(Number.isFinite(a[i])).toBe(true);
    // Abkling: letzte 10 % leiser als erste 10 %.
    const head = rms(a.subarray(0, Math.floor(a.length * 0.1)));
    const tail = rms(a.subarray(Math.floor(a.length * 0.9)));
    expect(tail).toBeLessThan(head);
  });
});

describe('Drum-Synthese + Humanize', () => {
  it('Kick/Snare/Hat sind hörbar, endlich und deterministisch', () => {
    const kick = renderKick();
    expect(rms(kick)).toBeGreaterThan(1e-4);
    expect(rms(renderSnare())).toBeGreaterThan(1e-4);
    expect(rms(renderHat())).toBeGreaterThan(1e-4);
    expect(kick).toEqual(renderKick());
    for (const v of kick) expect(Number.isFinite(v)).toBe(true);
  });

  it('Humanize ist deterministisch und bleibt im Rahmen', () => {
    const a = humanize(3, 0.02, 42);
    const b = humanize(3, 0.02, 42);
    expect(a).toEqual(b);
    expect(Math.abs(a.timeOffsetSec)).toBeLessThanOrEqual(0.01);
    expect(a.velocity).toBeGreaterThanOrEqual(0.2);
    expect(a.velocity).toBeLessThanOrEqual(1);
  });
});

describe('Early-Reflections + Additiv', () => {
  it('Impulsantwort hat Energie und klingt ab', () => {
    const ir = renderEarlyReflectionsImpulse();
    expect(ir[0]).toBe(1);
    expect(rms(ir)).toBeGreaterThan(0.001);
    const head = rms(ir.subarray(0, Math.floor(ir.length * 0.1)));
    const tail = rms(ir.subarray(Math.floor(ir.length * 0.8)));
    expect(tail).toBeLessThan(head);
  });

  it('Additives Morphing ist deterministisch und endlich', () => {
    const a = renderAdditiveMorph(220, 0.3, 24000, { partialsA: [1, 0.5], partialsB: [1, 0.1, 0.4], position: 0.5 });
    const b = renderAdditiveMorph(220, 0.3, 24000, { partialsA: [1, 0.5], partialsB: [1, 0.1, 0.4], position: 0.5 });
    expect(a).toEqual(b);
    for (const v of a) expect(Number.isFinite(v)).toBe(true);
  });
});
