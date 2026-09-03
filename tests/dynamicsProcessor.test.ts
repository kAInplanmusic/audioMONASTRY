import { describe, it, expect } from 'vitest';
import {
  DynamicsProcessor, compressorCurveDb, smoothingCoefficient, toDb, fromDb,
} from '../src/audio/worklets/dynamicsProcessor';

const SR = 48000;
const BLOCK = 128;

function makeBlock(length = BLOCK, channels = 2): Float32Array[] {
  return Array.from({ length: channels }, () => new Float32Array(length));
}

/** Rendert ein Mono-Signal (auf beide Kanäle gelegt) blockweise. */
function render(proc: DynamicsProcessor, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let pos = 0; pos < input.length; pos += BLOCK) {
    const len = Math.min(BLOCK, input.length - pos);
    const inBlock = makeBlock(len);
    inBlock[0].set(input.subarray(pos, pos + len));
    inBlock[1].set(input.subarray(pos, pos + len));
    const outBlock = makeBlock(len);
    proc.process([inBlock], [outBlock]);
    out.set(outBlock[0], pos);
  }
  return out;
}

function sine(freq: number, amplitude: number, frames: number): Float32Array {
  const buf = new Float32Array(frames);
  for (let i = 0; i < frames; i++) buf[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amplitude;
  return buf;
}

/** Spitzenwert der zweiten Signalhälfte (eingeschwungener Zustand). */
function steadyPeak(buf: Float32Array): number {
  let peak = 0;
  for (let i = Math.floor(buf.length / 2); i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

describe('Echtzeit-Dynamik · Hilfsfunktionen', () => {
  it('rechnet dB ↔ linear NaN-sicher', () => {
    expect(toDb(1)).toBeCloseTo(0, 6);
    expect(toDb(0.1)).toBeCloseTo(-20, 6);
    expect(toDb(0)).toBe(-120);
    expect(toDb(Number.NaN)).toBe(-120);
    expect(fromDb(0)).toBeCloseTo(1, 6);
    expect(fromDb(-6)).toBeCloseTo(0.5011872, 5);
    expect(fromDb(Number.NaN)).toBe(1);
  });

  it('liefert stabile One-Pole-Koeffizienten', () => {
    expect(smoothingCoefficient(0.01, SR)).toBeGreaterThan(0);
    expect(smoothingCoefficient(0.01, SR)).toBeLessThan(1);
    expect(smoothingCoefficient(0, SR)).toBe(1);
    expect(smoothingCoefficient(Number.NaN, SR)).toBe(1);
  });

  it('hat eine stetige Soft-Knee-Kennlinie', () => {
    const th = -20, ratio = 4, knee = 6;
    expect(compressorCurveDb(-40, th, ratio, knee)).toBeCloseTo(-40, 6); // unterhalb
    expect(compressorCurveDb(-12, th, ratio, knee)).toBeCloseTo(-18, 6); // -20 + 8/4
    // Im Knee-Bereich liegt die Kurve zwischen 1:1 und der harten Kennlinie.
    const inKnee = compressorCurveDb(-20, th, ratio, knee);
    expect(inKnee).toBeLessThan(-20 + 1e-9);
    expect(inKnee).toBeGreaterThan(compressorCurveDb(-20, th, ratio, 0) - 1);
    // Stetigkeit an den Knee-Grenzen.
    expect(compressorCurveDb(-23.001, th, ratio, knee)).toBeCloseTo(-23.001, 3);
    expect(compressorCurveDb(-17, th, ratio, knee)).toBeCloseTo(-20 + 3 / 4, 3);
  });
});

describe('Echtzeit-Dynamik · Worklet-Verhalten', () => {
  it('ist per Default Bypass und liefert das Eingangssignal bit-genau', () => {
    const proc = new DynamicsProcessor();
    const input = sine(1000, 0.5, SR / 4);
    const out = render(proc, input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it('komprimiert einen -20-dBFS-Sinus oberhalb des Thresholds', () => {
    const proc = new DynamicsProcessor();
    proc.handleMessage({ enabled: true });
    proc.handleMessage({
      compressor: { threshold: -30, ratio: 4, knee: 0, attack: 0.005, release: 0.05, makeup: 0 },
    });
    const amp = fromDb(-20); // -20 dBFS
    const out = render(proc, sine(1000, amp, SR));
    const peakDb = toDb(steadyPeak(out));
    // Erwartung: -30 + 10/4 = -27,5 dBFS (Detektor-Ripple toleriert).
    expect(peakDb).toBeGreaterThan(-29);
    expect(peakDb).toBeLessThan(-26);
    expect(proc.getGainReductionDb()).toBeGreaterThan(5);
  });

  it('lässt Signale unterhalb des Thresholds unangetastet', () => {
    const proc = new DynamicsProcessor();
    proc.handleMessage({ enabled: true });
    proc.handleMessage({ compressor: { threshold: -12, ratio: 8, knee: 0 } });
    const amp = fromDb(-30);
    const out = render(proc, sine(1000, amp, SR / 2));
    expect(toDb(steadyPeak(out))).toBeCloseTo(-30, 1);
    expect(proc.getGainReductionDb()).toBeLessThan(0.1);
  });

  it('wendet Make-up-Gain an', () => {
    const proc = new DynamicsProcessor();
    proc.handleMessage({ enabled: true });
    proc.handleMessage({ compressor: { threshold: 0, ratio: 1, knee: 0, makeup: 6 } });
    const out = render(proc, sine(1000, fromDb(-20), SR / 2));
    expect(toDb(steadyPeak(out))).toBeCloseTo(-14, 1);
  });

  it('schließt das Gate unterhalb des Thresholds und öffnet darüber', () => {
    const proc = new DynamicsProcessor();
    proc.handleMessage({ enabled: true });
    proc.handleMessage({ compressor: { threshold: 0, ratio: 1, knee: 0 } });
    proc.handleMessage({
      gate: { enabled: true, threshold: -30, range: 40, attack: 0.001, hold: 0.005, release: 0.02, hysteresis: 3 },
    });

    const quiet = render(proc, sine(1000, fromDb(-50), SR / 2));
    const quietDb = toDb(steadyPeak(quiet));
    expect(quietDb).toBeLessThan(-80); // -50 dBFS − 40 dB Range
    expect(proc.getGateGain()).toBeLessThan(0.05);

    const loud = render(proc, sine(1000, fromDb(-10), SR / 2));
    expect(toDb(steadyPeak(loud))).toBeCloseTo(-10, 1);
    expect(proc.getGateGain()).toBeGreaterThan(0.95);
  });

  it('hält das Gate innerhalb der Hysterese offen', () => {
    const proc = new DynamicsProcessor();
    proc.handleMessage({ enabled: true });
    proc.handleMessage({ compressor: { threshold: 0, ratio: 1, knee: 0 } });
    proc.handleMessage({
      gate: { enabled: true, threshold: -30, range: 60, attack: 0.001, hold: 0, release: 0.05, hysteresis: 6 },
    });
    render(proc, sine(1000, fromDb(-10), SR / 4));   // Gate öffnet
    render(proc, sine(1000, fromDb(-32), SR / 4));   // zwischen Close und Open
    expect(proc.getGateGain()).toBeGreaterThan(0.9); // bleibt offen (Hysterese)
    render(proc, sine(1000, fromDb(-50), SR / 2));   // unter Close-Threshold
    expect(proc.getGateGain()).toBeLessThan(0.05);
  });

  it('senkt eine Resonanz nur bei Pegelüberschreitung (Dynamic EQ)', () => {
    const build = () => {
      const p = new DynamicsProcessor();
      p.handleMessage({ enabled: true });
      p.handleMessage({ compressor: { threshold: 0, ratio: 1, knee: 0 } });
      p.handleMessage({
        dynEq: { enabled: true, freq: 3000, q: 4, threshold: -20, ratio: 6, range: 12 },
      });
      return p;
    };

    const loud = build();
    const loudOut = render(loud, sine(3000, fromDb(-6), SR));
    expect(loud.getDynEqGainDb()).toBeLessThan(-3);
    expect(toDb(steadyPeak(loudOut))).toBeLessThan(-7);

    const quiet = build();
    const quietOut = render(quiet, sine(3000, fromDb(-40), SR / 2));
    expect(quiet.getDynEqGainDb()).toBeGreaterThan(-0.5);
    expect(toDb(steadyPeak(quietOut))).toBeCloseTo(-40, 0);
  });

  it('bleibt NaN/Inf-frei bei entarteten Eingaben', () => {
    const proc = new DynamicsProcessor();
    proc.handleMessage({ enabled: true });
    proc.handleMessage({ gate: { enabled: true }, dynEq: { enabled: true } });
    const input = new Float32Array(BLOCK * 4);
    input.fill(Number.NaN, 0, BLOCK);
    input.fill(Number.POSITIVE_INFINITY, BLOCK, BLOCK * 2);
    input.fill(8, BLOCK * 2, BLOCK * 3);
    const out = render(proc, input);
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(4);
    }
  });

  it('ignoriert ungültige Parameter und rampt Werte sample-genau', () => {
    const proc = new DynamicsProcessor();
    proc.handleMessage({ enabled: true });
    proc.handleMessage({ compressor: { threshold: Number.NaN, ratio: 'x' as any } });
    proc.handleMessage({ compressor: { threshold: -24, ratio: 2, knee: 0, makeup: 0 } });
    proc.handleMessage({ type: 'automate', param: 'makeup', value: 6, rampTime: 0.01 });
    const out = render(proc, sine(1000, fromDb(-40), SR / 4));
    expect(toDb(steadyPeak(out))).toBeCloseTo(-34, 1);
    // Unbekannte Parameter dürfen nichts verändern.
    expect(() => proc.handleMessage({ type: 'automate', param: 'nope', value: 1 })).not.toThrow();
  });

  it('leert den Zustand auf reset und gibt bei fehlendem Input Stille aus', () => {
    const proc = new DynamicsProcessor();
    proc.handleMessage({ enabled: true, gate: { enabled: true, threshold: -30 } });
    render(proc, sine(1000, 0.5, SR / 4));
    proc.handleMessage({ reset: true });
    expect(proc.getGateGain()).toBe(0);
    expect(proc.getGainReductionDb()).toBe(0);

    const outBlock = makeBlock();
    outBlock[0].fill(0.7);
    proc.process([[]], [outBlock]);
    expect(outBlock[0].every((v) => v === 0)).toBe(true);
  });
});
