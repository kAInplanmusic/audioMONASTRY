/**
 * ZUK-005 · Automationsspuren auf einer Timeline
 * ===============================================
 * Deckt das reine Zeitmodell (`automationTimeline.ts`) ab – Interpolation je
 * Kurventyp, exakte Punktzeiten, Randverhalten, unsortierte Eingabe,
 * Doppelzeiten ("der spätere Punkt gewinnt"), Klemmung auf den
 * Parameterbereich – und den einen Integrationspunkt am
 * `V2NodeAutomationCoalescer`: ohne Lane bleibt das bisherige Verhalten
 * (konstante Werte über `push`) unverändert.
 */
import { describe, expect, it } from 'vitest';
import {
  AutomationTimeline,
  evaluateAutomationPoints,
  sortAutomationPoints,
  type AutomationLanePoint,
} from '../src/core/audio/state/automationTimeline';
import { V2NodeAutomationCoalescer } from '../src/core/audio/state/v2NodeAutomation';
import { ParametricEqNode } from '../src/core/audio/nodes/processingNodes';

const RANGE = { min: 0, max: 10, defaultValue: 0 } as const;

function makeLane(points: { timeSec: number; value: number; curve?: 'linear' | 'exponential' | 'hold' }[]) {
  const timeline = new AutomationTimeline();
  const laneId = timeline.createLane('eq:auto', 'low', RANGE);
  timeline.addPoints(laneId, points);
  return { timeline, laneId };
}

describe('ZUK-005 · AutomationTimeline: Interpolation je Kurventyp', () => {
  it('linear interpoliert zwischen zwei Punkten und trifft exakte Punktzeiten', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 0, value: 0, curve: 'linear' },
      { timeSec: 2, value: 10, curve: 'linear' },
    ]);
    expect(timeline.evaluate(laneId, 0)).toBe(0);
    expect(timeline.evaluate(laneId, 0.5)).toBeCloseTo(2.5, 10);
    expect(timeline.evaluate(laneId, 1)).toBeCloseTo(5, 10);
    expect(timeline.evaluate(laneId, 2)).toBe(10);
  });

  it('exponential interpoliert geometrisch und trifft exakte Punktzeiten', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 0, value: 1, curve: 'exponential' },
      { timeSec: 2, value: 4, curve: 'linear' },
    ]);
    expect(timeline.evaluate(laneId, 0)).toBe(1);
    expect(timeline.evaluate(laneId, 1)).toBeCloseTo(2, 10); // sqrt(1*4)
    expect(timeline.evaluate(laneId, 0.5)).toBeCloseTo(1.4142135623730951, 10); // 4^(0.25)
    expect(timeline.evaluate(laneId, 2)).toBe(4);
  });

  it('exponential fällt bei Null oder Vorzeichenwechsel auf linear zurück (kein NaN)', () => {
    const signed = new AutomationTimeline();
    const signedLane = signed.createLane('eq:auto', 'low', { min: -24, max: 24 });
    signed.addPoints(signedLane, [
      { timeSec: 0, value: -4, curve: 'exponential' },
      { timeSec: 2, value: 4, curve: 'linear' },
    ]);
    expect(signed.evaluate(signedLane, 1)).toBeCloseTo(0, 10); // linear: -4 + 8*0.5

    const zero = makeLane([
      { timeSec: 0, value: 0, curve: 'exponential' },
      { timeSec: 2, value: 8, curve: 'linear' },
    ]);
    expect(zero.timeline.evaluate(zero.laneId, 1)).toBeCloseTo(4, 10);
    expect(Number.isNaN(zero.timeline.evaluate(zero.laneId, 1))).toBe(false);
  });

  it('hold hält den linken Wert bis zur exakten Zeit des nächsten Punktes', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 0, value: 2, curve: 'hold' },
      { timeSec: 2, value: 8, curve: 'linear' },
    ]);
    expect(timeline.evaluate(laneId, 0)).toBe(2);
    expect(timeline.evaluate(laneId, 0.5)).toBe(2);
    expect(timeline.evaluate(laneId, 1.999)).toBe(2);
    expect(timeline.evaluate(laneId, 2)).toBe(8); // exakte Punktzeit gewinnt
    expect(timeline.evaluate(laneId, 3)).toBe(8);
  });

  it('die Kurve des LINKEN Punktes bestimmt das Segment', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 0, value: 0, curve: 'hold' },
      { timeSec: 1, value: 10, curve: 'linear' },
      { timeSec: 2, value: 0, curve: 'exponential' },
    ]);
    expect(timeline.evaluate(laneId, 0.5)).toBe(0); // hold-Segment 0 -> 1
    expect(timeline.evaluate(laneId, 1.5)).toBeCloseTo(5, 10); // linear-Segment 1 -> 2
    expect(timeline.evaluate(laneId, 2)).toBe(0);
  });
});

