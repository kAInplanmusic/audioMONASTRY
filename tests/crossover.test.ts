import { describe, expect, it } from 'vitest';
import { Stereo21Crossover } from '../src/core/output/crossover';

/**
 * P2-3 Prüfpunkt (automatisiert): Frequenzanalyse des 2.1-Crossovers.
 * Testtöne 40 Hz (Sub-Bereich) und 1 kHz (L/R-Bereich) werden durch den
 * Linkwitz-Riley-Crossover (90 Hz) gefahren und je Kanal mit Goertzel
 * (exakter Frequenz-Bin) gemessen:
 *   * Sub-Kanal (LFE) enthält < 120 Hz (40 Hz dominant, 1 kHz stark gedämpft)
 *   * L/R enthält 1 kHz und keine „volle Bass-Einbuße“ (phantom mischt Sub zurück)
 */

const SR = 48000;

/** Goertzel-Magnitude für eine Frequenz in einem Float32Array. */
function goertzel(signal: Float32Array, freq: number, sampleRate: number): number {
  const n = signal.length;
  const k = Math.round((freq / sampleRate) * n);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = signal[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

function sine(freq: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amplitude;
  return out;
}

function runCrossover(mode: '2.1' | 'phantom', signal: Float32Array) {
  const x = new Stereo21Crossover(SR, 90, mode);
  const { left, lfe } = x.process(signal, signal);
  return { left, lfe };
}

describe('P2-3 Prüfpunkt: 2.1-Crossover Frequenzanalyse', () => {
  it('40-Hz-Testton liegt im Sub-Kanal (< 120 Hz), L/R wird hochpassgefiltert', () => {
    const sig = sine(40, 1.0);
    const { left, lfe } = runCrossover('2.1', sig);

    const lfe40 = goertzel(lfe, 40, SR);
    const lfe1000 = goertzel(lfe, 1000, SR);
    const left40 = goertzel(left, 40, SR);
    const left1000 = goertzel(left, 1000, SR);

    // Sub-Kanal: 40 Hz dominant, 1 kHz stark gedämpft.
    expect(lfe40).toBeGreaterThan(lfe1000 * 20);
    // L/R: Hochpass lässt 40 Hz deutlich gedämpft durch (kein Vollbass auf L/R),
    // aber nicht komplett still (Linkwitz-Riley-Flanke, keine harte Stummschaltung).
    expect(left40).toBeLessThan(lfe40 * 0.5);
    expect(left40).toBeGreaterThan(0);
    expect(left1000).toBeLessThan(lfe40); // 1 kHz ist im Sub praktisch nicht vorhanden
  });

  it('1-kHz-Testton bleibt auf L/R, Sub-Kanal dämpft ihn stark', () => {
    const sig = sine(1000, 0.5);
    const { left, lfe } = runCrossover('2.1', sig);

    const lfe1000 = goertzel(lfe, 1000, SR);
    const left1000 = goertzel(left, 1000, SR);
    expect(left1000).toBeGreaterThan(lfe1000 * 20);
  });

  it('Phantom-Modus mischt den Sub-Anteil zurück in L/R (keine volle Bass-Einbuße)', () => {
    const sig = sine(40, 1.0);
    const phantom = runCrossover('phantom', sig);
    const dedicated = runCrossover('2.1', sig);

    const phantomBass = goertzel(phantom.left, 40, SR);
    const dedicatedBass = goertzel(dedicated.left, 40, SR);
    // Phantom behält den Bass in L/R; 2.1 verschiebt ihn auf den Sub-Kanal.
    expect(phantomBass).toBeGreaterThan(dedicatedBass * 1.5);
    expect(phantom.lfe.reduce((a, b) => a + Math.abs(b), 0)).toBe(0);
  });

  it('Determinismus + NaN/Inf-Sicherheit', () => {
    const sig = sine(55, 0.25);
    const a = new Stereo21Crossover(SR, 100, '2.1');
    const b = new Stereo21Crossover(SR, 100, '2.1');
    const ra = a.process(sig, sig);
    const rb = b.process(sig, sig);
    for (let i = 0; i < sig.length; i++) {
      expect(ra.left[i]).toBe(rb.left[i]);
      expect(ra.lfe[i]).toBe(rb.lfe[i]);
      expect(Number.isFinite(ra.lfe[i])).toBe(true);
    }
  });

  it('Crossover-Frequenz wird geclampt (40–200 Hz)', () => {
    expect(new Stereo21Crossover(SR, 20).crossoverHz).toBe(40);
    expect(new Stereo21Crossover(SR, 500).crossoverHz).toBe(200);
  });
});
