import { describe, expect, it } from 'vitest';
import {
  AdaptiveLatencyController,
  LATENCY_PROFILE_LOOKAHEAD_MS,
} from '../src/utils/adaptiveLatency';

describe('AM-E6-2: AdaptiveLatencyController (Latenz vs. Durchsatz)', () => {
  it('liefert das Basis-Lookahead je Profil', () => {
    expect(new AdaptiveLatencyController('interactive').snapshot().lookaheadMs).toBe(8);
    expect(new AdaptiveLatencyController('balanced').snapshot().lookaheadMs).toBe(12);
    expect(new AdaptiveLatencyController('playback').snapshot().lookaheadMs).toBe(15);
    expect(LATENCY_PROFILE_LOOKAHEAD_MS.interactive).toBe(8);
    expect(LATENCY_PROFILE_LOOKAHEAD_MS.balanced).toBe(12);
    expect(LATENCY_PROFILE_LOOKAHEAD_MS.playback).toBe(15);
  });

  it('erhöht das Lookahead schrittweise pro Xrun bis max. 15 ms', () => {
    const c = new AdaptiveLatencyController('interactive');
    expect(c.recordXrun()).toBe(10); // 8 + 1*2
    expect(c.recordXrun()).toBe(12); // 8 + 2*2
    expect(c.snapshot().consecutiveXruns).toBe(2);
  });

  it('eskaliert das Profil nach 3 konsekutiven Xruns (interactive → balanced)', () => {
    const c = new AdaptiveLatencyController('interactive');
    c.recordXrun();
    c.recordXrun();
    expect(c.snapshot().profile).toBe('interactive');
    const lookahead = c.recordXrun();
    expect(c.snapshot().profile).toBe('balanced');
    expect(c.snapshot().escalated).toBe(true);
    expect(lookahead).toBe(15); // 12 + 3*2 gedeckelt auf 15
  });

  it('deckelt das Lookahead bei 15 ms auch bei vielen Xruns', () => {
    const c = new AdaptiveLatencyController('interactive');
    for (let i = 0; i < 10; i++) c.recordXrun();
    expect(c.snapshot().lookaheadMs).toBe(15);
    expect(c.snapshot().lookaheadMs).toBeLessThanOrEqual(15);
  });

  it('eskaliert maximal bis playback (kein Überlauf)', () => {
    const c = new AdaptiveLatencyController('interactive');
    for (let i = 0; i < 20; i++) c.recordXrun();
    expect(c.snapshot().profile).toBe('playback');
  });

  it('baut stabile Fenster den Xrun-Zähler wieder ab', () => {
    const c = new AdaptiveLatencyController('interactive');
    c.recordXrun();
    c.recordXrun();
    c.recordXrun(); // Profil eskaliert auf balanced
    expect(c.snapshot().lookaheadMs).toBe(15);

    c.recordStableWindow();
    expect(c.snapshot().consecutiveXruns).toBe(2);
    expect(c.snapshot().lookaheadMs).toBe(15); // 12 + 2*2 = 16 → gedeckelt

    c.recordStableWindow();
    c.recordStableWindow();
    expect(c.snapshot().consecutiveXruns).toBe(0);
    expect(c.snapshot().lookaheadMs).toBe(12); // zurück auf balanced-Basis
  });

  it('applyProfile setzt Eskalation und Zähler zurück', () => {
    const c = new AdaptiveLatencyController('interactive');
    c.recordXrun();
    c.recordXrun();
    c.recordXrun();
    expect(c.snapshot().profile).toBe('balanced');

    c.applyProfile('playback');
    const s = c.snapshot();
    expect(s.profile).toBe('playback');
    expect(s.consecutiveXruns).toBe(0);
    expect(s.escalated).toBe(false);
    expect(s.lookaheadMs).toBe(15);
  });

  it('recordStableWindow ohne Xruns verändert nichts', () => {
    const c = new AdaptiveLatencyController('interactive');
    expect(c.recordStableWindow()).toBe(8);
    expect(c.snapshot().consecutiveXruns).toBe(0);
  });
});
