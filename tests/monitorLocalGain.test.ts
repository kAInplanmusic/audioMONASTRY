import { describe, expect, it, vi } from 'vitest';
import { MonitorRoutingState, type MonitorRoutingDeps } from '../src/audio/monitorRoutingFacade';
import { defaultMonitorPlan } from '../src/core/audio/monitorRouting';
import { V2MonitorGraph } from '../src/core/audio/V2MonitorGraph';
import type { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';
import type { MonitorRoutingPlan } from '../src/core/audio/monitorRouting';

/**
 * UI-2026-11-06-003 (c): lokaler Monitor-/Kopfhörerpegel wirkt auf die Engine.
 *
 * Befund: Der Regler in SettingsDialog schrieb `settings.monitorGain` nur in den
 * Speicher. Es gab keinen Weg in den hörbaren Pfad — `mainMonitorGain` im
 * V2-Monitor-Graph war reine 0/1-Routing-Policy, `setMonitorGain(mon, g)` ist
 * der Cue-Bus, `setMasterVolume` ist der Master (und würde Master-Stream und
 * andere User mitziehen).
 *
 * Fix: eigener lokaler Pegel (0..1). Der veröffentlichte Plan trägt den
 * WIRKSAMEN Abhörpegel in `mainMonitorGain` (Policy × Regler) — genau dieser
 * Wert steht im Dedupe-Schlüssel des V2-Sinks, eine reine Reglerbewegung wird
 * also gesendet — plus den Roh-Wert in `localMonitorGain` (Diagnose/UI).
 * Master-Stream und andere User bleiben unberührt.
 */

function makeDeps(connected = true) {
  const sink = { isConnected: connected, setMonitorRouting: vi.fn() } as unknown as V2LiveSink;
  const deps: MonitorRoutingDeps = { getSink: () => sink, ensureInitialized: vi.fn(), getCount: () => 4 };
  return { deps, sink };
}

const lastPlan = (sink: V2LiveSink): MonitorRoutingPlan =>
  (sink.setMonitorRouting as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as MonitorRoutingPlan;

describe('MonitorRoutingState · lokaler Monitorpegel', () => {
  it('startet bei 1.0 und klemmt den Pegel auf 0..1', () => {
    const { deps } = makeDeps();
    const m = new MonitorRoutingState(deps);
    expect(m.getLocalMonitorGain()).toBe(1);
    m.setLocalMonitorGain(2);
    expect(m.getLocalMonitorGain()).toBe(1);
    m.setLocalMonitorGain(-0.5);
    expect(m.getLocalMonitorGain()).toBe(0);
    m.setLocalMonitorGain(0.42);
    expect(m.getLocalMonitorGain()).toBe(0.42);
    // Ungültige Werte ändern nichts (kein versehentliches Stummschalten).
    m.setLocalMonitorGain(Number.NaN);
    expect(m.getLocalMonitorGain()).toBe(0.42);
  });

  it('publiziert den wirksamen MAIN-Abhörpegel (Policy × Regler) im Plan', () => {
    const { deps, sink } = makeDeps();
    const m = new MonitorRoutingState(deps);
    m.setLocalMonitorGain(0.35);
    const plan = lastPlan(sink);
    expect(plan.localMonitorGain).toBe(0.35);
    // Wirkpegel: MAIN-Routing ist 1 → 1 × 0.35.
    expect(plan.mainMonitorGain).toBeCloseTo(0.35, 6);
    expect(plan.source).toBe('MAIN');

    // Cue-Umschaltung: MAIN-Abhörweg stumm (0 × 0.35 = 0), Wunschpegel bleibt.
    m.setMonitorSource('MON', 'MON1');
    const plan2 = lastPlan(sink);
    expect(plan2.mainMonitorGain).toBe(0);
    expect(plan2.localMonitorGain).toBe(0.35);

    // Zurück auf MAIN: der Regler wirkt wieder (kein „vergessener" Pegel).
    m.setMonitorSource('MAIN', 'MON1');
    expect(lastPlan(sink).mainMonitorGain).toBeCloseTo(0.35, 6);
    expect(m.getMonitorRouting().localMonitorGain).toBe(0.35);
  });

  it('jede Reglerbewegung ändert den Plan-Schlüssel (sonst dedupliziert der Sink sie weg)', () => {
    const { deps, sink } = makeDeps();
    const m = new MonitorRoutingState(deps);
    m.setLocalMonitorGain(0.9);
    const a = lastPlan(sink);
    m.setLocalMonitorGain(0.4);
    const b = lastPlan(sink);
    // Der Sink vergleicht source|mon|solo|mainMonitorGain|cueGain|cueTracks.
    expect(a.mainMonitorGain).not.toBe(b.mainMonitorGain);
    expect(a.cueGain).toBe(b.cueGain);
  });

  it('publiziert nur, wenn der V2-Sink verbunden ist (Init-Wert vor dem Start)', () => {
    const { deps, sink } = makeDeps(false);
    const m = new MonitorRoutingState(deps);
    m.setLocalMonitorGain(0.2);
    expect(sink.setMonitorRouting).not.toHaveBeenCalled();
    expect(m.getPlan().localMonitorGain).toBe(0.2);
    expect(m.getPlan().mainMonitorGain).toBeCloseTo(0.2, 6);
  });
});

describe('V2MonitorGraph · übernimmt den lokalen Pegel aus dem Plan', () => {
  it('setzt den MAIN-Abhörknoten auf den wirksamen Pegel', () => {
    const graph = new V2MonitorGraph();
    graph.applyMonitorPlan({ ...defaultMonitorPlan('MON1'), mainMonitorGain: 0.5, localMonitorGain: 0.5 });
    expect(graph.mainMonitorGainNode.gain.value).toBeCloseTo(0.5, 5);
    graph.applyMonitorPlan({ ...defaultMonitorPlan('MON1'), mainMonitorGain: 0, localMonitorGain: 0 });
    expect(graph.mainMonitorGainNode.gain.value).toBe(0);
    graph.applyMonitorPlan({ ...defaultMonitorPlan('MON1'), mainMonitorGain: 1, localMonitorGain: 1 });
    expect(graph.mainMonitorGainNode.gain.value).toBeCloseTo(1, 5);
  });

  it('verwirft einen ungültigen lokalen Pegel statt stumm zu schalten', () => {
    const graph = new V2MonitorGraph();
    graph.applyMonitorPlan({ ...defaultMonitorPlan('MON1'), mainMonitorGain: 0.5, localMonitorGain: 0.5 });
    graph.applyMonitorPlan({ ...defaultMonitorPlan('MON1'), mainMonitorGain: 0.5, localMonitorGain: Number.NaN });
    expect(Number.isFinite(graph.mainMonitorGainNode.gain.value)).toBe(true);
    expect(graph.mainMonitorGainNode.gain.value).toBeCloseTo(0.5, 5);
  });

  it('setzt den Pegel beim reset() zurück', () => {
    const graph = new V2MonitorGraph();
    graph.applyMonitorPlan({ ...defaultMonitorPlan('MON1'), mainMonitorGain: 0.3, localMonitorGain: 0.3 });
    graph.reset();
    expect(graph.mainMonitorGainNode.gain.value).toBeCloseTo(1, 5);
  });

  it('Ende-zu-Ende: Regler → Facade-Plan → V2-Graph-Knoten', () => {
    const { deps, sink } = makeDeps();
    const m = new MonitorRoutingState(deps);
    m.setLocalMonitorGain(0.4);
    const graph = new V2MonitorGraph();
    graph.applyMonitorPlan(lastPlan(sink));
    expect(graph.mainMonitorGainNode.gain.value).toBeCloseTo(0.4, 5);
  });
});
