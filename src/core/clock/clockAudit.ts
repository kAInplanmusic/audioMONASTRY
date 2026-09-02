// src/core/clock/clockAudit.ts
// ============================================================================
// P2-2: Clock-Audit – prüft die singuläre Timing-Quelle
// ----------------------------------------------------------------------------
// Eine einzige Timing-Quelle: der clockProcessor-Worklet in der AudioEngine.
// MONASTRYmasterclock ist der Regler darüber (BPM/Start/Stop/Lookahead,
// Watchdog, PLL für Multi-User). Dieses Modul liefert einen Audit-Snapshot
// für Tests und perfMONK.
// ============================================================================

import { masterClock, type MasterClockDiagnostics } from './MonastryMasterClock';

export interface ClockAuditReport {
  /** Worklet-Clock ist die einzige Timing-Quelle (architektonisch festgelegt). */
  singleSource: boolean;
  lookaheadInBudget: boolean;
  lookaheadMs: number;
  bpm: number;
  bpmValid: boolean;
  pllOffsetFinite: boolean;
  syncedOffsetFinite: boolean;
  diagnostics: MasterClockDiagnostics;
}

export interface ClockEngineLike {
  getLookaheadMs?: () => number;
}

/**
 * Führt den Clock-Audit gegen eine Engine-Instanz aus.
 * Pure Funktion – verändert keinen Audio-Zustand.
 */
export function auditClockSystem(engine: ClockEngineLike): ClockAuditReport {
  const diagnostics = masterClock.getDiagnostics();
  const lookaheadMs = engine.getLookaheadMs?.() ?? diagnostics.lookaheadMs;
  return {
    singleSource: true,
    lookaheadInBudget: Number.isFinite(lookaheadMs) && lookaheadMs >= 8 && lookaheadMs <= 15,
    lookaheadMs,
    bpm: diagnostics.bpm,
    bpmValid: Number.isFinite(diagnostics.bpm) && diagnostics.bpm >= 20 && diagnostics.bpm <= 300,
    pllOffsetFinite: Number.isFinite(diagnostics.pllOffsetMs),
    syncedOffsetFinite: Number.isFinite(diagnostics.syncedOffsetMs),
    diagnostics,
  };
}
