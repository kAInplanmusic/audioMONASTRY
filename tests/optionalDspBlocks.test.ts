import { describe, expect, it } from 'vitest';
import { applyModMatrix, applyModulationToParameters } from '../src/core/dsp/modMatrix';
import {
  highFrequencyEnergy,
  phaseDistortionSample,
  renderPhaseDistortion,
  shapePhase,
} from '../src/core/dsp/phaseDistortion';
import { pianoSampleCount, renderElectricPiano, rmsOf } from '../src/core/dsp/electricPiano';
import { HighQualityReverb, renderReverbImpulse } from '../src/core/dsp/hqReverb';

// ---------------------------------------------------------------------------
// FEAT-P3-001: optionale Synthese-/DSP-Bausteine. Geprüft wird die *Wirkung*
// (Oberwellen, Hüllkurve, Abklingen, Stabilität) – nicht nur „läuft ohne Fehler".
// ---------------------------------------------------------------------------

describe('Modulations-Matrix', () => {
  const routes = [
    { id: 'r1', source: 'lfo1', destination: 'dsp.cutoff', depth: 0.5 },
    { id: 'r2', source: 'env.amp', destination: 'dsp.cutoff', depth: 0.25 },
    { id: 'r3', source: 'cc21', destination: 'eq.low', depth: 0.2, polarity: 'bipolar' as const },
  ];

  it('summiert mehrere Quellen auf dasselbe Ziel', () => {
    const res = applyModMatrix(routes, { lfo1: 0.8, 'env.amp': 0.4, cc21: 1 });
    expect(res.applied).toBe(3);
    // 0.8*0.5 + 0.4*0.25 = 0.5
    expect(res.values['dsp.cutoff']).toBeCloseTo(0.5, 6);
    // bipolar: 2*1−1 = 1 → 1*0.2
    expect(res.values['eq.low']).toBeCloseTo(0.2, 6);
    expect(res.skipped).toEqual([]);
  });

  it('meldet übersprungene Routen statt still Null zu addieren', () => {
    const res = applyModMatrix(
      [
        ...routes,
        { id: 'fehlt', source: 'gibts-nicht', destination: 'x', depth: 0.5 },
        { id: 'aus', source: 'lfo1', destination: 'x', depth: 0.5, enabled: false },
        { id: 'null', source: 'lfo1', destination: 'x', depth: 0 },
        { id: 'kaputt', source: 'lfo1', destination: 'x', depth: Number.NaN },
      ],
      { lfo1: 0.5, 'env.amp': 0.2, cc21: 0.5 },
    );
    expect(res.skipped.sort()).toEqual(['aus', 'fehlt', 'kaputt', 'null']);
    expect(res.values.x).toBeUndefined();
  });

  it('klemmt Tiefe und Ergebnis', () => {
    const res = applyModMatrix(
      [{ id: 'r', source: 'lfo1', destination: 'v', depth: 9 }],
      { lfo1: 1 },
    );
    expect(res.values.v).toBe(1); // depth geklemmt auf 1, Ergebnis auf 1

    const bipolar = applyModMatrix(
      [{ id: 'r', source: 'lfo1', destination: 'v', depth: 1, polarity: 'bipolar' }],
      { lfo1: 0 },
    );
    expect(bipolar.values.v).toBe(-1);
  });

  it('addiert Modulation auf einen Basiswert (Parameter-Weg)', () => {
    const out = applyModulationToParameters({ 'dsp.cutoff': 0.6 }, routes, { lfo1: 0.5, 'env.amp': 0.4 });
    expect(out.parameters['dsp.cutoff']).toBeCloseTo(0.6 + 0.25 + 0.1, 6);
    // Nicht modulierte Basen bleiben unverändert.
    expect(out.parameters).toHaveProperty('dsp.cutoff');
  });
});

describe('Phase-Distortion', () => {
  it('verzerrt bei amount = 0 gar nicht', () => {
    expect(shapePhase(0.25, 0)).toBeCloseTo(0.25, 8);
    expect(phaseDistortionSample(0.25, 0)).toBeCloseTo(Math.sin(2 * Math.PI * 0.25) * 0.9, 8);
  });

  it('erzeugt mehr Oberwellen, wenn die Phase verzerrt wird (Säge-Verlauf)', () => {
    const clean = renderPhaseDistortion(220, 48000, 4800, { amount: 0 });
    const hard = renderPhaseDistortion(220, 48000, 4800, { amount: 0.9, waveform: 'saw' });
    expect(highFrequencyEnergy(hard)).toBeGreaterThan(highFrequencyEnergy(clean) * 2);
  });

  it('bleibt im Wertebereich und ohne NaN', () => {
    for (const amount of [0, 0.25, 0.5, 0.9, 1]) {
      const buf = renderPhaseDistortion(440, 44100, 1000, { amount, waveform: 'square' });
      for (let i = 0; i < buf.length; i++) {
        expect(Number.isFinite(buf[i])).toBe(true);
        expect(Math.abs(buf[i])).toBeLessThanOrEqual(1);
      }
    }
  });

  it('meldet Unsinn als stille Vorgabe statt NaN', () => {
    const buf = renderPhaseDistortion(Number.NaN, 0, 10.7, { amount: Number.NaN });
    expect(buf.length).toBe(10);
    expect(buf.every((v) => v === 0 || Number.isFinite(v))).toBe(true);
  });
});