describe('ZUK-005 · AutomationTimeline: Ränder und Lane-Länge', () => {
  it('vor dem ersten und nach dem letzten Punkt gilt der jeweilige Endwert', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 1, value: 3, curve: 'linear' },
      { timeSec: 3, value: 7, curve: 'linear' },
    ]);
    expect(timeline.evaluate(laneId, 0)).toBe(3);
    expect(timeline.evaluate(laneId, 0.999)).toBe(3);
    expect(timeline.evaluate(laneId, 3.001)).toBe(7);
    expect(timeline.evaluate(laneId, 1000)).toBe(7);
  });

  it('lane length folgt dem letzten Punkt, lässt sich verlängern, aber nicht unter den letzten Punkt kürzen', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 1, value: 1, curve: 'linear' },
      { timeSec: 4, value: 2, curve: 'linear' },
    ]);
    expect(timeline.getLane(laneId)?.lengthSec).toBe(4);

    timeline.setLength(laneId, 8);
    expect(timeline.getLane(laneId)?.lengthSec).toBe(8);
    expect(timeline.evaluate(laneId, 6)).toBe(2); // hinter dem letzten Punkt: halten

    timeline.setLength(laneId, 2);
    expect(timeline.getLane(laneId)?.lengthSec).toBe(4); // nie kürzer als der letzte Punkt
  });

  it('eine Lane ohne Punkte liefert den (geklemmten) Default-Wert', () => {
    const timeline = new AutomationTimeline();
    const laneId = timeline.createLane('eq:auto', 'high', { min: -6, max: 6, defaultValue: 99 });
    expect(timeline.evaluate(laneId, 0)).toBe(6);
    expect(timeline.getLane(laneId)?.points).toHaveLength(0);
    expect(timeline.getLane(laneId)?.lengthSec).toBe(0);
  });

  it('lehnt negative oder nicht-endliche Zeiten ab', () => {
    const { timeline, laneId } = makeLane([{ timeSec: 0, value: 0 }]);
    expect(() => timeline.addPoint(laneId, { timeSec: -1, value: 1 })).toThrow(RangeError);
    expect(() => timeline.evaluate(laneId, Number.NaN)).toThrow(RangeError);
    expect(() => timeline.evaluate('unbekannt::x', 0)).toThrow(RangeError);
  });
});

