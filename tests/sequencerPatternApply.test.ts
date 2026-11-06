// @vitest-environment jsdom
/**
 * MONK-2026-11-06-001 – `monk:apply-patterns` muss die Engine wirklich beschreiben.
 * ================================================================================
 * Der Stresstest dispatcht `monk:apply-patterns` als Engine-Last; im Client gab
 * es dafür keinen Listener. Diese Tests pinnen den geschlossenen Pfad:
 *
 *   window `monk:apply-patterns` (Legacy/Stress)  ─┐
 *   ControlBus `sequencer:apply-patterns` (typisiert) ─┴→ SequencerPatternApplier
 *                                                        → audioEngine.loadPatterns()
 *
 * Geprüft wird der Zustand NACH dem Event (Sequencer-Inhalt, BPM, Zähler) und
 * ausdrücklich auch, dass ohne Event nichts passiert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_TRACKS } from '../src/types';
import { ControlBus } from '../src/core/events/ControlBus';
import { SequencerState } from '../src/audio/sequencerState';
import { generateRhythmicPattern } from '../src/utils/aiRhythmGenerator';
import {
  APPLY_PATTERNS_EVENT,
  LEGACY_APPLY_PATTERNS_EVENT,
  MAX_PATTERN_SLOTS,
  SequencerPatternApplier,
  installSequencerPatternApply,
} from '../src/core/audio/sequencerPatternApply';

/** Pattern-Matrix wie SoundTerminal/Stresstest sie schickt (8 Spuren × 16 Steps). */
function matrix(seed: number): Record<string, boolean[]> {
  const out: Record<string, boolean[]> = {};
  ALL_TRACKS.forEach((track, i) => {
    out[track] = Array.from({ length: 16 }, (_, step) => (step + i + seed) % 4 === 0);
  });
  return out;
}

type LoadCall = { patterns: Record<string, boolean[]>; synthNotes?: number[]; bpm?: number };

function recordingTarget() {
  const calls: LoadCall[] = [];
  return {
    calls,
    loadPatterns: vi.fn((patterns: Record<string, boolean[]>, synthNotes?: number[], bpm?: number) => {
      calls.push({ patterns, synthNotes, bpm });
    }),
  };
}

