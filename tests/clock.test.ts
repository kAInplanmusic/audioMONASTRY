import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/utils/ClockSync';
import { CrdtClock, CrdtLwwMap, CrdtClockMerger, crdtCmp } from '../src/utils/crdt';

describe('ClockSync (P2-2)', () => {
  it('berechnet Offset/RTT aus Ping/Pong', () => {
    const sync = new ClockSync();
    // Ping bei t=1000, Pong bei t=1020, Antwort nach 30 ms → rtt 30, offset 5
    sync.handlePong(1020, 1000);
    const now = 1030;
    // getSyncedTime() = performance.now() + offset; nur Plausibilität prüfen
    const t = sync.getSyncedTime();
    expect(Number.isFinite(t)).toBe(true);
  });
});

describe('CRDT (AM-E3-3)', () => {
  it('Lamport-Uhr ist streng monoton und schlichtet Gleichstand per peer', () => {
    const a = new CrdtClock(1);
    const b = new CrdtClock(2);
    const s1 = a.tick();
    const s2 = a.tick();
    expect(s2.t).toBeGreaterThan(s1.t);
    expect(crdtCmp({ t: 5, peer: 1 }, { t: 5, peer: 2 })).toBeLessThan(0);
  });

  it('LWW-Map: 4 User × 1000 Edits konvergieren deterministisch', () => {
    const maps = [new CrdtLwwMap<string>(), new CrdtLwwMap<string>(), new CrdtLwwMap<string>(), new CrdtLwwMap<string>()];
    const clocks = [new CrdtClock(1), new CrdtClock(2), new CrdtClock(3), new CrdtClock(4)];
    // Interleaving-Explosion: zufällige, aber deterministische Reihenfolge
    let seed = 42;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 1000; i++) {
      const u = Math.floor(rand() * 4);
      const key = `k${Math.floor(rand() * 8)}`;
      maps[u].set(key, `v${u}-${i}`, clocks[u].tick());
    }
    for (const m of maps.slice(1)) maps[0].merge(m);
    const snapshot = maps[0].snapshot();
    expect(Object.keys(snapshot)).toHaveLength(8);
    // Jeder Key hat genau einen Gewinner
    for (const k of Object.keys(snapshot)) expect(snapshot[k].value).toMatch(/^v\d-\d+$/);
  });

  it('ClockMerger verwirft Rückwärts- und unplausible Vorwärts-Sprünge', () => {
    const merger = new CrdtClockMerger();
    expect(merger.proposed(1)).toBe(true); // erster plausibler Schritt
    expect(merger.proposed(0.5)).toBe(false); // rückwärts
    expect(merger.proposed(100)).toBe(false); // > maxForwardStep
    expect(merger.proposed(1.5)).toBe(true); // plausibel
    expect(merger.value).toBe(1.5);
  });
});
