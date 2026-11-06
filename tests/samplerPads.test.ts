import { describe, expect, it, vi } from 'vitest';
import {
  BANK_TRACKS,
  PAD_COUNT,
  SAMPLER_BANKS,
  emptyPadsByBank,
  firstFreePad,
  padSlot,
  padTrack,
  padsFromSettings,
  padsToSettings,
  updateBankPad,
  auditionPad,
  type SamplerPad,
  type PadsByBank,
} from '../src/core/sampler/samplerPads';
import { captureToClip } from '../src/core/sampler/samplerCapture';
import type { CaptureResult } from '../src/core/capture/captureSession';

/**
 * UI-2026-11-06-003 (b): Pad-Mapping und Pad-Zustand je Bank.
 *
 * Vorher war `pads` EIN Array, die Bank wirkte nur auf Sequencer/UI, und das
 * Audio-Ziel war `SAMPLE_TRACKS[i % 4]` ohne Bankbezug: Bank B Pad 1 schrieb auf
 * denselben Track wie Bank A Pad 1 und überschrieb dessen Sample. Hier wird die
 * reine Zuordnung/der Zustand geprüft, damit die Regression ohne AudioContext
 * reproduzierbar bleibt.
 */

const pad = (over: Partial<SamplerPad> = {}): SamplerPad => ({
  name: 'PAD 01', filled: false, color: '#fff', slice: 1, loop: false, reverse: false, pitch: 0, ...over,
});

describe('Sampler-Pad-Mapping (bank- und padspezifisch)', () => {
  it('hat 16 Pads je Bank und zwei Bänke', () => {
    expect(SAMPLER_BANKS).toEqual(['A', 'B']);
    expect(PAD_COUNT).toBe(16);
    const pads = emptyPadsByBank();
    expect(pads.A).toHaveLength(16);
    expect(pads.B).toHaveLength(16);
    expect(pads.A[0].filled).toBe(false);
  });

  it('Pickt für dieselbe Pad-Nummer in Bank A und B verschiedene Audio-Ziele', () => {
    for (let i = 0; i < PAD_COUNT; i++) {
      expect(padTrack('A', i), `Pad ${i + 1}`).not.toBe(padTrack('B', i));
    }
    // Bank A und B teilen sich keinen Track – sonst überschreibt eine Bank die andere.
    const a = new Set(BANK_TRACKS.A);
    const b = new Set(BANK_TRACKS.B);
    for (const t of b) expect(a.has(t)).toBe(false);
  });

  it('nutzt innerhalb einer Bank alle vorgesehenen Stimmen und bleibt deterministisch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < PAD_COUNT; i++) {
      seen.add(padTrack('A', i));
      expect(padTrack('A', i)).toBe(padTrack('A', i));
    }
    expect([...seen].sort()).toEqual([...BANK_TRACKS.A].sort());
  });

  it('Pad-Slots sind je (Bank, Pad) eindeutig', () => {
    const slots = new Set<string>();
    for (const bank of SAMPLER_BANKS) {
      for (let i = 0; i < PAD_COUNT; i++) slots.add(padSlot(bank, i));
    }
    expect(slots.size).toBe(SAMPLER_BANKS.length * PAD_COUNT);
    expect(padSlot('A', 0)).toBe('A:0');
  });
});

describe('Pad-Zustand je Bank', () => {
  it('ein Schreibzugriff auf Bank A lässt Bank B unverändert', () => {
    const base = emptyPadsByBank();
    const next = updateBankPad(base, 'A', 0, { filled: true, name: 'CAP A1' });
    expect(next).not.toBe(base);
    expect(next.A[0].filled).toBe(true);
    expect(next.A[0].name).toBe('CAP A1');
    expect(next.B[0].filled).toBe(false);
    expect(next.B[0].name).toBe('PAD 01');
    // Unveränderte Bank bleibt referenzgleich (kein unnötiges Re-Render).
    expect(next.B).toBe(base.B);
    expect(base.A[0].filled).toBe(false);
  });

  it('findet das erste freie Pad einer Bank, -1 wenn alle belegt sind', () => {
    const pads = [pad({ filled: true }), pad(), pad()];
    expect(firstFreePad(pads)).toBe(1);
    expect(firstFreePad([pad({ filled: true })] as SamplerPad[])).toBe(-1);
    expect(firstFreePad([])).toBe(-1);
  });

  it('persistiert Regler je Bank und liest das alte Ein-Array als Bank A', () => {
    const state: PadsByBank = emptyPadsByBank();
    state.A[2] = { ...state.A[2], slice: 3, loop: true, pitch: -5 };
    state.B[4] = { ...state.B[4], reverse: true };
    const saved = padsToSettings(state);
    expect(saved.A).toHaveLength(16);
    expect(saved.B).toHaveLength(16);
    expect(saved.A[2]).toMatchObject({ slice: 3, loop: true, pitch: -5 });
    expect(saved.B[4]).toMatchObject({ reverse: true });
    // Nur Regler, keine Audio-URLs/flüchtigen Füllstände.
    expect(Object.keys(saved.A[0]).sort()).toEqual(['loop', 'pitch', 'reverse', 'slice']);

    const restored = padsFromSettings(saved);
    expect(restored.A[2]).toMatchObject({ slice: 3, loop: true, pitch: -5 });
    expect(restored.B[4].reverse).toBe(true);
    expect(restored.A[2].filled).toBe(false);

    const legacy = padsFromSettings([{ slice: 2, loop: true }]);
    expect(legacy.A[0]).toMatchObject({ slice: 2, loop: true });
    expect(legacy.B[0].slice).toBe(1);
  });
});

