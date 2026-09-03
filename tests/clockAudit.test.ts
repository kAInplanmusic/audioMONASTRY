// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { auditClockSystem } from '../src/core/clock/clockAudit';
import { masterClock } from '../src/core/clock/MonastryMasterClock';

describe('P2-2: Clock-Audit (eine Timing-Quelle, Worklet-Clock)', () => {
  it('bewertet das Lookahead-Budget 8–15 ms korrekt', () => {
    expect(auditClockSystem({ getLookaheadMs: () => 15 }).lookaheadInBudget).toBe(true);
    expect(auditClockSystem({ getLookaheadMs: () => 8 }).lookaheadInBudget).toBe(true);
    expect(auditClockSystem({ getLookaheadMs: () => 25 }).lookaheadInBudget).toBe(false);
    expect(auditClockSystem({ getLookaheadMs: () => 5 }).lookaheadInBudget).toBe(false);
  });

  it('meldet die singuläre Timing-Quelle und validiert BPM', () => {
    masterClock.setBpm(140);
    const report = auditClockSystem({ getLookaheadMs: () => 12 });
    expect(report.singleSource).toBe(true);
    expect(report.bpm).toBe(140);
    expect(report.bpmValid).toBe(true);
    expect(report.lookaheadMs).toBe(12);
  });

  it('PLL-/Sync-Offsets sind nach Host-Pong endlich', () => {
    masterClock.handleClockPong(2000, 1000);
    const report = auditClockSystem({});
    expect(report.pllOffsetFinite).toBe(true);
    expect(report.syncedOffsetFinite).toBe(true);
  });

  it('Diagnose-Snapshot enthält alle relevanten Felder', () => {
    const diagnostics = masterClock.getDiagnostics();
    expect(typeof diagnostics.bpm).toBe('number');
    expect(typeof diagnostics.playing).toBe('boolean');
    expect(typeof diagnostics.lookaheadMs).toBe('number');
    expect(typeof diagnostics.xruns).toBe('number');
    expect(typeof diagnostics.watchdogs).toBe('number');
    expect(typeof diagnostics.pllOffsetMs).toBe('number');
    expect(typeof diagnostics.syncedOffsetMs).toBe('number');
  });
});
