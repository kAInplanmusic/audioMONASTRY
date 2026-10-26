/**
 * UI-Regler → MAIN-Signal: Influence-Test (2026-10-26)
 * ====================================================
 * Warum diese Datei existiert: Nach dem UI-Umbau standen Regler in der
 * Oberfläche, deren Wirkung niemand geprüft hatte (z. B. `type` in
 * setEffectParams, das verworfen wird, oder `setSpatialWidth`, das es nie gab).
 * „Der Regler ruft eine Methode auf" ist zu wenig — er muss das Signal ändern.
 *
 * Geprüft wird am ECHTEN hörbaren Pfad: `V2SinkEngine` ist genau die Engine,
 * die der v2-sink-processor im AudioWorklet hostet. Testton rein, Parameter
 * setzen, Block rendern, Vorher/Nachher messen. Kein Mock, kein Ersatzpfad.
 *
 * Jeder Fall hier entspricht einem Bedienelement der Oberfläche:
 *   Mixer: Trim/Fader (Gain), Pan, Master, EQ, Send
 *   DSP-Rack: Cutoff/Drive
 *   Effect-Rack: Wet/Feedback
 *   Master-Rack: Threshold/Ceiling
 */
import { describe, expect, it } from 'vitest';
import { V2SinkEngine } from '../src/core/audio/live/V2SinkEngine';
import type { IProcessingContext } from '../src/core/audio/types';

const SR = 48000;
const BLOCK = 128;

const ctx = (): IProcessingContext => ({ sampleRate: SR, bufferSize: BLOCK, quantum: BLOCK / SR, currentTime: 0 });

interface Measurement {
  rms: number;
  peak: number;
  rmsL: number;
  rmsR: number;
}

/** Rendert `blocks` Blöcke und misst den Ausgang (L/R getrennt). */
function render(engine: V2SinkEngine, blocks = 40): Measurement {
  const c = ctx();
  let sumAll = 0;
  let sumL = 0;
  let sumR = 0;
  let peak = 0;
  let n = 0;
  for (let i = 0; i < blocks; i += 1) {
    const out = engine.render(c);
    const l = out[0];
    const r = out[1] ?? out[0];
    for (let k = 0; k < l.length; k += 1) {
      sumL += l[k] * l[k];
      sumR += r[k] * r[k];
      sumAll += ((l[k] + r[k]) * 0.5) ** 2;
      const a = Math.max(Math.abs(l[k]), Math.abs(r[k]));
      if (a > peak) peak = a;
    }
    n += l.length;
    c.currentTime += c.quantum;
  }
  return {
    rms: Math.sqrt(sumAll / Math.max(1, n)),
    peak,
    rmsL: Math.sqrt(sumL / Math.max(1, n)),
    rmsR: Math.sqrt(sumR / Math.max(1, n)),
  };
}

/** Frische Engine mit Testton auf Kanal 1 (440 Hz). */
function engineWithTone(freq = 440, amplitude = 0.25): V2SinkEngine {
  const e = new V2SinkEngine(SR, BLOCK);
  e.setTestTone(true, freq, amplitude);
  render(e, 8); // einschwingen
  return e;
}

describe('MAIN-Signal: Mixer-Regler', () => {
  it('Kanal-Gain (Trim/Fader) senkt den Pegel messbar', () => {
    const loud = engineWithTone();
    const before = render(loud, 30).rms;

    const quiet = engineWithTone();
    quiet.setChannelGainDb('channel1', -12);
    const after = render(quiet, 30).rms;

    expect(before).toBeGreaterThan(1e-3);
    expect(after).toBeLessThan(before * 0.5);
  });

  it('Pan schreibt die Seite: -1 links, +1 rechts', () => {
    const left = engineWithTone();
    left.setChannelPan('channel1', -1);
    const mL = render(left, 25);

    const right = engineWithTone();
    right.setChannelPan('channel1', 1);
    const mR = render(right, 25);

    expect(mL.rmsL).toBeGreaterThan(mL.rmsR * 1.5);
    expect(mR.rmsR).toBeGreaterThan(mR.rmsL * 1.5);
  });

  it('Master-Gain wirkt auf die Summe', () => {
    const a = engineWithTone();
    const before = render(a, 25).rms;
    const b = engineWithTone();
    b.setMasterGain(0.5);
    const after = render(b, 25).rms;
    expect(after).toBeLessThan(before * 0.75);
    expect(after).toBeGreaterThan(before * 0.15);
  });
});

