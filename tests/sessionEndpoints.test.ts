import { describe, expect, it } from 'vitest';
import {
  MAX_UI_ENDPOINTS,
  endpointLabel,
  endpointSlots,
  normalizeEndpointMode,
  parseSessionEndpoints,
  sanitizeEndpointReport,
  type SessionEndpoint,
} from '../src/core/session/sessionEndpoints';

// ---------------------------------------------------------------------------
// Betreiber 2026-10-06: „1–4 Nutzer, die die UI gestreamt bekommen, ein
// Main-Ausgang Sound und ein Main-Ausgang Visuals."
// ---------------------------------------------------------------------------

const user = (n: number, layout = 'desktop', w = 1440, h = 900, dpr = 1): SessionEndpoint => ({
  socketId: `s${n}`, userId: `user-${n}`, mode: 'member',
  report: { kind: 'ui', layout: layout as never, width: w, height: h, devicePixelRatio: dpr },
});

describe('sanitizeEndpointReport – die Art folgt dem Modus des Geräts', () => {
  it('Nutzer melden Format und Auflösung ihrer UI', () => {
    expect(sanitizeEndpointReport('member', { layout: 'phone-landscape', width: 852, height: 393, devicePixelRatio: 3 }))
      .toEqual({ kind: 'ui', layout: 'phone-landscape', width: 852, height: 393, devicePixelRatio: 3 });
    expect(sanitizeEndpointReport('member', { layout: 'tv', width: 852, height: 393 })).toBeNull();
  });

  it('ein Nutzer kann sich nicht als Ausgang ausgeben (und umgekehrt)', () => {
    expect(sanitizeEndpointReport('member', { state: 'live', sampleRate: 48000, channels: 2 })).toBeNull();
    const asSound = sanitizeEndpointReport('master-out', { layout: 'desktop', width: 1440, height: 900 });
    expect(asSound).toEqual({ kind: 'sound', state: 'connecting', sampleRate: 0, channels: 0 });
  });

  it('Main Sound meldet Zustand und Format, unsinnige Werte fallen auf 0', () => {
    expect(sanitizeEndpointReport('master-out', { state: 'live', sampleRate: 48000, channels: 2 }))
      .toEqual({ kind: 'sound', state: 'live', sampleRate: 48000, channels: 2 });
    expect(sanitizeEndpointReport('master-out', { state: 'hack', sampleRate: 5, channels: 999 }))
      .toEqual({ kind: 'sound', state: 'connecting', sampleRate: 0, channels: 0 });
  });

  it('Main Visual meldet Bildschirm, Zustand und ankommenden Stream', () => {
    expect(sanitizeEndpointReport('visual-out', { state: 'live', width: 1280, height: 720, devicePixelRatio: 1.5, streamWidth: 1920, streamHeight: 1080 }))
      .toEqual({ kind: 'visual', state: 'live', width: 1280, height: 720, devicePixelRatio: 1.5, streamWidth: 1920, streamHeight: 1080 });
    expect(sanitizeEndpointReport('visual-out', { state: 'live' })).toBeNull();
  });

  it('unbekannte Modi zählen als Nutzer', () => {
    expect(normalizeEndpointMode('ghost')).toBe('member');
    expect(normalizeEndpointMode('visual-out')).toBe('visual-out');
  });
});

describe('endpointSlots – 4 UI-Plätze + je ein Main-Ausgang', () => {
  it('ordnet in Beitrittsreihenfolge zu, freie Plätze bleiben leer', () => {
    const slots = endpointSlots([user(1), user(2)]);
    expect(slots.users).toHaveLength(MAX_UI_ENDPOINTS);
    expect(slots.users.map((u) => u?.userId ?? null)).toEqual(['user-1', 'user-2', null, null]);
    expect(slots.sound).toBeNull();
    expect(slots.visual).toBeNull();
  });

  it('jeder Nutzer behält sein eigenes Format', () => {
    const slots = endpointSlots([user(1, 'phone-portrait', 393, 852, 3), user(2, 'tablet-landscape', 1180, 820, 2), user(3), user(4, 'phone-landscape', 852, 393, 3)]);
    expect(slots.users.map(endpointLabel)).toEqual([
      'Handy hochkant · 1179×2556',
      'Pad quer · 2360×1640',
      'PC/Laptop · 1440×900',
      'Handy quer · 2556×1179',
    ]);
  });

  it('Ausgänge belegen keinen Nutzerplatz', () => {
    const list: SessionEndpoint[] = [
      { socketId: 'pa', userId: 'pa', mode: 'master-out', report: { kind: 'sound', state: 'live', sampleRate: 48000, channels: 2 } },
      user(1),
      { socketId: 'bm', userId: 'bm', mode: 'visual-out', report: null },
      user(2), user(3), user(4),
    ];
    const slots = endpointSlots(list);
    expect(slots.users.every(Boolean)).toBe(true);
    expect(slots.sound?.socketId).toBe('pa');
    expect(slots.visual?.socketId).toBe('bm');
  });
});

describe('Anzeige und Einlesen', () => {
  it('beschreibt Ausgänge verständlich', () => {
    expect(endpointLabel(null)).toBe('frei');
    expect(endpointLabel({ socketId: 'x', userId: 'x', mode: 'member', report: null })).toBe('verbunden');
    expect(endpointLabel({ socketId: 'p', userId: 'p', mode: 'master-out', report: { kind: 'sound', state: 'live', sampleRate: 48000, channels: 2 } }))
      .toBe('live · 48.0 kHz · 2 ch');
    expect(endpointLabel({ socketId: 'p', userId: 'p', mode: 'master-out', report: { kind: 'sound', state: 'waiting', sampleRate: 0, channels: 0 } }))
      .toBe('wartet auf Freigabe');
    expect(endpointLabel({ socketId: 'b', userId: 'b', mode: 'visual-out', report: { kind: 'visual', state: 'live', width: 1280, height: 720, devicePixelRatio: 1.5, streamWidth: 1920, streamHeight: 1080 } }))
      .toBe('live · Bildschirm 1920×1080 · Stream 1920×1080');
  });

  it('liest die Server-Nachricht defensiv (Meldungen erneut bereinigt)', () => {
    const list = parseSessionEndpoints({ endpoints: [
      { socketId: 's1', userId: 'user-1', mode: 'member', report: { layout: 'desktop', width: 1440, height: 900, devicePixelRatio: 1 } },
      { socketId: '', userId: 'kaputt', mode: 'member' },
      'unsinn',
      { socketId: 's2', userId: 'user-2', mode: 'visual-out', report: { width: 99999 } },
    ] });
    expect(list).toHaveLength(2);
    expect(list[0].report?.kind).toBe('ui');
    expect(list[1].report).toBeNull();
    expect(parseSessionEndpoints(null)).toEqual([]);
  });
});
