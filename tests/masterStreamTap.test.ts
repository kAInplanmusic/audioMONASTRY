import { describe, expect, it, vi } from 'vitest';
import { MasterStreamTap, type MasterStreamTapDeps } from '../src/audio/masterStreamTap';
import type { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';

// ---------------------------------------------------------------------------
// AUDIO-P1-002: Master-Stream-Tap + Visual-Analyser. Geprüft wird das ehrliche
// Verhalten: V2-Abgriff bevorzugt, kein No-Op-Fallback (null statt stumm),
// sauberes Trennen und Reattach nach dem V2-Connect.
// ---------------------------------------------------------------------------

function makeDeps(opts: { v2Connected?: boolean; connectExtra?: boolean; legacy?: boolean; ctx?: boolean } = {}) {
  const dest = { disconnect: vi.fn() } as unknown as MediaStreamAudioDestinationNode;
  const analyser = { disconnect: vi.fn(), fftSize: 0, smoothingTimeConstant: 0 } as unknown as AnalyserNode;
  const sink = {
    isConnected: opts.v2Connected ?? false,
    connectExtra: vi.fn(() => opts.connectExtra ?? true),
    disconnectExtra: vi.fn(),
  } as unknown as V2LiveSink;
  const legacyTap = { connect: vi.fn(), disconnect: vi.fn() } as unknown as GainNode;
  const ctx = (opts.ctx ?? true)
    ? { createMediaStreamDestination: vi.fn(() => dest), createAnalyser: vi.fn(() => analyser) }
    : null;
  const deps: MasterStreamTapDeps = {
    getContext: () => ctx as unknown as AudioContext | null,
    getSink: () => sink,
    getLegacyTap: () => (opts.legacy ? legacyTap : null),
  };
  return { deps, dest, analyser, sink, legacyTap };
}

describe('MasterStreamTap', () => {
  it('bevorzugt den hörbaren V2-Ausgang und markiert die Verbindung', () => {
    const { deps, dest, sink } = makeDeps({ v2Connected: true });
    const tap = new MasterStreamTap(deps);
    expect(tap.create()).toBe(dest);
    expect(sink.connectExtra).toHaveBeenCalledWith(dest);
    expect(tap.isV2Connected).toBe(true);
    expect(tap.currentDest).toBe(dest);
  });

  it('meldet ohne V2 und ohne echten Legacy-Knoten ehrlich null (kein No-Op-Fake)', () => {
    const { deps } = makeDeps({ v2Connected: false, legacy: false });
    const tap = new MasterStreamTap(deps);
    expect(tap.create()).toBeNull();
    expect(tap.currentDest).toBeNull();
  });

  it('nutzt den Legacy-Tap nur, wenn er ein echter Knoten ist', () => {
    const { deps, legacyTap } = makeDeps({ v2Connected: false, legacy: true });
    const tap = new MasterStreamTap(deps);
    tap.create();
    expect(legacyTap.connect).toHaveBeenCalled();
    expect(tap.isV2Connected).toBe(false);
  });

  it('trennt eine Destination vollständig und setzt den Zustand zurück', () => {
    const { deps, dest, sink } = makeDeps({ v2Connected: true });
    const tap = new MasterStreamTap(deps);
    tap.create();
    tap.disconnect(dest);
    expect(sink.disconnectExtra).toHaveBeenCalledWith(dest);
    expect((dest as unknown as { disconnect: ReturnType<typeof vi.fn> }).disconnect).toHaveBeenCalled();
    expect(tap.currentDest).toBeNull();
    expect(tap.isV2Connected).toBe(false);
  });

  it('createAnalyser liefert null und räumt auf, wenn der V2-Sink nicht verbunden ist', () => {
    const { deps, analyser } = makeDeps({ v2Connected: false });
    const tap = new MasterStreamTap(deps);
    expect(tap.createAnalyser()).toBeNull();
    expect((analyser as unknown as { disconnect: ReturnType<typeof vi.fn> }).disconnect).toHaveBeenCalled();
  });

  it('createAnalyser setzt fftSize/Smoothing und hängt am V2-Ausgang', () => {
    const { deps, analyser, sink } = makeDeps({ v2Connected: true });
    const tap = new MasterStreamTap(deps);
    const out = tap.createAnalyser(1024);
    expect(out).toBe(analyser);
    expect(analyser.fftSize).toBe(1024);
    expect(analyser.smoothingTimeConstant).toBe(0.75);
    expect(sink.connectExtra).toHaveBeenCalledWith(analyser);
  });

  it('reattach hängt eine vorhandene Destination nach dem V2-Connect nach', () => {
    const { deps, dest, sink } = makeDeps({ v2Connected: false, legacy: true });
    const tap = new MasterStreamTap(deps);
    tap.create();
    expect(tap.isV2Connected).toBe(false);
    (sink as unknown as { isConnected: boolean }).isConnected = true;
    tap.reattach();
    expect(sink.connectExtra).toHaveBeenCalledWith(dest);
    expect(tap.isV2Connected).toBe(true);
  });

  it('reset() vergisst die Destination (dispose)', () => {
    const { deps } = makeDeps({ v2Connected: true });
    const tap = new MasterStreamTap(deps);
    tap.create();
    tap.reset();
    expect(tap.currentDest).toBeNull();
    expect(tap.isV2Connected).toBe(false);
  });
});
