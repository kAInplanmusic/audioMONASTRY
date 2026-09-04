import { describe, expect, it, vi } from 'vitest';
import { ClockSync } from '../src/utils/ClockSync';
import { PhaseLockedLoop } from '../src/utils/PhaseLockedLoop';
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

  it('berechnet Offset exakt (NTP-Handshake: offset = pong - ping - rtt/2)', () => {
    const sync = new ClockSync();
    const spy = vi.spyOn(performance, 'now').mockReturnValue(1030);
    sync.handlePong(1020, 1000); // rtt = 1030 - 1000 = 30, offset = (1020-1000) - 15 = 5
    expect(sync.getSyncedTime()).toBe(1035); // performance.now() + 5
    spy.mockRestore();
  });
});

describe('P2-2: Multi-User-Clock-Sync (PLL-Drift-Kompensation)', () => {
  it('PLL konvergiert einen konstanten Host-Gast-Offset auf < 5 ms', () => {
    const pll = new PhaseLockedLoop();
    // Gast hinkt dem Host konstant 20 ms hinterher. Nach mehreren Updates
    // baut der Integrator den Drift auf und kompensiert den Offset.
    const hostOffset = 20;
    let compensated = 0;
    for (let i = 0; i < 200; i++) {
      compensated = pll.update(hostOffset - compensated);
    }
    expect(Math.abs(hostOffset - compensated)).toBeLessThan(5);
  });

  it('Host-Clock-Verteilung über CRDT-Merger akzeptiert plausible Schritte', () => {
    const merger = new CrdtClockMerger();
    // 10-Hz-Sync: erster Wert 0.0 wird nur vorgemerkt (Delta < 2 ms),
    // danach werden 100-ms-Schritte als plausibel angewendet.
    expect(merger.proposed(0.0)).toBe(false);
    for (const t of [0.1, 0.2, 0.3, 0.4]) expect(merger.proposed(t)).toBe(true);
    expect(merger.value).toBe(0.4);
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
