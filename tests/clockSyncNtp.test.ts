import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/utils/ClockSync';
import { masterClock } from '../src/core/clock/MonastryMasterClock';
import { buildClockPong } from '../server/realtime';

/**
 * Befund 2026-09-19: die NTP-artige Clock-Sync war vollstaendig vorhanden
 * (ClockSync, PLL in der Master-Clock, `handleClockPong`), wurde aber NIE
 * ausgeloest - niemand sendete einen Ping, `syncCount` blieb 0, der Offset damit
 * wirkungslos. Ausserdem mischte `handlePong` zwei Zeitbasen und lieferte deshalb
 * keinen belastbaren Offset; dafuer gibt es jetzt `handleServerPong` mit der
 * Standardformel. Diese Tests halten Formel, Echo und die Anwendung fest.
 */

describe('ClockSync · NTP-Formel', () => {
  it('rechnet Offset und RTT bei symmetrischer Laufzeit korrekt', () => {
    const sync = new ClockSync();
    // Serveruhr laeuft 1000 ms vor der Clientuhr, Hin- und Rueckweg je 10 ms:
    const t0 = 5_000; // Client sendet
    const t1 = 6_010; // Server empfaengt (1000 Offset + 10 Laufzeit)
    const t2 = 6_012; // Server antwortet
    const t3 = 5_022; // Client empfaengt (5_000 + 10 + 2 + 10)
    const offset = sync.handleServerPong(t0, t1, t2, t3);
    expect(offset).toBe(1000);
    expect(sync.getRtt()).toBe(20);
    expect(sync.getSyncedTime() - performance.now()).toBeCloseTo(1000, 0);
  });

  it('verwirft unmoegliche Messungen (RTT < 0) und behaelt den letzten Wert', () => {
    const sync = new ClockSync();
    // rtt = (20 - 0) - 0 = 20 · offset = ((1000 - 0) + (1000 - 20)) / 2 = 990
    expect(sync.handleServerPong(0, 1000, 1000, 20)).toBe(990);
    const before = sync.getRtt();
    // Genuin unmoeglich: die Serverbearbeitung (t2-t1=5) waere laenger als der
    // gesamte Umlauf (t3-t0=2) -> RTT negativ -> Messung verwerfen, Wert behalten.
    expect(sync.handleServerPong(0, 1000, 1005, 2)).toBe(990);
    expect(sync.getRtt()).toBe(before);
  });
});

describe('Server-Echo (buildClockPong)', () => {
  it('spiegelt t0 und setzt t1/t2 auf die Serverzeit', () => {
    const answer = buildClockPong({ t0: 1234.5 }, 99_000);
    expect(answer).toEqual({ t0: 1234.5, t1: 99_000, t2: 99_000 });
  });

  it('ist robust gegen fehlende oder unsinnige t0', () => {
    expect(buildClockPong(undefined, 1).t0).toBe(0);
    expect(buildClockPong({ t0: 'kaputt' }, 1).t0).toBe(0);
    expect(buildClockPong({}, 1).t1).toBe(1);
  });
});

describe('MasterClock.applyServerClock', () => {
  it('zaehlt Messungen, meldet RTT und Drift', () => {
    const start = masterClock.getDiagnostics().syncCount;
    masterClock.applyServerClock({ t0: 0, t1: 1000, t2: 1000, t3: 20 });
    const first = masterClock.getDiagnostics();
    expect(first.syncCount).toBe(start + 1);
    expect(first.serverRttMs).toBe(20);
    // Drift nur ab der zweiten Messung aussagekraeftig.
    masterClock.applyServerClock({ t0: 0, t1: 1010, t2: 1010, t3: 20 });
    const second = masterClock.getDiagnostics();
    expect(second.syncCount).toBe(start + 2);
    expect(second.offsetDriftMs).toBe(10);
  });

  it('ignoriert unvollstaendige Messungen ohne den Zustand zu veraendern', () => {
    const before = masterClock.getDiagnostics();
    masterClock.applyServerClock({ t0: 1, t1: 2 });
    masterClock.applyServerClock({ t0: Number.NaN, t1: 2, t2: 3, t3: 4 });
    expect(masterClock.getDiagnostics().syncCount).toBe(before.syncCount);
  });
});
