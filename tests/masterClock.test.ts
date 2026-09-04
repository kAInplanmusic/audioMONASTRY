import { describe, expect, it } from 'vitest';
import { MasterClock } from '../src/core/clock/MasterClock';

describe('MONASTRYmasterclock (NEW-MONK-8, Steuerlogik)', () => {
  it('klemmt BPM auf 30–300 und startet/stoppt', () => {
    const c = new MasterClock();
    c.setBpm(999);
    expect(c.snapshot.bpm).toBe(300);
    c.setBpm(1);
    expect(c.snapshot.bpm).toBe(30);
    c.start();
    expect(c.snapshot.playing).toBe(true);
    c.stop();
    expect(c.snapshot.playing).toBe(false);
  });

  it('hält das Latenz-Budget 8–15 ms ein', () => {
    const c = new MasterClock();
    c.reportLatency(2);
    expect(c.snapshot.lookaheadMs).toBe(8);
    c.reportLatency(40);
    expect(c.snapshot.lookaheadMs).toBe(15);
    c.reportLatency(6);
    expect(c.snapshot.lookaheadMs).toBe(12);
  });

  it('Watchdog: Dropout-Burst löst Recovery aus und erhöht Lookahead', () => {
    const c = new MasterClock({ maxDropoutRate: 2 });
    expect(c.reportDropout(1000)).toBe(false);
    expect(c.reportDropout(1001)).toBe(false);
    expect(c.reportDropout(1002)).toBe(true);
    expect(c.snapshot.recovered).toBe(1);
    expect(c.snapshot.lastError).toContain('dropout-burst');
    expect(c.snapshot.lookaheadMs).toBeGreaterThan(10);
  });
});
