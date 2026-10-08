// @vitest-environment jsdom
/**
 * IDEA-2026-10-07-A · Capture-Knopf im mastergraphMONK.
 *
 * Rechte: nur der mixerMONK-Halter darf capturen; ohne SharedArrayBuffer ist
 * der Knopf aus. „In Sequencer übernehmen“ nur für den Halter des
 * Sequencer-Plugins (zentraler Lock). Audio geht über addSample (Server).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ALL_TRACKS, type TrackType } from '../src/types';
import type { CaptureResult } from '../src/core/capture/captureSession';

const { addSample, locks, engine } = vi.hoisted(() => {
  const engine = {
    supported: true,
    isCaptureSupported: () => engine.supported,
    captureNow: vi.fn<() => Promise<CaptureResult>>(),
    mergeCapturedBar: vi.fn(),
  };
  return {
    addSample: vi.fn(),
    locks: {} as Record<string, { active: boolean; lockedBy: string }>,
    engine,
  };
});

vi.mock('../src/utils/audioEngine', () => ({ audioEngine: engine }));
vi.mock('../src/context/SampleContext', () => ({ useSamples: () => ({ addSample }) }));
vi.mock('../src/context/PluginManagerContext', () => ({ usePluginManager: () => ({ pluginLocks: locks }) }));
vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: { userId: 'user-me' } }));

import { CaptureControl, CAPTURE_SEQUENCER_PLUGIN_ID } from '../src/components/am/CaptureControl';
import { CAPTURE_PATTERNS_KEY, listCapturePatterns } from '../src/core/capture/capturePatternStore';
import { isMemoryOnlyKey, resetStorageForTests } from '../src/utils/storage';

function bar(hits: Partial<Record<TrackType, number[]>> = {}) {
  const b = Object.fromEntries(ALL_TRACKS.map((t) => [t, new Array(16).fill(false)])) as Record<TrackType, boolean[]>;
  for (const [t, steps] of Object.entries(hits)) for (const s of steps ?? []) b[t as TrackType][s] = true;
  return b;
}

function result(partial: Partial<CaptureResult> = {}): CaptureResult {
  const left = new Float32Array(4800);
  left.fill(0.25, 1200);
  return {
    audio: { left, right: left.slice(), sampleRate: 48000, seconds: 0.1 },
    bars: [bar({ channel1: [0] }), bar({ channel3: [2, 6] })],
    suggestedBarIndex: 1,
    bpm: 124,
    notes: [],
    capturedAtSec: 10,
    ...partial,
  };
}

beforeEach(() => {
  engine.supported = true;
  for (const k of Object.keys(locks)) delete locks[k];
  resetStorageForTests();
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => 'blob:capture-test');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CaptureControl · Rechte', () => {
  it('ist für Nicht-Halter ausgegraut mit Hinweis „Capture macht der Mixer-Halter“', () => {
    render(<CaptureControl mainHolder={false} />);
    const btn = screen.getByRole('button', { name: /Capture/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Capture macht der Mixer-Halter');
    fireEvent.click(btn);
    expect(engine.captureNow).not.toHaveBeenCalled();
  });

  it('ist ohne SharedArrayBuffer ausgegraut und zeigt einen Hinweis', () => {
    engine.supported = false;
    render(<CaptureControl mainHolder />);
    const btn = screen.getByRole('button', { name: /Capture/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/SharedArrayBuffer/);
    expect(screen.getByRole('note').textContent).toMatch(/nicht verfügbar/);
  });

  it('ist für den Mixer-Halter aktiv', () => {
    render(<CaptureControl mainHolder />);
    expect((screen.getByRole('button', { name: /Capture/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('CaptureControl · Klick', () => {
  it('legt das Audio still als recording in der Bibliothek ab und zeigt den Vorschlag', async () => {
    engine.captureNow.mockResolvedValue(result());
    render(<CaptureControl mainHolder />);
    fireEvent.click(screen.getByRole('button', { name: /Capture/ }));
    await screen.findByRole('dialog', { name: /Pattern-Vorschlag/ });

    expect(addSample).toHaveBeenCalledTimes(1);
    const sample = addSample.mock.calls[0][0];
    expect(sample).toMatchObject({ type: 'recording', url: 'blob:capture-test', tags: ['capture', '124bpm'] });
    expect(sample.id).toMatch(/^capture-\d+$/);
    expect(sample.name).toMatch(/^Capture \d\d:\d\d:\d\d$/);
    // Führende Stille (1200 Frames) abgeschnitten → 3600 Frames = 0,075 s.
    expect(screen.getByRole('status').textContent).toMatch(/0\.1 s Audio still in der Bibliothek/);

    expect(screen.getByText('Takt 2 / 2')).toBeTruthy();
    expect(screen.getByLabelText('Spur 3, Step 3: an')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Takt zurück' }));
    expect(screen.getByText('Takt 1 / 2')).toBeTruthy();
    expect(screen.getByLabelText('Spur 1, Step 1: an')).toBeTruthy();
  });

  it('nur Stille → „Noch nichts zu hören“, kein Bibliothekseintrag', async () => {
    engine.captureNow.mockResolvedValue(result({
      audio: { left: new Float32Array(100), right: new Float32Array(100), sampleRate: 48000, seconds: 0 },
      suggestedBarIndex: -1,
      bars: [],
    }));
    render(<CaptureControl mainHolder />);
    fireEvent.click(screen.getByRole('button', { name: /Capture/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Noch nichts zu hören/));
    expect(addSample).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('„In Sequencer übernehmen“ nur für den Sequencer-Halter', async () => {
    locks[CAPTURE_SEQUENCER_PLUGIN_ID] = { active: true, lockedBy: 'user-other' };
    engine.captureNow.mockResolvedValue(result());
    const view = render(<CaptureControl mainHolder />);
    fireEvent.click(screen.getByRole('button', { name: /Capture/ }));
    await screen.findByRole('dialog');
    const apply = screen.getByRole('button', { name: 'In Sequencer übernehmen' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.getByText(/nur der Halter darf übernehmen/)).toBeTruthy();
    fireEvent.click(apply);
    expect(engine.mergeCapturedBar).not.toHaveBeenCalled();

    locks[CAPTURE_SEQUENCER_PLUGIN_ID] = { active: true, lockedBy: 'user-me' };
    view.rerender(<CaptureControl mainHolder />);
    const apply2 = screen.getByRole('button', { name: 'In Sequencer übernehmen' }) as HTMLButtonElement;
    expect(apply2.disabled).toBe(false);
    fireEvent.click(apply2);
    expect(engine.mergeCapturedBar).toHaveBeenCalledWith(result().bars[1]);
  });

  it('„Als Pattern merken“ speichert im Studio-Speicher (nicht nur im Speicher), max. 32', async () => {
    expect(isMemoryOnlyKey(CAPTURE_PATTERNS_KEY)).toBe(false);
    engine.captureNow.mockResolvedValue(result());
    render(<CaptureControl mainHolder />);
    fireEvent.click(screen.getByRole('button', { name: /Capture/ }));
    await screen.findByRole('dialog');
    for (let i = 0; i < 34; i++) fireEvent.click(screen.getByRole('button', { name: 'Als Pattern merken' }));
    const list = listCapturePatterns();
    expect(list).toHaveLength(32);
    expect(list[31].bar.channel3[2]).toBe(true);
    expect(list[31].bpm).toBe(124);
  });
});