describe('ZUK-005 · AutomationTimeline: unsortierte Eingabe und Doppelzeiten', () => {
  it('sortiert unsortierte Eingabe und interpoliert danach korrekt', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 3, value: 9, curve: 'linear' },
      { timeSec: 0, value: 0, curve: 'linear' },
      { timeSec: 1.5, value: 6, curve: 'linear' },
    ]);
    const times = timeline.getLane(laneId)!.points.map((p) => p.timeSec);
    expect(times).toEqual([0, 1.5, 3]);
    expect(timeline.evaluate(laneId, 0.75)).toBeCloseTo(3, 10); // 0 -> 6 über 1.5 s
    expect(timeline.evaluate(laneId, 2.25)).toBeCloseTo(7.5, 10); // 6 -> 9 über 1.5 s
  });

  it('bei gleicher Zeit gewinnt der später eingefügte Punkt (addPoints)', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 1, value: 2, curve: 'linear' },
      { timeSec: 1, value: 7, curve: 'hold' },
    ]);
    expect(timeline.getLane(laneId)!.points).toHaveLength(1);
    expect(timeline.evaluate(laneId, 1)).toBe(7);
    expect(timeline.getLane(laneId)!.points[0].curve).toBe('hold');
  });

  it('bei gleicher Zeit gewinnt der später eingefügte Punkt (addPoint / bestehende Lane)', () => {
    const { timeline, laneId } = makeLane([{ timeSec: 1, value: 2, curve: 'linear' }]);
    const stored = timeline.addPoint(laneId, { timeSec: 1, value: 5, curve: 'linear' });
    expect(stored.value).toBe(5);
    expect(timeline.getLane(laneId)!.points).toHaveLength(1);
    expect(timeline.evaluate(laneId, 1)).toBe(5);
  });

  it('Verschieben auf eine belegte Zeit überschreibt den dortigen Punkt', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 0, value: 0, curve: 'linear' },
      { timeSec: 1, value: 4, curve: 'linear' },
      { timeSec: 2, value: 8, curve: 'linear' },
    ]);
    const moved = timeline.movePoint(laneId, 0, 2);
    expect(moved?.timeSec).toBe(2);
    expect(timeline.getLane(laneId)!.points.map((p) => p.timeSec)).toEqual([1, 2]);
    expect(timeline.evaluate(laneId, 2)).toBe(0); // der verschobene Punkt gewinnt
  });

  it('sortAutomationPoints ist stabil und dedupliziert "später gewinnt"', () => {
    const sorted = sortAutomationPoints([
      { timeSec: 2, value: 20, curve: 'linear' },
      { timeSec: 1, value: 10, curve: 'hold' },
      { timeSec: 2, value: 21, curve: 'exponential' },
    ]);
    expect(sorted.map((p: AutomationLanePoint) => p.timeSec)).toEqual([1, 2]);
    expect(sorted[1].value).toBe(21);
    expect(sorted[1].curve).toBe('exponential');
  });
});