describe('SequencerPatternApplier (Event -> Engine)', () => {
  let bus: ControlBus;

  beforeEach(() => {
    bus = new ControlBus();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    bus.clear();
    vi.restoreAllMocks();
  });

  it('ohne Event passiert nichts (keine Engine-Anwendung, Zähler bleibt 0)', () => {
    const target = recordingTarget();
    const { uninstall } = installSequencerPatternApply({ target, bus, win: window });
    try {
      // Nur Zeit vergehen lassen: kein Dispatch, kein Bus-Emit.
      expect(target.loadPatterns).not.toHaveBeenCalled();
      expect(uninstall).toBeTypeOf('function');
    } finally {
      uninstall();
    }
  });

  it('window-Event `monk:apply-patterns` schreibt Patterns und BPM in die Engine', () => {
    const target = recordingTarget();
    const applier = new SequencerPatternApplier(target);
    const { uninstall } = installSequencerPatternApply({ target, bus, win: window, applier });
    try {
      const patterns = matrix(1);
      window.dispatchEvent(
        new CustomEvent(LEGACY_APPLY_PATTERNS_EVENT, { detail: { patterns, bpm: 137 } }),
      );

      expect(target.loadPatterns).toHaveBeenCalledTimes(1);
      expect(target.calls[0].patterns).toEqual(patterns);
      expect(target.calls[0].bpm).toBe(137);
      const stats = applier.snapshot();
      expect(stats.applied).toBe(1);
      expect(stats.slotsApplied).toBe(1);
      expect(stats.lastBpm).toBe(137);
      expect(stats.lastError).toBeNull();
    } finally {
      uninstall();
    }
  });

  it('ControlBus-Kanal `sequencer:apply-patterns` ist derselbe Pfad', () => {
    const target = recordingTarget();
    const applier = new SequencerPatternApplier(target);
    const { uninstall } = installSequencerPatternApply({ target, bus, win: window, applier });
    try {
      const patterns = matrix(2);
      const synthNotes = Array.from({ length: 16 }, (_, i) => [0, 4, 7][i % 3]);
      bus.emit(APPLY_PATTERNS_EVENT, { patterns, synthNotes, bpm: 96 });

      expect(target.loadPatterns).toHaveBeenCalledTimes(1);
      expect(target.calls[0]).toEqual({ patterns, synthNotes, bpm: 96 });
      expect(applier.snapshot().applied).toBe(1);
    } finally {
      uninstall();
    }
  });

  it('vier Pattern-Slots werden einzeln angewendet (letzter Slot gewinnt im Sink)', () => {
    const target = recordingTarget();
    const applier = new SequencerPatternApplier(target);
    const { uninstall } = installSequencerPatternApply({ target, bus, win: window, applier });
    try {
      const slots = [matrix(11), matrix(12), matrix(13), matrix(14)];
      window.dispatchEvent(
        new CustomEvent(LEGACY_APPLY_PATTERNS_EVENT, { detail: { slots, bpm: 128 } }),
      );

      expect(MAX_PATTERN_SLOTS).toBe(4);
      expect(target.loadPatterns).toHaveBeenCalledTimes(4);
      expect(target.calls.map((c) => c.patterns)).toEqual(slots);
      // BPM wird genau einmal je Event gesetzt, nicht je Slot.
      expect(target.calls.every((c) => c.bpm === 128)).toBe(true);
      expect(applier.snapshot().slotsApplied).toBe(4);
      expect(applier.snapshot().applied).toBe(4);
    } finally {
      uninstall();
    }
  });

  it('mehr als vier Slots werden auf vier begrenzt (kein ungebremster Durchlauf)', () => {
    const target = recordingTarget();
    const applier = new SequencerPatternApplier(target);
    const { uninstall } = installSequencerPatternApply({ target, bus, win: window, applier });
    try {
      const slots = Array.from({ length: 9 }, (_, i) => matrix(20 + i));
      window.dispatchEvent(
        new CustomEvent(LEGACY_APPLY_PATTERNS_EVENT, { detail: { slots, bpm: 120 } }),
      );
      expect(target.loadPatterns).toHaveBeenCalledTimes(MAX_PATTERN_SLOTS);
    } finally {
      uninstall();
    }
  });

  it('ungültige Payload wird verworfen (falsche Step-Länge, kein Objekt)', () => {
    const target = recordingTarget();
    const applier = new SequencerPatternApplier(target);
    const { uninstall } = installSequencerPatternApply({ target, bus, win: window, applier });
    try {
      window.dispatchEvent(
        new CustomEvent(LEGACY_APPLY_PATTERNS_EVENT, {
          detail: { patterns: { channel1: [true, false, true] }, bpm: 128 },
        }),
      );
      window.dispatchEvent(new CustomEvent(LEGACY_APPLY_PATTERNS_EVENT, { detail: null }));

      expect(target.loadPatterns).not.toHaveBeenCalled();
      expect(applier.snapshot().applied).toBe(0);
      expect(applier.snapshot().rejected).toBe(2);
    } finally {
      uninstall();
    }
  });

  it('uninstall() entfernt beide Listener (kein Nachfeuern)', () => {
    const target = recordingTarget();
    const { uninstall } = installSequencerPatternApply({ target, bus, win: window });
    uninstall();

    window.dispatchEvent(
      new CustomEvent(LEGACY_APPLY_PATTERNS_EVENT, { detail: { patterns: matrix(3), bpm: 100 } }),
    );
    bus.emit(APPLY_PATTERNS_EVENT, { patterns: matrix(4), bpm: 100 });

    expect(target.loadPatterns).not.toHaveBeenCalled();
  });

  it('SoundTerminal-Nutzlast (generateRhythmicPattern, 16 Steps) kommt unverändert an', () => {
    const target = recordingTarget();
    const applier = new SequencerPatternApplier(target);
    const { uninstall } = installSequencerPatternApply({ target, bus, win: window, applier });
    try {
      // Genau der Aufruf aus SoundTerminal (beat-Zweig): Bus-Kanal + bpm 128.
      const patterns = generateRhythmicPattern('techno');
      bus.emit(APPLY_PATTERNS_EVENT, { patterns, bpm: 128 });

      expect(target.loadPatterns).toHaveBeenCalledTimes(1);
      expect(target.calls[0].patterns.channel1).toEqual(patterns.channel1);
      expect(target.calls[0].patterns.channel2).toEqual(patterns.channel2);
      expect(target.calls[0].bpm).toBe(128);
      expect(applier.snapshot().rejected).toBe(0);
    } finally {
      uninstall();
    }
  });

  it('Engine-Zustand ändert sich: SequencerState übernimmt den Event-Inhalt', () => {
    const state = new SequencerState(
      { setLivePattern: () => {}, getStepCount: () => 16, getCurrentStep: () => 0 },
      () => {},
    );
    const revisionBefore = state.getPatternRevision();
    const target = {
      loadPatterns: (patterns: Record<string, boolean[]>, synthNotes?: number[]) =>
        state.applyLoadedPatterns(patterns, synthNotes),
    };
    const applier = new SequencerPatternApplier(target);
    const { uninstall } = installSequencerPatternApply({ target, bus, win: window, applier });
    try {
      const patterns = matrix(5);
      window.dispatchEvent(
        new CustomEvent(LEGACY_APPLY_PATTERNS_EVENT, { detail: { patterns, bpm: 142 } }),
      );

      expect(state.pattern('channel1')).toEqual(patterns.channel1);
      expect(state.pattern('channel8')).toEqual(patterns.channel8);
      expect(state.getPatternRevision()).toBeGreaterThan(revisionBefore);
      expect(applier.snapshot().lastBpm).toBe(142);
    } finally {
      uninstall();
    }
  });
});
