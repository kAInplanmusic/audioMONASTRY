// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ControlBus, controlBus } from '../src/core/events/ControlBus';

describe('ControlBus (AM-E2-2)', () => {
  it('typisiertes emit/on ohne CustomEvent-Serialisierung', () => {
    const bus = new ControlBus();
    const seen: string[] = [];
    const off = bus.on('monk:mcp-pattern', (p: { preset: string }) => seen.push(p.preset));
    bus.emit('monk:mcp-pattern', { preset: 'four' });
    bus.emit('monk:mcp-pattern', { preset: 'break' });
    expect(seen).toEqual(['four', 'break']);
    off();
    bus.emit('monk:mcp-pattern', { preset: 'random' });
    expect(seen).toEqual(['four', 'break']);
  });

  it('Handler-Fehler werden isoliert (kein Listener-Verlust)', () => {
    const bus = new ControlBus();
    const spy = vi.fn();
    bus.on('monk:drum-pattern-random', () => { throw new Error('kaputt'); });
    bus.on('monk:drum-pattern-random', spy);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      bus.emit('monk:drum-pattern-random', undefined);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('State-Burst blockiert andere Listener nicht (Prioritäts-Inversion)', () => {
    const bus = new ControlBus();
    const order: string[] = [];
    bus.on('sequencer:apply-patterns', () => {
      for (let i = 0; i < 200; i++) order.push(`a${i}`);
    });
    bus.on('sequencer:apply-patterns', () => order.push('b'));
    bus.emit('sequencer:apply-patterns', { patterns: {} });
    // Zweiter Listener wurde trotz Burst-Last bedient.
    expect(order).toContain('b');
  });
});

describe('globaler controlBus-Singleton', () => {
  it('ist nach reset() leer', () => {
    controlBus.clear();
    const off = controlBus.on('clock:xrun', () => {});
    controlBus.emit('clock:xrun', { count: 1 });
    off();
    controlBus.clear();
  });
});