describe('auditionPad – das Pad spielt sein eigenes Sample', () => {
  const api = (loadedUrl: string | null) => ({
    getTrackSampleUrl: vi.fn(() => loadedUrl),
    loadTrackSample: vi.fn(async () => {}),
    triggerEvent: vi.fn(),
    setChannelPan: vi.fn(),
  });

  it('lädt das Pad-Sample nach, wenn der Ziel-Track ein anderes Sample hält', async () => {
    const a = api('blob://anderes');
    await auditionPad(a, 'channel5', pad({ filled: true, url: 'blob://pad-b1' }));
    expect(a.loadTrackSample).toHaveBeenCalledWith('channel5', 'blob://pad-b1');
    expect(a.triggerEvent).toHaveBeenCalledWith('channel5', expect.any(Number));
    // Reihenfolge: erst laden, dann triggern (sonst spielt das alte Sample).
    const loadOrder = (a.loadTrackSample as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    const trigOrder = (a.triggerEvent as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    expect(loadOrder).toBeLessThan(trigOrder);
  });

  it('lädt nicht erneut, wenn der Track schon das Pad-Sample hält', async () => {
    const a = api('blob://pad-b1');
    await auditionPad(a, 'channel1', pad({ filled: true, url: 'blob://pad-b1' }));
    expect(a.loadTrackSample).not.toHaveBeenCalled();
    expect(a.triggerEvent).toHaveBeenCalledTimes(1);
  });

  it('triggert ein leeres Pad nicht und setzt Pan nur bei Pitch', async () => {
    const empty = api(null);
    await auditionPad(empty, 'channel1', pad());
    expect(empty.triggerEvent).not.toHaveBeenCalled();

    const pitched = api('blob://x');
    await auditionPad(pitched, 'channel1', pad({ filled: true, url: 'blob://x', pitch: 12 }), 0.9, 0);
    expect(pitched.setChannelPan).toHaveBeenCalledWith('channel1', 1);
  });
});

describe('captureToClip – echter Abgriff statt setTimeout', () => {
  const audioResult = (amplitude = 0.5): Pick<CaptureResult, 'audio' | 'audioUnavailable'> => {
    const sampleRate = 48000;
    const frames = 2400;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amplitude;
      right[i] = left[i];
    }
    return { audio: { left, right, sampleRate, seconds: frames / sampleRate } };
  };

  it('erzeugt ein WAV aus dem Capture-Ergebnis (Länge > 0)', () => {
    const out = captureToClip(audioResult());
    expect(out.ok).toBe(true);
    if (!('clip' in out)) return;
    expect(out.clip.seconds).toBeGreaterThan(0.01);
    expect(out.clip.blob.size).toBeGreaterThan(44);
    expect(out.clip.blob.type).toBe('audio/wav');
  });

  it('nennt den Grund, wenn kein Abgriff läuft oder nichts zu hören ist', () => {
    const unsupported = captureToClip({ audio: null, audioUnavailable: 'unsupported' });
    expect(unsupported.ok).toBe(false);
    if ('reason' in unsupported) expect(unsupported.reason).toMatch(/SharedArrayBuffer|nicht verfügbar/i);

    const notRunning = captureToClip({ audio: null, audioUnavailable: 'not-running' });
    expect(notRunning.ok).toBe(false);
    if ('reason' in notRunning) expect(notRunning.reason).toMatch(/Main einmal starten/i);

    const silent = captureToClip(audioResult(0));
    expect(silent.ok).toBe(false);
    if ('reason' in silent) expect(silent.reason).toMatch(/still|nichts/i);
  });
});