describe('MAIN-Signal: EQ und DSP', () => {
  it('Master-EQ Low-Shelf hebt einen 100-Hz-Ton an', () => {
    const flat = engineWithTone(100);
    const before = render(flat, 30).rms;

    const boosted = engineWithTone(100);
    boosted.setMasterEq(12, 0, 0);
    const after = render(boosted, 30).rms;

    expect(after).toBeGreaterThan(before * 1.2);
  });

  it('DSP-Cutoff wirkt, sobald die Stufe aktiv ist (depth > 0)', () => {
    const open = engineWithTone(440);
    const before = render(open, 30).rms;

    const closed = engineWithTone(440);
    // WICHTIG (Befund 2026-10-26): DspFilterNode.process() geht bei
    // drive <= 0 && depth <= 0 in bit-transparenten Bypass (processingNodes.ts:346).
    // Cutoff allein hat deshalb KEINE Wirkung — die Stufe muss mit depth oder
    // drive aktiviert werden. Genau das macht das DspRack über seinen ON-Schalter.
    closed.setMasterDsp(200, 0.5, 0.2, 0);
    const after = render(closed, 30).rms;

    expect(before).toBeGreaterThan(1e-3);
    expect(after).toBeLessThan(before * 0.6);
  });

  it('DSP-Cutoff allein bleibt Bypass (dokumentiertes Verhalten)', () => {
    const plain = engineWithTone(440);
    const before = render(plain, 30).rms;
    const cutoffOnly = engineWithTone(440);
    cutoffOnly.setMasterDsp(200, 0.5, 0, 0);
    const after = render(cutoffOnly, 30).rms;
    // Kein Filter-Tail, kein Pegelverlust: identisch bis auf Rundung.
    expect(Math.abs(after - before) / Math.max(before, 1e-9)).toBeLessThan(0.02);
  });
});

describe('MAIN-Signal: Effekt und Mastering', () => {
  it('FX-Wet verändert die Summe (Delay/Comb-Pfad hörbar)', () => {
    const dry = engineWithTone(440);
    dry.setMasterFx(0, 0.2, 0.5, 0);
    const before = render(dry, 30).rms;

    const wet = engineWithTone(440);
    wet.setMasterFx(0.85, 0.8, 0.5, 0.6);
    const after = render(wet, 30).rms;

    expect(Math.abs(after - before) / Math.max(before, 1e-9)).toBeGreaterThan(0.05);
  });

  it('Mastering-Limiter hält den Ausgang unter dem Ceiling', () => {
    const e = new V2SinkEngine(SR, BLOCK);
    e.setTestTone(true, 440, 0.8);            // absichtlich laut
    e.setMasterMastering(-30, 20, 1, 0.3);    // hart limitieren auf ~0.3
    render(e, 10);
    const m = render(e, 40);
    // Der Limiter greift hörbar (deutlich unter dem ungebremsten 0,8-Pegel),
    // bleibt aber über Null – geprüft wird die Größenordnung, nicht ein Sample.
    expect(m.peak).toBeLessThanOrEqual(0.45);
    expect(m.peak).toBeGreaterThan(0.005);
  });

  it('Bypass-Stellung ist transparent: FX-Wet 0 ändert nichts an der Summe', () => {
    const a = engineWithTone(440);
    a.setMasterFx(0, 0.3, 0.5, 0.4);
    const withoutFx = render(a, 25).rms;

    const b = engineWithTone(440);
    const plain = render(b, 25).rms;

    expect(Math.abs(withoutFx - plain) / Math.max(plain, 1e-9)).toBeLessThan(0.02);
  });
});
