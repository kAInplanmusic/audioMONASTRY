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
const { pluginSettings } = vi.hoisted(() => ({ pluginSettings: new Map<string, Record<string, unknown>>() }));
vi.mock('../src/utils/pluginSettings', () => ({
  readPluginSettings: (id: string) => pluginSettings.get(id) ?? null,
  writePluginSettings: (id: string, s: Record<string, unknown>) => { pluginSettings.set(id, s); },
}));

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
    drumHits: [],
    capturedAtSec: 10,
    ...partial,
  };
}

beforeEach(() => {
  engine.supported = true;
  for (const k of Object.keys(locks)) delete locks[k];
  pluginSettings.clear();
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
    // IDEA-2026-10-07-A-F1: erst Ziel bestätigen, dann übernehmen.
    expect(engine.mergeCapturedBar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Übernahme bestätigen' }));
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

describe('IDEA-2026-10-07-A-F1 · Sequencer-Ziel bestätigen + drumsamplerMONK', () => {
  const drumHits = [
    { bar: 1, step: 0, kitId: 'tr-808', soundId: 'kick', velocity: 1 },
    { bar: 1, step: 4, kitId: 'tr-808', soundId: 'snare', velocity: 0.8 },
    { bar: 0, step: 2, kitId: 'tr-808', soundId: 'kick', velocity: 1 }, // anderer Takt
  ];

  async function openDialog(partial: Partial<CaptureResult> = {}) {
    locks[CAPTURE_SEQUENCER_PLUGIN_ID] = { active: true, lockedBy: 'user-me' };
    engine.captureNow.mockResolvedValue(result({ drumHits, ...partial }));
    const view = render(<CaptureControl mainHolder />);
    fireEvent.click(screen.getByRole('button', { name: /Capture/ }));
    await screen.findByRole('dialog', { name: /Pattern-Vorschlag/ });
    return view;
  }

  it('Vorschau zeigt die Drum-Zeilen des gewählten Takts', async () => {
    await openDialog();
    expect(screen.getByLabelText('Drum TR-808 · Bass Drum, Step 1: an')).toBeTruthy();
    expect(screen.getByLabelText('Drum TR-808 · Snare, Step 5: an')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Takt zurück' }));
    expect(screen.getByLabelText('Drum TR-808 · Bass Drum, Step 3: an')).toBeTruthy();
    expect(screen.queryByLabelText(/Drum TR-808 · Snare/)).toBeNull();
  });

  it('Bestätigungs-Dialog nennt Ziel, Takt und Mengen; Abbrechen übernimmt nichts', async () => {
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'In Sequencer übernehmen' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Sequencer-Ziel bestätigen' });
    expect(confirm.textContent).toMatch(/Takt 2 → drumsamplerMONK/);
    expect(confirm.textContent).toMatch(/2 Drum-Steps in die Drum-Pattern-Ansicht, 2 Kanal-Steps/);
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(engine.mergeCapturedBar).not.toHaveBeenCalled();
    expect(pluginSettings.size).toBe(0);
  });

  it('Lock geht vor dem Bestätigen verloren → keine Übernahme (B2B)', async () => {
    const view = await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'In Sequencer übernehmen' }));
    locks[CAPTURE_SEQUENCER_PLUGIN_ID] = { active: true, lockedBy: 'user-other' };
    view.rerender(<CaptureControl mainHolder />);
    const btn = screen.getByRole('button', { name: 'Übernahme bestätigen' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(engine.mergeCapturedBar).not.toHaveBeenCalled();
    expect(pluginSettings.size).toBe(0);
  });

  it('offenes drumsamplerMONK-Terminal übernimmt die Drum-Schläge selbst (aktuelle Bank)', async () => {
    const received: unknown[] = [];
    const onMerge = (ev: Event) => {
      const d = (ev as CustomEvent<{ hits: unknown[]; handled: boolean; bank?: string }>).detail;
      received.push(d.hits);
      d.handled = true;
      d.bank = 'B';
    };
    window.addEventListener('monk:capture-drum-merge', onMerge);
    try {
      await openDialog();
      fireEvent.click(screen.getByRole('button', { name: 'In Sequencer übernehmen' }));
      fireEvent.click(screen.getByRole('button', { name: 'Übernahme bestätigen' }));
    } finally {
      window.removeEventListener('monk:capture-drum-merge', onMerge);
    }
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([
      { bar: 0, step: 0, kitId: 'tr-808', soundId: 'kick', velocity: 1 },
      { bar: 0, step: 4, kitId: 'tr-808', soundId: 'snare', velocity: 0.8 },
    ]);
    expect(pluginSettings.size).toBe(0); // Terminal schreibt selbst (Persistenz-Effekt)
    expect(screen.getByRole('status').textContent).toMatch(/2 Drum-Steps \(Bank B\)/);
  });

  it('ohne offenes Terminal landen die Schläge direkt in den drumsampler-Settings (Bank A, ODER)', async () => {
    pluginSettings.set('drumsampler', { kit: 'tr-808', patterns: { 'A:tr-808:kick': [false, true, ...new Array<boolean>(14).fill(false)] } });
    await openDialog({ bars: [bar(), bar()] }); // nur Drum-Schläge
    fireEvent.click(screen.getByRole('button', { name: 'In Sequencer übernehmen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Übernahme bestätigen' }));
    expect(engine.mergeCapturedBar).not.toHaveBeenCalled(); // keine Kanal-Steps
    const saved = pluginSettings.get('drumsampler') as { kit: string; patterns: Record<string, boolean[]> };
    expect(saved.kit).toBe('tr-808');
    expect(saved.patterns['A:tr-808:kick'].slice(0, 2)).toEqual([true, true]);
    expect(saved.patterns['A:tr-808:snare'][4]).toBe(true);
  });

  it('„Als Pattern merken“ speichert die Drum-Schläge des Takts mit', async () => {
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Als Pattern merken' }));
    const [entry] = listCapturePatterns();
    expect(entry.drumHits).toEqual([drumHits[0], drumHits[1]]);
  });
});