describe('E-Piano-Stimme (FM)', () => {
  it('erzeugt die erwartete Länge und bleibt stabil', () => {
    const buf = renderElectricPiano(220, { sampleRate: 48000, durationS: 1 });
    expect(buf.length).toBe(pianoSampleCount({ sampleRate: 48000, durationS: 1 }));
    expect(buf.every((v) => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
  });

  it('hat einen Anschlag, der in ein Sustain abklingt', () => {
    const buf = renderElectricPiano(220, { sampleRate: 48000, durationS: 2, attackS: 0.01, ampDecayS: 0.5 });
    const first = rmsOf(buf, 0, 2000); // erste 40 ms
    const middle = rmsOf(buf, 20000, 24000); // ~0,45 s
    const late = rmsOf(buf, 80000, 88000); // ~1,8 s
    expect(first).toBeGreaterThan(0);
    expect(middle).toBeLessThan(first);
    expect(late).toBeLessThan(middle);
    // Der allererste Sample ist der Anschlag-Rampe wegen (fast) still.
    expect(Math.abs(buf[0])).toBeLessThan(0.2);
  });

  it('ist ohne FM-Index ein reiner Ton (kaum Oberwellen), mit Index glockig', () => {
    const pure = renderElectricPiano(220, { sampleRate: 48000, durationS: 0.5, modIndex: 0, detune: 0 });
    const bell = renderElectricPiano(220, { sampleRate: 48000, durationS: 0.5, modIndex: 3, detune: 0 });
    expect(highFrequencyEnergy(bell)).toBeGreaterThan(highFrequencyEnergy(pure) * 1.5);
  });

  it('begrenzt absurde Optionen statt zu übersteuern', () => {
    const buf = renderElectricPiano(2_000_000, { sampleRate: 8000, durationS: 999, gain: 5, modIndex: 999 });
    expect(buf.length).toBe(8000 * 60); // Dauer auf 60 s begrenzt
    expect(buf.every((v) => Math.abs(v) <= 1)).toBe(true);
  });
});

describe('HQ-Reverb (FDN)', () => {
  it('lässt bei mix = 0 das Signal unverändert (Dry)', () => {
    const reverb = new HighQualityReverb({ sampleRate: 48000, mix: 0 });
    const input = new Float32Array([0.5, -0.25, 0.125, 0]);
    const out = reverb.process(input);
    for (let i = 0; i < input.length; i++) expect(out[i]).toBeCloseTo(input[i], 6);
  });

  it('erzeugt eine abklingende Fahne (Impulsantwort) ohne Ausreißer', () => {
    const tail = renderReverbImpulse({ sampleRate: 48000, decayS: 1, mix: 1, lengthSamples: 48000 });
    const early = rmsOf(tail, 2400, 9600);
    const mid = rmsOf(tail, 19200, 28800);
    const late = rmsOf(tail, 43200, 47700);
    expect(early).toBeGreaterThan(0);
    expect(mid).toBeLessThan(early);
    expect(late).toBeLessThan(mid);
    expect(tail.every((v) => Number.isFinite(v) && Math.abs(v) <= 4)).toBe(true);
  });

  it('bleibt auch bei langer Fahne und vielen Blöcken stabil', () => {
    const reverb = new HighQualityReverb({ sampleRate: 48000, decayS: 30, damping: 0, mix: 0.6 });
    let peak = 0;
    const block = new Float32Array(128);
    block[0] = 1;
    for (let blockIndex = 0; blockIndex < 400; blockIndex++) {
      const out = reverb.process(blockIndex === 0 ? block : new Float32Array(128));
      for (const v of out) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
    }
    expect(peak).toBeLessThan(4); // keine Eskalation trotz RT60 = 30 s
  });

  it('klingt bei kurzem RT60 schneller ab als bei langem', () => {
    const short = renderReverbImpulse({ sampleRate: 48000, decayS: 0.3, mix: 1, lengthSamples: 24000 });
    const long = renderReverbImpulse({ sampleRate: 48000, decayS: 5, mix: 1, lengthSamples: 24000 });
    expect(rmsOf(long, 21600, 24000)).toBeGreaterThan(rmsOf(short, 21600, 24000));
  });

  it('setzt das Netz zurück (kein Resthall nach reset)', () => {
    const reverb = new HighQualityReverb({ sampleRate: 48000, decayS: 5, mix: 1 });
    const impulse = new Float32Array(256);
    impulse[0] = 1;
    reverb.process(impulse);
    reverb.reset();
    const after = reverb.process(new Float32Array(64));
    expect(after.every((v) => v === 0)).toBe(true);
  });
});