describe('ZUK-005 · AutomationTimeline: Klemmung, Verschieben, Entfernen', () => {
  it('klemmt Werte beim Einfügen und beim Verschieben auf den Parameterbereich', () => {
    const { timeline, laneId } = makeLane([]);
    const added = timeline.addPoint(laneId, { timeSec: 1, value: 42, curve: 'linear' });
    expect(added.value).toBe(10); // max aus RANGE
    timeline.addPoint(laneId, { timeSec: 2, value: -3, curve: 'linear' });
    expect(timeline.getLane(laneId)!.points.map((p) => p.value)).toEqual([10, 0]);

    const moved = timeline.movePoint(laneId, 2, 3, { value: 999 });
    expect(moved?.value).toBe(10);
    expect(timeline.evaluate(laneId, 1)).toBe(10);
    expect(timeline.evaluate(laneId, 3)).toBe(10);
  });

  it('setRange klemmt bestehende Punkte nach', () => {
    const { timeline, laneId } = makeLane([{ timeSec: 0, value: 9, curve: 'linear' }]);
    timeline.setRange(laneId, 0, 4, 1);
    expect(timeline.getLane(laneId)!.points[0].value).toBe(4);
    expect(timeline.getLane(laneId)!.defaultValue).toBe(1);
    expect(timeline.evaluate(laneId, 0)).toBe(4);
  });

  it('movePoint ohne Punkt bei fromTimeSec liefert null, removePoint meldet false', () => {
    const { timeline, laneId } = makeLane([{ timeSec: 1, value: 5, curve: 'linear' }]);
    expect(timeline.movePoint(laneId, 0.5, 2)).toBeNull();
    expect(timeline.removePoint(laneId, 0.5)).toBe(false);
    expect(timeline.removePoint(laneId, 1)).toBe(true);
    expect(timeline.getLane(laneId)!.points).toHaveLength(0);
    expect(timeline.evaluate(laneId, 1)).toBe(0); // zurück auf defaultValue
  });

  it('movePoint mit Wert-Patch behält Kurve und ordnet neu', () => {
    const { timeline, laneId } = makeLane([
      { timeSec: 0, value: 0, curve: 'linear' },
      { timeSec: 2, value: 10, curve: 'linear' },
    ]);
    const moved = timeline.movePoint(laneId, 0, 1, { value: 5 });
    expect(moved).toEqual({ timeSec: 1, value: 5, curve: 'linear' });
    expect(timeline.getLane(laneId)!.points.map((p) => p.timeSec)).toEqual([1, 2]);
    // Segment 1 -> 2 steigt jetzt von 5 auf 10
    expect(timeline.evaluate(laneId, 1.5)).toBeCloseTo(7.5, 10);
    // vor dem ersten Punkt hält der erste Punkt
    expect(timeline.evaluate(laneId, 0)).toBe(5);
  });

  it('Lane-Identität ist (nodeId, parameterId); createLane ist idempotent', () => {
    const timeline = new AutomationTimeline();
    const a = timeline.createLane('eq:auto', 'low', RANGE);
    timeline.addPoint(a, { timeSec: 0, value: 3, curve: 'linear' });
    const b = timeline.createLane('eq:auto', 'low', { min: -24, max: 24 });
    expect(b).toBe(a);
    expect(timeline.getLane(b)!.points).toHaveLength(1); // Bereich wird nicht überschrieben
    expect(timeline.getLane(b)!.min).toBe(0);

    const other = timeline.createLane('eq:auto', 'high', RANGE);
    expect(other).not.toBe(a);
    expect(timeline.listLanes().map((lane) => lane.id)).toEqual([a, other]);
    expect(timeline.hasLaneFor('eq:auto', 'low')).toBe(true);
    expect(timeline.getLaneFor('eq:auto', 'mid')).toBeUndefined();
    expect(timeline.evaluateAt('eq:auto', 'mid', 1)).toBeNull();
    expect(timeline.evaluateAt('eq:auto', 'low', 0)).toBe(3);
    expect(timeline.removeLane(other)).toBe(true);
    expect(timeline.removeLane(other)).toBe(false);
  });

  it('exportierte Punktliste ist eine Kopie (kein Zugriff auf den Store)', () => {
    const { timeline, laneId } = makeLane([{ timeSec: 1, value: 4, curve: 'linear' }]);
    const snapshot = timeline.getLane(laneId)!;
    (snapshot.points as AutomationLanePoint[])[0].value = -100;
    expect(timeline.evaluate(laneId, 1)).toBe(4);
  });

  it('evaluateAutomationPoints liefert für eine leere Liste NaN (Aufrufer prüft Lane)', () => {
    expect(Number.isNaN(evaluateAutomationPoints([], 1))).toBe(true);
  });
});

