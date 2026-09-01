// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { MonastryMasterClock } from '../src/core/clock/MonastryMasterClock';

function makeEngine() {
  return {
    setBpm: vi.fn(),
    setSwing: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    reportXrun: vi.fn(),
    setIdleSilence: vi.fn(),
    getLookaheadMs: vi.fn(() => 12),
    getAudioHealth: vi.fn(() => ({ state: 'running', sampleRate: 48000, baseLatencyMs: 6, outputLatencyMs: 4 })),
  };
}

describe('MonastryMasterClock (NEW-MONK-8)', () => {
  it('setzt BPM sicher (20..300) und reicht Swing an die Engine weiter', () => {
    const clock = new MonastryMasterClock();
    const engine = makeEngine();
    clock.attach(engine);

    clock.setBpm(999);
    expect(clock.getBpm()).toBe(300);
    clock.setBpm(10);
    expect(clock.getBpm()).toBe(20);
    clock.setSwing(0.5);
    expect(engine.setSwing).toHaveBeenCalledWith(0.5);
    clock.detach();
  });

  it('start/stop delegiert an die Engine und meldet Xruns', async () => {
    const clock = new MonastryMasterClock();
    const engine = makeEngine();
    clock.attach(engine);

    await clock.start();
    expect(engine.play).toHaveBeenCalled();
    clock.stop();
    expect(engine.stop).toHaveBeenCalled();

    clock.reportXrun();
    expect(engine.reportXrun).toHaveBeenCalled();
    expect(clock.getDiagnostics().xruns).toBe(1);
    clock.detach();
  });

  it('NaN/Inf-Guard verwirft ungültige Samples', () => {
    const clock = new MonastryMasterClock();
    expect(clock.isHealthySample(0.5)).toBe(true);
    expect(clock.isHealthySample(Number.NaN)).toBe(false);
    expect(clock.isHealthySample(Number.POSITIVE_INFINITY)).toBe(false);
    expect(clock.isHealthySample(99)).toBe(false);
  });

  it('Watchdog heilt stillen Audio-Ausfall (State != running)', () => {
    vi.useFakeTimers();
    try {
      const clock = new MonastryMasterClock();
      const engine = makeEngine();
      engine.getAudioHealth.mockReturnValue({ state: 'suspended' } as never);
      clock.attach(engine);
      void clock.start();
      vi.advanceTimersByTime(10_000);
      expect(engine.play.mock.calls.length).toBeGreaterThanOrEqual(2);
      clock.detach();
    } finally {
      vi.useRealTimers();
    }
  });
});
