// @vitest-environment jsdom
/**
 * UI-2026-11-06-003 (b): CAPTURE im syntisamplerMONK nimmt WIRKLICH auf.
 *
 * Vorher war `capture()` ein Fake: `setTimeout(600)` und „Pads 1–4 füllen“ —
 * ohne AudioEngine, ohne Abgriff, ohne Ziel-Pad. Hier wird geprüft:
 *  - `audioEngine.captureNow()` wird aufgerufen und das Ergebnis in das
 *    GEWÄHLTE Pad geschrieben (nicht in Pad 1–4),
 *  - das Pad bekommt sein Sample über `loadTrackSample` auf einem eigenen,
 *    bank- und padspezifischen Ziel-Track,
 *  - Bank A und Bank B haben getrennten Pad-Zustand,
 *  - ein leerer/fehlender Abgriff füllt KEIN Pad, sondern nennt den Grund.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CaptureResult } from '../src/core/capture/captureSession';

const { engine, writes } = vi.hoisted(() => ({
  engine: {
    captureNow: vi.fn(async (): Promise<CaptureResult | null> => null),
    isCaptureSupported: vi.fn(() => true),
    loadTrackSample: vi.fn(async (_track: string, _url: string) => {}),
    getTrackSampleUrl: vi.fn((_track: string): string | null => null),
    triggerEvent: vi.fn((_track: string, _velocity?: number) => {}),
    setChannelPan: vi.fn((_track: string, _pan: number) => {}),
    addStepListener: vi.fn(() => () => {}),
  },
  writes: [] as Array<{ id: string; section?: string; s: Record<string, unknown> }>,
}));

vi.mock('../src/utils/audioEngine', () => ({ audioEngine: engine }));
vi.mock('../src/utils/pluginSettings', () => ({
  readPluginSettings: () => null,
  writePluginSettings: (id: string, s: Record<string, unknown>, opts?: { section?: string }) => {
    writes.push({ id, s, section: opts?.section });
  },
  mergeKnown: (base: Record<string, unknown>, over: unknown) => ({
    ...base,
    ...(over && typeof over === 'object' ? over : {}),
  }),
}));
vi.mock('../src/hooks/usePluginState', () => ({
  usePluginState: () => ({ state: 'PRO', lockStatus: { active: false, lockedBy: '' }, updateState: vi.fn() }),
}));
vi.mock('../src/context/SampleContext', () => ({
  useSamples: () => ({
    addSample: vi.fn(), pendingSample: null, setPendingSample: vi.fn(),
    takeoverRequest: null, clearTakeoverRequest: vi.fn(), setSelectedSample: vi.fn(),
  }),
}));
vi.mock('../src/components/MoaAssistant', () => ({ MoaAssistant: () => null }));
vi.mock('../src/utils/audioAnalyzer', () => ({ analyzeMusic: vi.fn(async () => null) }));

import { SamplerTerminal } from '../src/components/SamplerTerminal';
import { BANK_TRACKS } from '../src/core/sampler/samplerPads';

function captureResult(amplitude = 0.5): CaptureResult {
  const sampleRate = 48000;
  const frames = 4800;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
    right[i] = left[i];
  }
  return {
    audio: { left, right, sampleRate, seconds: frames / sampleRate },
    bars: [], suggestedBarIndex: -1, bpm: 128, notes: [], drumHits: [], capturedAtSec: 0,
  };
}

const lastPadsWrite = () => {
  const w = [...writes].reverse().find((x) => x.id === 'syntisampler');
  return (w?.s.pads ?? {}) as { A?: Array<{ slice: number }>; B?: Array<{ slice: number }> };
};

/** Pad-Titel tragen den Füllstand: gefüllt = Sample-Name, leer = "LEER". */
const padButton = (n: number) => screen.getByRole('button', { name: new RegExp(`^Pad ${n}:`) });

beforeEach(() => {
  writes.length = 0;
  engine.captureNow.mockReset();
  engine.loadTrackSample.mockClear();
  engine.getTrackSampleUrl.mockReset().mockReturnValue(null);
  engine.triggerEvent.mockClear();
  engine.setChannelPan.mockClear();
  engine.captureNow.mockResolvedValue(captureResult());
  globalThis.URL.createObjectURL = vi.fn(() => 'blob://capture-1') as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => cleanup());

describe('syntisamplerMONK · CAPTURE', () => {
  it('nimmt über den Audio-Abgriff auf und schreibt in das gewählte Pad', async () => {
    render(<SamplerTerminal />);
    // Pad 2 wählen, dann aufnehmen.
    fireEvent.click(padButton(2));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /CAPTURE/ })); });
    await act(async () => { await Promise.resolve(); });

    expect(engine.captureNow).toHaveBeenCalledTimes(1);
    expect(engine.loadTrackSample).toHaveBeenCalledTimes(1);
    const [track, url] = engine.loadTrackSample.mock.calls[0] as [string, string];
    expect(track).toBe(BANK_TRACKS.A[1]);
    expect(url).toBe('blob://capture-1');

    // Pad 2 ist gefüllt, Pad 1 NICHT (kein "Pads 1–4 füllen" mehr).
    expect(padButton(1).getAttribute('title') ?? '').toContain('LEER');
    expect(padButton(2).getAttribute('title') ?? '').not.toContain('LEER');
  });

  it('hält Bank A und Bank B getrennt (eigener Pad-Zustand, eigenes Audio-Ziel)', async () => {
    render(<SamplerTerminal />);
    fireEvent.click(padButton(1));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /CAPTURE/ })); });
    await act(async () => { await Promise.resolve(); });
    expect(engine.loadTrackSample.mock.calls[0][0]).toBe(BANK_TRACKS.A[0]);

    // Bank B: Pad 1 ist dort noch leer.
    fireEvent.click(screen.getByRole('button', { name: 'BANK B' }));
    expect(padButton(1).getAttribute('title') ?? '').toContain('LEER');

    fireEvent.click(padButton(1));
    engine.captureNow.mockResolvedValue(captureResult());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /CAPTURE/ })); });
    await act(async () => { await Promise.resolve(); });

    // Zweiter Ladevorgang: Bank B Pad 1 – anderer Track als Bank A Pad 1.
    expect(engine.loadTrackSample.mock.calls[1][0]).toBe(BANK_TRACKS.B[0]);
    expect(BANK_TRACKS.B[0]).not.toBe(BANK_TRACKS.A[0]);

    const pads = lastPadsWrite();
    expect(pads.B?.[0]).toBeTruthy();
    // Bank A hat weiterhin 16 Pads in der Ablage – B überschreibt sie nicht.
    expect(pads.A).toHaveLength(16);
    expect(pads.B).toHaveLength(16);
  });

  it('füllt bei fehlendem Abgriff kein Pad und nennt den Grund', async () => {
    engine.captureNow.mockResolvedValue({
      audio: null, audioUnavailable: 'not-running', bars: [], suggestedBarIndex: -1,
      bpm: 120, notes: [], drumHits: [], capturedAtSec: 0,
    } satisfies CaptureResult);
    render(<SamplerTerminal />);
    fireEvent.click(padButton(3));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /CAPTURE/ })); });
    await act(async () => { await Promise.resolve(); });

    expect(engine.loadTrackSample).not.toHaveBeenCalled();
    expect(padButton(3).getAttribute('title') ?? '').toContain('LEER');
    expect(screen.getByRole('status').textContent ?? '').toMatch(/Main einmal starten/i);
  });
});
