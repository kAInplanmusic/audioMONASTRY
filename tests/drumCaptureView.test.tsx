// @vitest-environment jsdom
/**
 * IDEA-2026-10-07-A-F1 · Übernommene Capture-Takte sind in der Pattern-Ansicht
 * des drumsamplerMONK sichtbar, Pads/Steps landen im Capture-Log.
 *
 *  - Pad-Klick → triggerDrumSound(kit, sound, 1, 'drum-pad') (Capture-Log).
 *  - `monk:capture-drum-merge` (CaptureControl nach Bestätigung) → Steps in der
 *    aktuellen Bank sofort sichtbar und per writePluginSettings in der Session.
 *  - Gesperrt für andere (B2B): das Terminal übernimmt nichts.
 *  - Engine-Kanal-Patterns (Ziel der Kanal-Steps) erscheinen als Anzeige und
 *    folgen Pattern-Änderungen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ALL_TRACKS, type TrackType } from '../src/types';

const { engine, writes, lock } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const patterns: Record<string, boolean[]> = {};
  const engine = {
    patterns,
    listeners,
    triggerDrumSound: vi.fn(async () => {}),
    recordDrumCapture: vi.fn(),
    setDrumKit: vi.fn(),
    setSwing: vi.fn(),
    addStepListener: vi.fn(() => () => {}),
    getSequencerPatterns: () => {
      const out: Record<string, boolean[]> = {};
      for (const k of Object.keys(patterns)) out[k] = [...patterns[k]];
      return out;
    },
    addPatternListener: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  return {
    engine,
    writes: [] as Array<{ id: string; s: Record<string, unknown> }>,
    lock: { active: false, lockedBy: '' },
  };
});

vi.mock('../src/utils/audioEngine', () => ({ audioEngine: { ...engine, readMeterValues: () => null } }));
vi.mock('../src/utils/pluginSettings', () => ({
  readPluginSettings: () => null,
  writePluginSettings: (id: string, s: Record<string, unknown>) => { writes.push({ id, s }); },
}));
vi.mock('../src/context/SampleContext', () => ({
  useSamples: () => ({
    addSample: vi.fn(), pendingSample: null, setPendingSample: vi.fn(), takeoverRequest: null,
    clearTakeoverRequest: vi.fn(), setSelectedSample: vi.fn(),
  }),
}));
vi.mock('../src/hooks/usePluginState', () => ({
  usePluginState: () => ({ state: 'PRO', lockStatus: lock, updateState: vi.fn() }),
}));
vi.mock('../src/hooks/useMIDI', () => ({ useMIDI: () => ({ outputs: [] }) }));
vi.mock('../src/hooks/useMidiClockOut', () => ({
  useMidiClockOut: () => ({
    enabled: false, connected: false, ports: [], portId: '', setEnabled: vi.fn(), selectPort: vi.fn(),
    clockOut: { stop: vi.fn(), start: vi.fn(), setBpm: vi.fn(), isRunning: () => false, emitStep: vi.fn() },
  }),
}));
vi.mock('../src/components/MoaAssistant', () => ({ MoaAssistant: () => null }));
vi.mock('../src/components/SampleModuleWrapper', () => ({ SampleModuleWrapper: () => null }));
vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: { userId: 'user-me' } }));

import { DrumMachineTerminal } from '../src/components/DrumMachineTerminal';
import { CAPTURE_DRUM_MERGE_EVENT, type CaptureDrumMergeDetail } from '../src/core/capture/captureDrumPatterns';

function dispatchMerge(hits: CaptureDrumMergeDetail['hits']): CaptureDrumMergeDetail {
  const detail: CaptureDrumMergeDetail = { hits, handled: false };
  act(() => { window.dispatchEvent(new CustomEvent(CAPTURE_DRUM_MERGE_EVENT, { detail })); });
  return detail;
}

beforeEach(() => {
  writes.length = 0;
  lock.active = false;
  lock.lockedBy = '';
  for (const k of Object.keys(engine.patterns)) delete engine.patterns[k];
  for (const t of ALL_TRACKS) engine.patterns[t] = new Array(16).fill(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('drumsamplerMONK · Capture', () => {
  it('Pad-Klick geht als drum-pad ins Capture-Log', () => {
    render(<DrumMachineTerminal />);
    fireEvent.click(screen.getByRole('button', { name: /Snare/ }));
    expect(engine.triggerDrumSound).toHaveBeenCalledWith('tr-808', 'snare', 1, 'drum-pad');
  });

  it('übernommener Takt erscheint sofort in der Step-Ansicht und geht in die Session', () => {
    render(<DrumMachineTerminal />);
    // Gewählter Sound ist der erste des Kits (Bass Drum).
    expect(screen.getByRole('button', { name: 'Step 5 an' })).toBeTruthy();
    const detail = dispatchMerge([
      { bar: 0, step: 4, kitId: 'tr-808', soundId: 'kick', velocity: 1 },
      { bar: 0, step: 12, kitId: 'tr-808', soundId: 'kick', velocity: 1 },
      { bar: 0, step: 2, kitId: 'tr-808', soundId: 'snare', velocity: 1 },
    ]);
    expect(detail.handled).toBe(true);
    expect(detail.bank).toBe('A');
    // aria-label „Step n aus“ = Step ist an (Klick schaltet aus).
    expect(screen.getByRole('button', { name: 'Step 5 aus' }).className).toMatch(/am-v2/);
    expect(screen.getByRole('button', { name: 'Step 13 aus' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Snare/ }).textContent).toMatch(/1\/16/);
    const last = writes.filter((w) => w.id === 'drumsampler').at(-1)!;
    const patterns = last.s.patterns as Record<string, boolean[]>;
    expect(patterns['A:tr-808:kick'][4]).toBe(true);
    expect(patterns['A:tr-808:snare'][2]).toBe(true);
  });

  it('gesperrt für einen anderen Nutzer (B2B): keine Übernahme', () => {
    lock.active = true;
    lock.lockedBy = 'user-other';
    render(<DrumMachineTerminal />);
    const detail = dispatchMerge([{ bar: 0, step: 4, kitId: 'tr-808', soundId: 'kick', velocity: 1 }]);
    expect(detail.handled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Step 5 aus' })).toBeNull();
  });

  it('Engine-Kanal-Patterns (Ziel der Kanal-Steps) werden angezeigt und folgen Änderungen', () => {
    render(<DrumMachineTerminal />);
    expect(screen.queryByRole('table', { name: 'Kanal-Pattern der Engine' })).toBeNull();
    act(() => {
      (engine.patterns as Record<TrackType, boolean[]>).channel5[6] = true;
      engine.listeners.forEach((l) => l());
    });
    expect(screen.getByRole('table', { name: 'Kanal-Pattern der Engine' })).toBeTruthy();
    expect(screen.getByLabelText('Kanal 5, Step 7: an')).toBeTruthy();
  });
});
