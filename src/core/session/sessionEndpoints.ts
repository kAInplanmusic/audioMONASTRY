/**
 * Session-Ausgänge (Betreiber 2026-10-06)
 * =======================================
 * „1–4 Nutzer, die die UI gestreamt bekommen, ein Main-Ausgang Sound und ein
 * Main-Ausgang Visuals."
 *
 *   UI 1–4       Session-Nutzer. Jeder bekommt die UI als gespiegelten Zustand
 *                und zeichnet sie in SEINEM Format (Handy quer/hochkant, Pad, PC –
 *                src/core/ui/deviceLayout.ts) und SEINER Auflösung.
 *   MAIN SOUND   genau ein Ton-Ausgang (/master-out, PA) – zählt nicht als Nutzer.
 *   MAIN VISUAL  genau ein Bild-Ausgang (/visual-out, Beamer) – zählt nicht als
 *                Nutzer; der Visual-Stream hat dessen Auflösung
 *                (src/core/visual/streamResolution.ts).
 *
 * Jedes Gerät meldet, was es ist (`endpoint-report`); der Server bereinigt die
 * Meldung nach dem Modus des Sockets – ein Nutzer kann sich nicht als Beamer
 * ausgeben – und verteilt die Liste (`session-endpoints`). Rein, ohne
 * Browser-/Socket-Zugriff: Server und Client nutzen dieselben Regeln.
 */

import type { LayoutKind } from '../ui/deviceLayout';
import { sanitizeOutputDisplay } from '../visual/streamResolution';

export const MAX_UI_ENDPOINTS = 4;

export type EndpointMode = 'member' | 'master-out' | 'visual-out';
export type OutputState = 'connecting' | 'waiting' | 'live' | 'error';

export interface UiReport {
  kind: 'ui';
  layout: LayoutKind;
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface SoundReport {
  kind: 'sound';
  state: OutputState;
  /** Abtastrate des ankommenden Main-Tons (Hz), 0 = unbekannt. */
  sampleRate: number;
  /** Kanäle des ankommenden Main-Tons, 0 = unbekannt. */
  channels: number;
}

export interface VisualReport {
  kind: 'visual';
  state: OutputState;
  /** Bildschirm des Beamers (CSS-Pixel) und Pixeldichte. */
  width: number;
  height: number;
  devicePixelRatio: number;
  /** Ankommende Stream-Auflösung (Video), 0 = noch keiner. */
  streamWidth: number;
  streamHeight: number;
}

export type EndpointReport = UiReport | SoundReport | VisualReport;

export interface SessionEndpoint {
  socketId: string;
  userId: string;
  mode: EndpointMode;
  report: EndpointReport | null;
}

const LAYOUTS: readonly LayoutKind[] = ['phone-landscape', 'phone-portrait', 'tablet-landscape', 'tablet-portrait', 'desktop'];
const STATES: readonly OutputState[] = ['connecting', 'waiting', 'live', 'error'];

const int = (v: unknown, min: number, max: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : 0;
};

export function normalizeEndpointMode(v: unknown): EndpointMode {
  return v === 'master-out' || v === 'visual-out' ? v : 'member';
}

/**
 * Bereinigt eine Meldung. Die Art ergibt sich aus dem MODUS des Sockets, nicht
 * aus der Meldung: Nutzer melden UI, /master-out meldet Ton, /visual-out Bild.
 */
export function sanitizeEndpointReport(mode: EndpointMode, raw: unknown): EndpointReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (mode === 'member') {
    const display = sanitizeOutputDisplay(r);
    const layout = LAYOUTS.find((l) => l === r.layout);
    if (!display || !layout) return null;
    return { kind: 'ui', layout, ...display };
  }
  const state = STATES.find((s) => s === r.state) ?? 'connecting';
  if (mode === 'master-out') {
    return { kind: 'sound', state, sampleRate: int(r.sampleRate, 8000, 384000), channels: int(r.channels, 1, 64) };
  }
  const display = sanitizeOutputDisplay(r);
  if (!display) return null;
  return {
    kind: 'visual',
    state,
    ...display,
    streamWidth: int(r.streamWidth, 16, 8192),
    streamHeight: int(r.streamHeight, 16, 8192),
  };
}

export interface EndpointSlots {
  /** Genau 4 Plätze in Beitrittsreihenfolge; `null` = frei. */
  users: (SessionEndpoint | null)[];
  sound: SessionEndpoint | null;
  visual: SessionEndpoint | null;
}

/** Ordnet die Liste den 6 festen Plätzen zu (je Ausgang der erste). */
export function endpointSlots(list: readonly SessionEndpoint[]): EndpointSlots {
  const members = list.filter((e) => e.mode === 'member').slice(0, MAX_UI_ENDPOINTS);
  const users: (SessionEndpoint | null)[] = Array.from({ length: MAX_UI_ENDPOINTS }, (_, i) => members[i] ?? null);
  return {
    users,
    sound: list.find((e) => e.mode === 'master-out') ?? null,
    visual: list.find((e) => e.mode === 'visual-out') ?? null,
  };
}

/** Liest die Server-Nachricht `session-endpoints` defensiv ein. */
export function parseSessionEndpoints(msg: unknown): SessionEndpoint[] {
  const list = (msg as { endpoints?: unknown } | null)?.endpoints;
  if (!Array.isArray(list)) return [];
  const out: SessionEndpoint[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const socketId = typeof e.socketId === 'string' ? e.socketId : '';
    if (!socketId) continue;
    const mode = normalizeEndpointMode(e.mode);
    out.push({
      socketId,
      userId: typeof e.userId === 'string' ? e.userId : '',
      mode,
      report: sanitizeEndpointReport(mode, e.report),
    });
  }
  return out;
}

const LAYOUT_LABEL: Record<LayoutKind, string> = {
  'phone-landscape': 'Handy quer',
  'phone-portrait': 'Handy hochkant',
  'tablet-landscape': 'Pad quer',
  'tablet-portrait': 'Pad hochkant',
  desktop: 'PC/Laptop',
};

const STATE_LABEL: Record<OutputState, string> = {
  connecting: 'verbindet',
  waiting: 'wartet auf Freigabe',
  live: 'live',
  error: 'Fehler',
};

/** Kurztext für eine Zeile im Ausgänge-Panel. */
export function endpointLabel(e: SessionEndpoint | null): string {
  if (!e) return 'frei';
  const r = e.report;
  if (!r) return 'verbunden';
  if (r.kind === 'ui') {
    return `${LAYOUT_LABEL[r.layout]} · ${Math.round(r.width * r.devicePixelRatio)}×${Math.round(r.height * r.devicePixelRatio)}`;
  }
  if (r.kind === 'sound') {
    const fmt = [r.sampleRate ? `${(r.sampleRate / 1000).toFixed(1)} kHz` : '', r.channels ? `${r.channels} ch` : ''].filter(Boolean).join(' · ');
    return fmt ? `${STATE_LABEL[r.state]} · ${fmt}` : STATE_LABEL[r.state];
  }
  const screen = `${Math.round(r.width * r.devicePixelRatio)}×${Math.round(r.height * r.devicePixelRatio)}`;
  const stream = r.streamWidth ? ` · Stream ${r.streamWidth}×${r.streamHeight}` : '';
  return `${STATE_LABEL[r.state]} · Bildschirm ${screen}${stream}`;
}
