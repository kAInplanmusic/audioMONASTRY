import { describe, expect, it } from 'vitest';
import {
  BUDGET_MS,
  MAX_OUTLIER_RATIO,
  choosePass,
  summarizeBlocks,
  type BlockSample,
  type PassReport,
} from '../scripts/audit/rtNoise';

/**
 * RT-AUDIT-2026-11-05-001 — Determinismus des Echtzeit-Gates.
 *
 * Befund: `npm run verify` meldete reproduzierbar "GC-Pause 1,138 ms" und
 * "2 Bloecke ueber Budget", waehrend dasselbe Gate allein 19/19 hielt. Ursache
 * ist die Messgroesse: Wanduhr-Zeiten enthalten fremde CPU-Konkurrenz (die
 * Kette startet das Gate direkt hinter `test:python`).
 *
 * Diese Helfer verwerfen begrenzt Scheduling-Ausreisser und machen sichtbar,
 * WANN die Maschine zu laut war - statt es als Code-Verstoss zu melden.
 */
const sample = (wallMs: number): BlockSample => ({ wallMs });

const blocksOf = (n: number, ms: number): BlockSample[] => Array.from({ length: n }, () => sample(ms));

describe('summarizeBlocks — Code-Kosten statt Scheduling', () => {
  it('sauberer Lauf: kein Verstoss, keine Ausreisser', () => {
    const s = summarizeBlocks(blocksOf(1000, 0.05));
    expect(s.overBudget).toBe(0);
    expect(s.outlierRatio).toBe(0);
    expect(s.medianWallMs).toBeLessThan(BUDGET_MS);
    expect(s.p999WallMs).toBeLessThan(BUDGET_MS / 2);
  });

  it('echt zu langsam: alle Bloecke ueber Budget zaehlen als Verstoss', () => {
    const s = summarizeBlocks(blocksOf(1000, 5));
    expect(s.overBudget).toBe(1000);
    expect(s.outlierRatio).toBe(0);
  });

  it('einzelner Scheduling-Ausreisser wird verworfen und als Quote gemeldet', () => {
    // 1000 Bloecke, einer mit 30 ms Wanduhr (Descheduling) - Budget 2,67 ms.
    const s = summarizeBlocks([...blocksOf(999, 0.05), sample(30)]);
    expect(s.overBudget).toBe(0);
    expect(s.outliers).toBe(1);
    expect(s.outlierRatio).toBeCloseTo(1 / 1000, 6);
  });

  it('die Trimmung ist begrenzt: mehr echte Ausreisser als 0,1 % bleiben sichtbar', () => {
    // 100 Bloecke bei 40 ms (Descheduling-Kandidaten), nur 1 darf verworfen werden.
    const s = summarizeBlocks([...blocksOf(900, 0.05), ...blocksOf(100, 40)]);
    expect(s.outliers).toBe(1);
    expect(s.overBudget).toBe(99);
    expect(s.outlierRatio).toBeCloseTo(1 / 1000, 6);
  });

  it('ein Block knapp ueber Budget ist ein Verstoss, kein Ausreisser', () => {
    // 4 ms = 1,5x Budget und nur ~80x Median: bleibt als Verstoss stehen.
    const s = summarizeBlocks([...blocksOf(999, 0.05), sample(4)]);
    expect(s.outliers).toBe(0);
    expect(s.overBudget).toBe(1);
  });

  it('p99,9 liegt nach der Trimmung im Budget, der Median bleibt ehrlich', () => {
    const s = summarizeBlocks([...blocksOf(1000, 0.4), sample(50)]);
    expect(s.p999WallMs).toBeLessThan(BUDGET_MS / 2);
    expect(s.medianWallMs).toBeCloseTo(0.4, 6);
  });

  it('leere Messung liefert Nullen statt NaN', () => {
    const s = summarizeBlocks([]);
    expect(s.p999WallMs).toBe(0);
    expect(s.outlierRatio).toBe(0);
  });

  it('Schwelle ist dokumentiert und klein', () => {
    expect(MAX_OUTLIER_RATIO).toBeLessThanOrEqual(0.001);
  });
});

describe('choosePass — welcher Messlauf zaehlt', () => {
  const pass = (over: Partial<PassReport>): PassReport => ({
    attempt: 1,
    gcMaxMs: 0.2,
    gcPerSecond: 0.1,
    overBudget: 0,
    outlierRatio: 0,
    p999WallMs: 0.3,
    ...over,
  });

  it('nimmt den ersten Lauf ohne Ausreisser, auch wenn ein spaeterer "schoenere" Zahlen hat', () => {
    const chosen = choosePass([pass({ attempt: 1, outlierRatio: 0.004, gcMaxMs: 0.1 }), pass({ attempt: 2 })]);
    expect(chosen.attempt).toBe(2);
  });

  it('ohne sauberen Lauf: der mit der kleinsten Quote (Umgebungsbefund)', () => {
    const chosen = choosePass([pass({ attempt: 1, outlierRatio: 0.3 }), pass({ attempt: 2, outlierRatio: 0.1 })]);
    expect(chosen.attempt).toBe(2);
    expect(chosen.outlierRatio).toBeGreaterThan(0);
  });
});