describe('ZUK-005 · Integrationspunkt: V2NodeAutomationCoalescer liest Lane-Werte', () => {
  function setup() {
    const eq = new ParametricEqNode('eq:auto');
    const nodes = new Map([['eq:auto', eq]]);
    return { eq, nodes };
  }

  it('ohne Lane bleibt das bestehende Verhalten unverändert (push + flushNow)', () => {
    const { eq, nodes } = setup();
    const auto = new V2NodeAutomationCoalescer(nodes, { intervalMs: 1000 });

    expect(eq.getParameter('low')!.value).toBe(0);
    auto.push('eq:auto', 'low', -9);
    auto.push('eq:auto', 'high', 4);
    expect(eq.getParameter('low')!.value).toBe(0); // noch nicht geflusht
    auto.flushNow();
    expect(eq.getParameter('low')!.value).toBe(-9);
    expect(eq.getParameter('high')!.value).toBe(4);

    // Kein Timeline-Einfluss: nichts zu lesen, nichts anzuwenden.
    expect(auto.timeline).toBeNull();
    expect(auto.readAutomationValue('eq:auto', 'low', 1)).toBeNull();
    expect(auto.applyAtTime(1)).toBe(0);
    expect(auto.pushAtTime('eq:auto', 'low', 1)).toBe(false);
    auto.flushNow();
    expect(eq.getParameter('low')!.value).toBe(-9); // unverändert
    auto.dispose();
  });

  it('mit Timeline, aber ohne Lane für den Parameter: Verhalten wie vorher', () => {
    const { eq, nodes } = setup();
    const timeline = new AutomationTimeline();
    timeline.createLane('eq:auto', 'high', { min: -24, max: 24 });
    const auto = new V2NodeAutomationCoalescer(nodes, { intervalMs: 1000, timeline });

    // Lane für 'high' ohne Punkte -> Default 0, 'low' hat keine Lane
    expect(auto.readAutomationValue('eq:auto', 'low', 1)).toBeNull();
    auto.push('eq:auto', 'low', -9);
    auto.flushNow();
    expect(eq.getParameter('low')!.value).toBe(-9);
    auto.dispose();
  });

  it('applyAtTime schreibt den Lane-Wert zum Transport-Zeitpunkt statt einer Konstanten', () => {
    const { eq, nodes } = setup();
    const timeline = new AutomationTimeline();
    const laneId = timeline.createLane('eq:auto', 'low', { min: -24, max: 24 });
    timeline.addPoints(laneId, [
      { timeSec: 0, value: -12, curve: 'linear' },
      { timeSec: 2, value: 12, curve: 'linear' },
    ]);
    const auto = new V2NodeAutomationCoalescer(nodes, { intervalMs: 1000, timeline });

    expect(auto.applyAtTime(0)).toBe(1);
    auto.flushNow();
    expect(eq.getParameter('low')!.value).toBe(-12);

    expect(auto.applyAtTime(1)).toBe(1);
    auto.flushNow();
    expect(eq.getParameter('low')!.value).toBeCloseTo(0, 10);

    expect(auto.applyAtTime(2)).toBe(1);
    auto.flushNow();
    expect(eq.getParameter('low')!.value).toBe(12);

    // hinter dem letzten Punkt: Endwert halten
    expect(auto.applyAtTime(10)).toBe(1);
    auto.flushNow();
    expect(eq.getParameter('low')!.value).toBe(12);
    auto.dispose();
  });

  it('pushAtTime liest die Lane und ignoriert den Fallback, wenn eine Lane existiert', () => {
    const { eq, nodes } = setup();
    const timeline = new AutomationTimeline();
    const laneId = timeline.createLane('eq:auto', 'low', { min: -24, max: 24 });
    timeline.addPoint(laneId, { timeSec: 0, value: -6, curve: 'linear' });
    const auto = new V2NodeAutomationCoalescer(nodes, { intervalMs: 1000, timeline });

    expect(auto.pushAtTime('eq:auto', 'low', 0.5, 99)).toBe(true);
    auto.flushNow();
    expect(eq.getParameter('low')!.value).toBe(-6);

    // ohne Lane greift der Fallback (bestehender Aufrufpfad) und landet auf
    // dem Parameter, weil der Coalescer-Key ein gültiger EQ-Param ist
    expect(auto.pushAtTime('eq:auto', 'mid', 0.5, 3)).toBe(true);
    auto.flushNow();
    expect(eq.getParameter('mid')!.value).toBe(3);
    auto.dispose();
  });

  it('applyAtTime zählt nur Lanes, deren Node und Parameter existieren', () => {
    const { nodes } = setup();
    const timeline = new AutomationTimeline();
    timeline.createLane('eq:auto', 'low', RANGE);
    timeline.createLane('eq:auto', 'gibtsnicht', RANGE);
    timeline.createLane('node:fehlt', 'low', RANGE);
    const auto = new V2NodeAutomationCoalescer(nodes, { intervalMs: 1000, timeline });
    expect(auto.applyAtTime(0)).toBe(1);
    auto.dispose();
  });
});
