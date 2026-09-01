// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { controlBus, ControlBus } from '../src/core/events/ControlBus';
import { RbacCache } from '../src/utils/RbacCache';
import { JitterBufferEstimator } from '../src/utils/JitterBufferEstimator';
import { computeLowpassCoefficients } from '../src/audio/dsp/biquad';
import { validateRoutingAgainstGraph } from '../src/core/routing/validateRouting';
import { midiLed, midiMotorFader, midiEncoderRing, midiNoteOn } from '../src/utils/midiOut';

describe('ControlBus (AM-E2-2)', () => {
  it('verteilt typisierte Events und de-registriert sauber', () => {
    const bus = new ControlBus();
    const seen: string[] = [];
    const off = bus.on<string>('monk:test', (p) => seen.push(p));
    bus.emit('monk:test', 'a');
    off();
    bus.emit('monk:test', 'b');
    expect(seen).toEqual(['a']);
  });

  it('globaler Bus emittiert auch window-Events (Kompatibilität)', () => {
    const seen: unknown[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('monk:test2', handler);
    controlBus.emit('monk:test2', { x: 1 });
    window.removeEventListener('monk:test2', handler);
    expect(seen).toEqual([{ x: 1 }]);
  });
});

describe('RbacCache (AM-E3-2)', () => {
  it('Lease läuft ab und kann erneuert werden', () => {
    const cache = new RbacCache(1000);
    cache.set({ userId: 'u1', role: 'DJ', permissions: ['lock'], expiresAt: 5000 });
    expect(cache.can('u1', 'lock', 4000)).toBe(true);
    expect(cache.can('u1', 'lock', 6000)).toBe(false); // abgelaufen
    cache.set({ userId: 'u2', role: 'Producer', permissions: ['lock'], expiresAt: 10_000 });
    expect(cache.touch('u2', 9500)).toBe(true);
    expect(cache.can('u2', 'lock', 10_100)).toBe(true); // Lease verlängert
  });
});

describe('JitterBufferEstimator (AM-E3-4)', () => {
  it('empfiehlt größeren Buffer bei Jitter', () => {
    const est = new JitterBufferEstimator();
    const base = est.report(1000, 1020);
    est.report(2000, 2020);
    est.report(3000, 3020);
    const stable = est.recommendedBufferMs();
    est.report(4000, 4100); // 100 ms Transit-Sprung
    const jittered = est.recommendedBufferMs();
    expect(base).toBeGreaterThanOrEqual(20);
    expect(stable).toBeLessThanOrEqual(200);
    expect(jittered).toBeGreaterThan(stable);
  });
});

describe('Biquad (AM-E4-3)', () => {
  it('bleibt an den Rändern stabil und endlich', () => {
    for (const f of [0, 1, 24000, 23999, NaN]) {
      const c = computeLowpassCoefficients(f, 0.707, 48000);
      for (const v of c) expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(c[3])).toBeLessThanOrEqual(2);
      expect(Math.abs(c[4])).toBeLessThanOrEqual(1);
    }
  });
});

describe('Routing-Validierung (P2-4)', () => {
  it('findet fehlende Nodes/Connections und Duplikate', () => {
    const graph = {
      nodes: [{ id: 'a' }, { id: 'b' }],
      connections: [{ source: 'a', target: 'b' }],
    };
    const errors = validateRoutingAgainstGraph(
      {
        nodes: [{ id: 'a' }, { id: 'ghost' }],
        connections: [{ source: 'a', target: 'b' }, { source: 'a', target: 'b' }, { source: 'b', target: 'ghost' }],
      },
      graph,
    );
    expect(errors.some((e) => e.includes('ghost'))).toBe(true);
    expect(errors.some((e) => e.includes('doppelte'))).toBe(true);
  });
});

describe('MIDI-Out (P1-6)', () => {
  it('kodiert LEDs, Motorfader und Encoder-Ring', () => {
    expect(midiNoteOn(1, 60, 100)).toEqual([0x90, 60, 100]);
    expect(midiLed(1, 60, true, 5)).toEqual([0x90, 60, 5]);
    expect(midiLed(1, 60, false)).toEqual([0x90, 60, 0]);
    expect(midiMotorFader(1, 1)).toEqual([0xe0, 0x7f, 0x7f]);
    expect(midiMotorFader(1, 0)).toEqual([0xe0, 0, 0]);
    expect(midiEncoderRing(1, 7, 100)).toEqual([0xb0, 7, 100]);
  });
});
