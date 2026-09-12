import { describe, expect, it, vi } from 'vitest';
import { createDefaultMonitorTrackGain, MonitorRoutingState, type MonitorRoutingDeps } from '../src/audio/monitorRoutingFacade';
import type { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';

// ---------------------------------------------------------------------------
// AUDIO-P1-002: Der Monitor-Routing-Zustand. Geprüft wird die Wirkung (Cue-
// Matrix, Quelle, PFL-Vorrang, MAIN-Berechtigung, V2-Publikation) mit Fakes.
// ---------------------------------------------------------------------------

function makeDeps() {
  const sink = { isConnected: true, setMonitorRouting: vi.fn() } as unknown as V2LiveSink;
  const ensureInitialized = vi.fn();
  const deps: MonitorRoutingDeps = { getSink: () => sink, ensureInitialized, getCount: () => 4 };
  return { deps, sink, ensureInitialized };
}

describe('MonitorRoutingState', () => {
  it('initialisiert die Cue-Matrix mit den Rollen-Voreinstellungen', () => {
    const matrix = createDefaultMonitorTrackGain();
    expect(Object.keys(matrix)).toEqual(['MON1', 'MON2', 'MON3', 'MON4']);
    expect(Object.keys(matrix.MON1)).toHaveLength(8);
    expect(matrix.MON2.channel2).toBe(0.5);
    expect(matrix.MON2.channel6).toBe(1.2);
    expect(matrix.MON4.channel1).toBe(1.2);
    expect(matrix.MON4.channel8).toBe(1.2);
    expect(matrix.MON1.channel2).toBe(1);
  });

  it('klemmt Monitor- und Track-Pegel', () => {
    const { deps } = makeDeps();
    const m = new MonitorRoutingState(deps);
    m.setMonitorTrackGain('MON1', 'channel1', 99);
    expect(m.getMonitorTrackGain('MON1').channel1).toBe(2);
    m.setMonitorTrackGain('MON1', 'channel1', Number.NaN);
    expect(m.getMonitorTrackGain('MON1').channel1).toBe(0);
  });

  it('setMonitorSource initialisiert und publiziert den Plan an den V2-Sink', () => {
    const { deps, sink, ensureInitialized } = makeDeps();
    const m = new MonitorRoutingState(deps);
    m.setMonitorSource('MON', 'MON2');
    expect(ensureInitialized).toHaveBeenCalled();
    expect(m.getMonitorSource()).toBe('MON');
    expect((sink.setMonitorRouting as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ mon: 'MON2', source: 'MON' });
  });

  it('DJ-PFL hat Vorrang und hört nur die vorgehörten Kanäle', () => {
    const { deps, sink } = makeDeps();
    const m = new MonitorRoutingState(deps);
    m.setChannelPfl('channel3', true);
    expect(m.getPflTracks()).toEqual(['channel3']);
    const plan = (sink.setMonitorRouting as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { source: string; cueTracks: Record<string, number> };
    expect(plan.source).toBe('MON');
    // Der vorgehörte Kanal ist im Cue-Mix; PFL erzwingt den MON-Pfad.
    expect(plan.cueTracks.channel3).toBe(1);
    m.setChannelPfl('channel3', false);
    expect(m.getPflTracks()).toEqual([]);
  });

  it('MAIN-Berechtigung steuert canLoadTrack (DJ immer, andere nur mit Freigabe)', () => {
    const { deps } = makeDeps();
    const m = new MonitorRoutingState(deps);
    expect(m.canLoadTrack('channel1')).toBe(true);
    m.setMainHolderActive(false);
    expect(m.canLoadTrack('channel1')).toBe(false);
    m.setTrackReleased('channel1', true);
    expect(m.canLoadTrack('channel1')).toBe(true);
    expect(m.canLoadTrack('channel2')).toBe(false);
    expect(m.isTrackReleased('channel1')).toBe(true);
  });

  it('getMonitorRouting meldet Verdrahtung und Knoten-Pegel', () => {
    const { deps } = makeDeps();
    const m = new MonitorRoutingState(deps);
    const routing = m.getMonitorRouting();
    expect(routing.wired).toBe(true);
    expect(routing.nodeGains).toEqual({ main: routing.mainMonitorGain, cue: routing.cueGain });
    expect(m.getMonitorConfig().count).toBe(4);
  });

  it('importiert einen Session-Plan (Quelle + Cue-Matrix) und wendet ihn an', () => {
    const { deps, sink } = makeDeps();
    const m = new MonitorRoutingState(deps);
    m.importRoutingPlan({
      source: 'MON', mon: 'MON3', soloTrack: 'channel5',
      cueTracks: { channel5: 0.4, channel1: 0 } as never,
      mainMonitorGain: 0, cueGain: 1,
    } as never);
    expect(m.getMonitorSource()).toBe('MON');
    expect(m.getMonitorTrackGain('MON3').channel5).toBe(0.4);
    expect(sink.setMonitorRouting).toHaveBeenCalled();
  });

  it('reset() setzt Quelle und Plan zurück (dispose)', () => {
    const { deps } = makeDeps();
    const m = new MonitorRoutingState(deps);
    m.setMonitorSource('MON', 'MON2');
    m.reset();
    expect(m.getMonitorSource()).toBe('MAIN');
    expect(m.getPflTracks()).toEqual([]);
  });
});
