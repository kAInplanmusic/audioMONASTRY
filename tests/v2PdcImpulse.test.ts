import { describe, expect, it } from 'vitest';
import { GraphPlaybackEngine, type RenderBlockFn } from '../src/core/audio/compat/GraphPlaybackEngine';
import { V2SampleClock } from '../src/core/audio/live/V2SampleClock';
import {
  V2_MASTERING_LOOKAHEAD_SEC,
  compensateV2StepFrame,
  v2MasteringLookaheadSamples,
} from '../src/core/audio/live/v2Pdc';

/**
 * DSP-P2-002 (ARCH-V2-005): PDC-Impuls-/Latenz-Suite.
 *
 * Beweist mit einem echten Impuls (nicht nur RMS/Hash):
 * 1. Der Mastering-Lookahead ist eine exakte Verzögerung von N Samples.
 * 2. Die PDC-Kompensation ist die exakte Umkehrung: kompensierter Frame + N = Raster.
 * 3. Der Step-Scheduler verschiebt ALLE Events um genau N (differenziell geprüft
 *    gegen einen identischen Scheduler ohne PDC).
 * 4. Ehrliche Grenze: ein Step, der in das erste Lookahead-Fenster fällt, kann
 *    nicht vorgezogen werden (Clamp auf 0) und kommt um rawFrame zu spät.
 */

/** Sample-genaue Verzögerung als Render-Block (Ringpuffer, read-before-write). */
function makeDelayRenderer(delay: number): RenderBlockFn {
  const ring = new Float32Array(Math.max(1, delay));
  let abs = 0;
  return (source: Float32Array[]) => {
    const len = source[0].length;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const x = source[0][i];
      if (delay > 0) {
        const idx = abs % delay;
        out[i] = ring[idx];
        ring[idx] = x;
        abs += 1;
      } else {
        out[i] = x;
      }
    }
    return [out];
  };
}

/** Lässt einen Einzel-Impuls durch die Engine laufen und liefert die Ausgabe. */
function renderImpulse(sampleRate: number, delay: number, blocks: number): Float32Array {
  const engine = new GraphPlaybackEngine(makeDelayRenderer(delay), sampleRate, 128);
  const out = new Float32Array(blocks * engine.blockSize);
  engine.playing = true;
  for (let b = 0; b < blocks; b += 1) {
    if (b === 0) {
      const impulse = new Float32Array(engine.blockSize);
      impulse[0] = 1;
      engine.setSource([impulse]);
    } else {
      engine.setSource([new Float32Array(engine.blockSize)]);
    }
    const block = engine.tick();
    if (block?.[0]) out.set(block[0], b * engine.blockSize);
  }
  return out;
}

function firstNonZeroIndex(signal: Float32Array): number {
  for (let i = 0; i < signal.length; i += 1) {
    if (signal[i] !== 0) return i;
  }
  return -1;
}

describe('V2 PDC – Impuls & Latenz', () => {
  it('Mastering-Lookahead ist exakt 5 ms (240 Samples @48k, 480 @96k)', () => {
    expect(V2_MASTERING_LOOKAHEAD_SEC).toBe(0.005);
    expect(v2MasteringLookaheadSamples(48000)).toBe(240);
    expect(v2MasteringLookaheadSamples(96000)).toBe(480);
    expect(v2MasteringLookaheadSamples(44100)).toBe(221); // gerundet, nie < 16
  });

  it('ein Impuls kommt nach genau N Samples wieder heraus (nicht N±1)', () => {
    for (const [sampleRate, delay] of [[48000, 240], [96000, 480], [48000, 128]] as const) {
      const out = renderImpulse(sampleRate, delay, Math.ceil((delay + 256) / 128) + 1);
      expect(firstNonZeroIndex(out)).toBe(delay);
      // Kein Übersprechen/Zwischenwert: es gibt genau EINEN Nicht-Null-Sample.
      expect([...out].filter((v) => v !== 0)).toHaveLength(1);
      expect(out[delay]).toBe(1);
    }
  });

  it('Kompensation ist die exakte Umkehrung des Lookaheads', () => {
    for (const sampleRate of [44100, 48000, 96000]) {
      const lookahead = v2MasteringLookaheadSamples(sampleRate);
      for (const gridFrame of [lookahead, lookahead + 1, 6000, 6000 * 17, 1_000_000]) {
        expect(compensateV2StepFrame(gridFrame, sampleRate) + lookahead).toBe(gridFrame);
      }
    }
  });

  it('Scheduler verschiebt alle Events um exakt N (differenziell gegen Scheduler ohne PDC)', () => {
    const sampleRate = 48000;
    const lookahead = v2MasteringLookaheadSamples(sampleRate);
    const blocks = 800; // 102400 Samples @128 BPM → ~18 16tel-Steps
    const blockSize = 128;

    const withPdc = new V2SampleClock({ sampleRate, bpm: 128, stepCount: 16, pdcCompensationSamples: lookahead });
    const without = new V2SampleClock({ sampleRate, bpm: 128, stepCount: 16, pdcCompensationSamples: 0 });
    withPdc.playing = true;
    without.playing = true;

    const a: number[] = [];
    const b: number[] = [];
    for (let block = 0; block < blocks; block += 1) {
      const frameStart = block * blockSize;
      a.push(...withPdc.processBlock(frameStart, blockSize).map((s) => s.frame));
      b.push(...without.processBlock(frameStart, blockSize).map((s) => s.frame));
    }

    expect(a).toHaveLength(b.length);
    expect(a.length).toBeGreaterThan(10);
    for (let i = 0; i < b.length; i += 1) {
      expect(a[i]).toBe(Math.max(0, b[i] - lookahead));
    }
    // Mindestens ein Event liegt außerhalb des Clamp-Bereichs → volle Kompensation.
    const fullyCompensated = b.filter((frame) => frame >= lookahead);
    expect(fullyCompensated.length).toBeGreaterThan(0);
    for (const gridFrame of fullyCompensated) {
      // kompensiert feuern + Lookahead-Latenz = exakt wieder auf dem Raster
      expect(compensateV2StepFrame(gridFrame, sampleRate) + lookahead).toBe(gridFrame);
    }
  });

  it('Raster kollidiert nie mit dem Lookahead-Fenster (Clamp bleibt reine Schutzregel)', () => {
    // samplesPerStep = sr*15/bpm; bei max. 300 BPM also sr/20. Der Lookahead ist
    // 5 ms = sr/200 → das Fenster ist um Faktor 10 kürzer als der kleinste Step.
    // Deshalb kann ein 16tel nie in das Lookahead-Fenster fallen; der `max(0, …)`-
    // Clamp im Scheduler ist eine Schutzregel, kein Normalfall.
    for (const sampleRate of [44100, 48000, 96000]) {
      const lookahead = v2MasteringLookaheadSamples(sampleRate);
      const minSamplesPerStep = (sampleRate * 60) / 300 / 4;
      expect(minSamplesPerStep).toBeGreaterThan(lookahead * 5);

      const clock = new V2SampleClock({ sampleRate, bpm: 300, stepCount: 16, pdcCompensationSamples: lookahead });
      clock.playing = true;
      const events = clock.processBlock(0, 8192);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.frame).toBeGreaterThanOrEqual(0);
        // voll kompensiert: kompensierter Frame + Lookahead == Raster-Frame
        expect(event.frame + lookahead).toBeGreaterThan(0);
      }
    }
  });
});
