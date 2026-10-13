/**
 * audioMONASTRY · Capture-Relay für mehrere Nutzer (IDEA-2026-10-07-A-F1)
 * =======================================================================
 * Betreiber-Bestätigung 2026-10-12: Capture-Ziel ist `drumsampler`, und
 * Capture muss für mehrere Nutzer funktionieren. Das Eingabe-Log liegt aber
 * auf jedem Gerät für sich (`EventCaptureLog`), und den Capture-Klick macht
 * nur der mixerMONK-Halter (nur bei ihm spielt Main). Hält ein anderer Nutzer
 * den drumsamplerMONK (oder ein Instrument), fehlten seine Eingaben im Capture.
 *
 * Dieses Modul ist der reine (plattformfreie) Vertrag des Relays – Client und
 * Server benutzen dieselben Funktionen:
 *
 *  - `inputs`: Eingaben (Pads/Steps/Noten) eines Nicht-Mixer-Halters gehen
 *    gebündelt über den bestehenden Session-Socket an den Capture-Halter
 *    (= Main-Out-Owner). Der Server prüft den zentralen Lock: Drum-Eingaben nur
 *    vom drumsampler-Halter, Noten nur von jemandem, der ein Plugin hält.
 *  - `suggestion`: der Pattern-Vorschlag des Capture-Halters wird an ALLE
 *    gespiegelt (Server hält den letzten offenen Vorschlag für Nachzügler).
 *  - `view`: Taktwahl / Verwerfen / „übernommen“ – Taktwahl und Verwerfen vom
 *    Capture-Halter oder Sequencer-Halter, „übernommen“ NUR vom Sequencer-Halter
 *    (drumsampler-Lock, B2B-Regel).
 *
 * WARUM KEIN BESTEHENDER KANAL: `plugin-state` ist per Zod-Schema auf
 * `pluginId`/`state` beschnitten und schreibt über `applyEvent` in den
 * autoritativen Modul-State; `plugin-settings` überschreibt den gespeicherten
 * Stand eines Plugins; `session-nav` ist ein reiner UI-Hinweis ohne Prüfung.
 * Keiner trägt Ereignis-Listen mit Zeitstempel an genau EIN Ziel. Deshalb ein
 * zusätzlicher Event-Name (`capture-relay`) auf derselben Socket.IO-Session-
 * Verbindung – keine neue Verbindung, kein neuer Server.
 *
 * GEMEINSAME ZEITBASIS
 * --------------------
 * Jedes Gerät kennt seinen Offset zur Serveruhr (NTP-artig, `clock-ping` →
 * `masterClock.applyServerClock`, Offset = Serverzeit − performance.now()).
 * Der Sender stempelt jede Eingabe mit `performance.now()` beim Auftreten und
 * rechnet beim Versand auf Server-ms um. Der Empfänger rechnet Server-ms über
 * SEINEN Offset und seine AudioContext-Uhr zurück in AudioContext-Sekunden –
 * dieselbe Uhr wie Transport-Start und lokale Eingaben.
 *
 * LATENZ-VERSATZ BEIM QUANTISIEREN
 * --------------------------------
 * Ein entfernter Spieler hört Main nicht direkt, sondern als Stream vom
 * Mixer-Halter: Main wird bei A gerendert, läuft über Server/SFU zu B, durch
 * B's Jitter-Puffer und B's Ausgabe. B schlägt im Takt dessen, was er hört –
 * seine Eingabe liegt also in gemeinsamer Zeit um diese Hörverzögerung SPÄTER
 * als der gemeinte Rasterpunkt. Lokale Eingaben des Halters tragen dagegen nur
 * dessen eigene Ausgabelatenz (sie werden heute nicht korrigiert). Damit beide
 * vergleichbar quantisiert werden, zieht der Empfänger von entfernten
 * Eingaben die DIFFERENZ ab:
 *
 *   lag = [B: rtt/2 + Ausgabe + Basis + Jitter-Ziel + Opus-Frame]   (Sender)
 *       + [A: rtt/2]                                                (Empfänger)
 *       − [A: Ausgabe + Basis]                                      (lokale Konvention)
 *
 * begrenzt auf 0 … `CAPTURE_RELAY_MAX_LAG_MS`. Es ist eine Schätzung (RTT/2
 * statt echter Einweglatenz, P2P kann kürzer sein); die 16tel-Rundung toleriert
 * ± ein halbes 16tel (bei 120 BPM ± 62,5 ms).
 *
 * Nichts davon läuft im Audio-Thread: Eingaben werden im Main-Thread in einen
 * vorallokierten Ring geschrieben und in einem Timer gebündelt verschickt.
 */
import { ALL_TRACKS, type TrackType } from '../../types';
import type { CaptureEvent, CaptureEventKind } from './eventCaptureLog';
import type { CaptureBar, CaptureDrumHit, CaptureNote } from './quantizeCapture';

/** Socket-Event-Name auf der bestehenden Session-Verbindung. */
export const CAPTURE_RELAY_EVENT = 'capture-relay';
/** Ziel-Plugin der Übernahme (Betreiber-bestätigt 2026-10-12). */
export const CAPTURE_TARGET_PLUGIN_ID = 'drumsampler';
/** Höchstens so viele Eingaben je Relay-Nachricht. */
export const CAPTURE_RELAY_MAX_EVENTS = 128;
/** Obergrenze der Latenz-Korrektur. */
export const CAPTURE_RELAY_MAX_LAG_MS = 1000;
/** Opus-Frame des Main-Streams (Paketierung). */
export const CAPTURE_OPUS_FRAME_MS = 20;
/** Bündelungs-Intervall beim Sender (kein Echtzeit-Pfad: Zeitstempel reisen mit). */
export const CAPTURE_RELAY_FLUSH_MS = 25;
/** Grenzen eines gespiegelten Vorschlags. */
export const CAPTURE_SUGGESTION_MAX_BARS = 16;
export const CAPTURE_SUGGESTION_MAX_DRUM_HITS = 2048;
export const CAPTURE_SUGGESTION_MAX_NOTES = 2048;
/** Export types for external use */
export type { CaptureEvent };

const KINDS: ReadonlySet<string> = new Set<CaptureEventKind>(['trigger', 'note-on', 'drum-pad', 'drum-step']);
const TRACKS: ReadonlySet<string> = new Set<string>(ALL_TRACKS);
const MAX_ID = 64;
const MAX_TEXT = 64;

export interface CaptureRelayInput {
  /** Zeitpunkt der Eingabe in Serverzeit (Unix-ms). */
  serverMs: number;
  kind: CaptureEventKind;
  track: TrackType;
  note: number;
  velocity: number;
  kitId?: string;
  soundId?: string;
}

export interface CaptureInputsMessage {
  kind: 'inputs';
  /** Hörverzögerung des Senders (siehe Kopf, Sender-Anteil) in ms. */
  lagMs: number;
  events: CaptureRelayInput[];
  /** Vom Server autoritativ gesetzt. */
  senderUserId?: string;
}

export type CaptureSuggestionStatus = 'open' | 'applied' | 'discarded';

export interface CaptureSuggestionState {
  id: string;
  bpm: number;
  bars: CaptureBar[];
  drumHits: CaptureDrumHit[];
  notes: CaptureNote[];
  suggestedBarIndex: number;
  barIndex: number;
  /** Raster am Transport-Start ausgerichtet (sonst ab erster Eingabe). */
  transportAligned: boolean;
  /** Capture-Halter (mixerMONK), vom Server gesetzt. */
  capturedBy: string;
  status: CaptureSuggestionStatus;
  /** Wer zuletzt Status/Takt geändert hat (vom Server gesetzt). */
  changedBy?: string;
}

export interface CaptureSuggestionMessage {
  kind: 'suggestion';
  suggestion: CaptureSuggestionState;
}

export interface CaptureViewMessage {
  kind: 'view';
  id: string;
  barIndex: number;
  status: CaptureSuggestionStatus;
  changedBy?: string;
}

export interface CaptureLogRequestMessage {
  kind: 'log-request';
  requestId: string;
  fromUserId: string;
}

export interface CaptureLogResponseMessage {
  kind: 'log-response';
  requestId: string;
  events: CaptureEvent[];
}

export type CaptureRelayMessage = CaptureInputsMessage | CaptureSuggestionMessage | CaptureViewMessage | CaptureLogRequestMessage | CaptureLogResponseMessage;

// ---------------------------------------------------------------------------
// Zeitbasis
// ---------------------------------------------------------------------------

/** Lokale performance.now()-Zeit → Serverzeit (offset = Server − Client). */
export function perfToServerMs(perfMs: number, offsetMs: number): number {
  return perfMs + offsetMs;
}

/**
 * Serverzeit → AudioContext-Sekunden des Empfängers. `ctxNowSec`/`perfNowMs`
 * sind ein zusammengehöriges Paar (im selben Moment gelesen).
 */
export function serverMsToCtxSec(serverMs: number, ctxNowSec: number, perfNowMs: number, offsetMs: number): number {
  const localPerf = serverMs - offsetMs;
  return ctxNowSec - (perfNowMs - localPerf) / 1000;
}

function finiteOr0(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function clampLag(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms > CAPTURE_RELAY_MAX_LAG_MS ? CAPTURE_RELAY_MAX_LAG_MS : ms;
}

/** Sender-Anteil der Hörverzögerung (siehe Kopf). */
export function senderListenLagMs(p: { rttMs?: number; outputLatencyMs?: number; baseLatencyMs?: number; jitterBufferMs?: number }): number {
  return clampLag(finiteOr0(p.rttMs) / 2 + finiteOr0(p.outputLatencyMs) + finiteOr0(p.baseLatencyMs) + finiteOr0(p.jitterBufferMs) + CAPTURE_OPUS_FRAME_MS);
}

/** Gesamte Korrektur beim Empfänger (siehe Kopf). */
export function receiverCompensationMs(senderLagMs: number, p: { rttMs?: number; outputLatencyMs?: number; baseLatencyMs?: number }): number {
  return clampLag(clampLag(senderLagMs) + finiteOr0(p.rttMs) / 2 - finiteOr0(p.outputLatencyMs) - finiteOr0(p.baseLatencyMs));
}

/**
 * AudioContext-Zeit (Empfänger), unter der eine entfernte Eingabe ins Capture-
 * Log geht: Serverzeit minus Korrektur, nie später als „jetzt“.
 */
export function remoteInputCtxSec(serverMs: number, compensationMs: number, ctxNowSec: number, perfNowMs: number, offsetMs: number): number {
  const t = serverMsToCtxSec(serverMs - compensationMs, ctxNowSec, perfNowMs, offsetMs);
  return t > ctxNowSec ? ctxNowSec : t;
}

// ---------------------------------------------------------------------------
// Validierung (Client und Server)
// ---------------------------------------------------------------------------

function str(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function int(v: unknown, min: number, max: number): number | null {
  const n = num(v);
  if (n === null) return null;
  const i = Math.floor(n);
  return i < min || i > max ? null : i;
}

function parseInput(raw: unknown): CaptureRelayInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const serverMs = num(r.serverMs);
  const kind = str(r.kind);
  const track = str(r.track);
  if (serverMs === null || serverMs < 0 || !KINDS.has(kind) || !TRACKS.has(track)) return null;
  const note = int(r.note, -1, 127) ?? -1;
  const velocity = clamp01(num(r.velocity) ?? 0);
  const out: CaptureRelayInput = { serverMs, kind: kind as CaptureEventKind, track: track as TrackType, note, velocity };
  if (kind === 'drum-pad' || kind === 'drum-step') {
    const kitId = str(r.kitId);
    const soundId = str(r.soundId);
    if (!kitId || !soundId) return null;
    out.kitId = kitId;
    out.soundId = soundId;
  }
  return out;
}

function parseBar(raw: unknown): CaptureBar | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const bar = {} as CaptureBar;
  for (const t of ALL_TRACKS) {
    const steps = r[t];
    if (!Array.isArray(steps) || steps.length !== 16) return null;
    bar[t] = steps.map((s) => s === true);
  }
  return bar;
}

function parseDrumHit(raw: unknown, bars: number): CaptureDrumHit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const bar = int(r.bar, 0, bars - 1);
  const step = int(r.step, 0, 15);
  const kitId = str(r.kitId);
  const soundId = str(r.soundId);
  if (bar === null || step === null || !kitId || !soundId) return null;
  return { bar, step, kitId, soundId, velocity: clamp01(num(r.velocity) ?? 0) };
}

function parseNote(raw: unknown, bars: number): CaptureNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const bar = int(r.bar, 0, bars - 1);
  const step = int(r.step, 0, 15);
  const note = int(r.note, 0, 127);
  const track = str(r.track);
  if (bar === null || step === null || note === null || !TRACKS.has(track)) return null;
  return { bar, step, track: track as TrackType, note, velocity: clamp01(num(r.velocity) ?? 0) };
}

const STATUSES: ReadonlySet<string> = new Set<CaptureSuggestionStatus>(['open', 'applied', 'discarded']);

function parseSuggestion(raw: unknown): CaptureSuggestionState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, MAX_ID);
  const bpm = num(r.bpm);
  if (!id || bpm === null || bpm <= 0 || bpm > 400) return null;
  if (!Array.isArray(r.bars) || r.bars.length === 0 || r.bars.length > CAPTURE_SUGGESTION_MAX_BARS) return null;
  const bars: CaptureBar[] = [];
  for (const b of r.bars) {
    const bar = parseBar(b);
    if (!bar) return null;
    bars.push(bar);
  }
  const n = bars.length;
  const drumHits = (Array.isArray(r.drumHits) ? r.drumHits.slice(0, CAPTURE_SUGGESTION_MAX_DRUM_HITS) : [])
    .map((h) => parseDrumHit(h, n)).filter((h): h is CaptureDrumHit => h !== null);
  const notes = (Array.isArray(r.notes) ? r.notes.slice(0, CAPTURE_SUGGESTION_MAX_NOTES) : [])
    .map((x) => parseNote(x, n)).filter((x): x is CaptureNote => x !== null);
  const suggestedBarIndex = int(r.suggestedBarIndex, 0, n - 1) ?? n - 1;
  const barIndex = int(r.barIndex, 0, n - 1) ?? suggestedBarIndex;
  const status = str(r.status);
  return {
    id,
    bpm,
    bars,
    drumHits,
    notes,
    suggestedBarIndex,
    barIndex,
    transportAligned: r.transportAligned === true,
    capturedBy: str(r.capturedBy, MAX_ID),
    status: STATUSES.has(status) ? (status as CaptureSuggestionStatus) : 'open',
    ...(str(r.changedBy, MAX_ID) ? { changedBy: str(r.changedBy, MAX_ID) } : {}),
  };
}

/**
 * Prüft und bereinigt eine Relay-Nachricht. Unbekanntes/Kaputtes → `null`.
 * Ungültige einzelne Eingaben werden übersprungen.
 */
export function parseCaptureRelayMessage(raw: unknown): CaptureRelayMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case 'inputs': {
      if (!Array.isArray(r.events)) return null;
      const events = r.events.slice(0, CAPTURE_RELAY_MAX_EVENTS).map(parseInput).filter((e): e is CaptureRelayInput => e !== null);
      if (events.length === 0) return null;
      const msg: CaptureInputsMessage = { kind: 'inputs', lagMs: clampLag(num(r.lagMs) ?? 0), events };
      const sender = str(r.senderUserId, MAX_ID);
      if (sender) msg.senderUserId = sender;
      return msg;
    }
    case 'suggestion': {
      const suggestion = parseSuggestion(r.suggestion);
      return suggestion ? { kind: 'suggestion', suggestion } : null;
    }
    case 'view': {
      const id = str(r.id, MAX_ID);
      const barIndex = int(r.barIndex, 0, CAPTURE_SUGGESTION_MAX_BARS - 1);
      const status = str(r.status);
      if (!id || barIndex === null || !STATUSES.has(status)) return null;
      const msg: CaptureViewMessage = { kind: 'view', id, barIndex, status: status as CaptureSuggestionStatus };
      const by = str(r.changedBy, MAX_ID);
      if (by) msg.changedBy = by;
      return msg;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Server-Routing (rein, damit Server und Zwei-Client-Tests dieselbe Regel nutzen)
// ---------------------------------------------------------------------------

export interface CaptureRelayServerContext {
  /** Autoritativ aus der Session-Zuordnung des Sockets. */
  senderUserId: string;
  /** Capture-Halter = Main-Out-Owner (mixerMONK). */
  mainOutUserId: string;
  /** Zentraler Lock: Halter eines Plugins (oder null). */
  lockOwner: (pluginId: string) => string | null;
  /** Hält der Sender irgendein Plugin (Noten nur von Plugin-Haltern)? */
  senderHoldsAnyLock: boolean;
  /** Zuletzt gespiegelter Vorschlag (Server-Speicher) oder null. */
  stored: CaptureSuggestionState | null;
  /** Zuletzt gespeicherte Eingaben für Log-Anfragen */
  storedEvents: CaptureEvent[] | null;
}

export type CaptureRelayRoute =
  | { deliver: 'main-out'; target: string; payload: CaptureInputsMessage }
  | { deliver: 'room'; payload: CaptureSuggestionMessage | CaptureViewMessage; stored: CaptureSuggestionState }
  | { deliver: 'main-out'; target: string; payload: CaptureLogResponseMessage }
  | { deliver: 'none'; reason: string };

/** Darf `userId` den gespiegelten Vorschlag bedienen (Taktwahl/Verwerfen)? */
export function canSteerCaptureSuggestion(userId: string, s: CaptureSuggestionState, lockOwner: (pluginId: string) => string | null, mainOutUserId: string): boolean {
  if (!userId) return false;
  return userId === s.capturedBy || userId === mainOutUserId || userId === lockOwner(CAPTURE_TARGET_PLUGIN_ID);
}

export function routeCaptureRelay(raw: unknown, ctx: CaptureRelayServerContext): CaptureRelayRoute {
  const msg = parseCaptureRelayMessage(raw);
  if (!msg) return { deliver: 'none', reason: 'invalid' };
  const sender = ctx.senderUserId;
  if (!sender) return { deliver: 'none', reason: 'no-session' };

  if (msg.kind === 'inputs') {
    if (!ctx.mainOutUserId) return { deliver: 'none', reason: 'no-capture-holder' };
    // Der Capture-Halter loggt seine Eingaben selbst.
    if (sender === ctx.mainOutUserId) return { deliver: 'none', reason: 'own-device' };
    const drumHolder = ctx.lockOwner(CAPTURE_TARGET_PLUGIN_ID) === sender;
    const events = msg.events.filter((e) => (e.kind === 'drum-pad' || e.kind === 'drum-step') ? drumHolder : ctx.senderHoldsAnyLock);
    if (events.length === 0) return { deliver: 'none', reason: 'not-holder' };
    return { deliver: 'main-out', target: ctx.mainOutUserId, payload: { kind: 'inputs', lagMs: msg.lagMs, events, senderUserId: sender } };
  }

  if (msg.kind === 'suggestion') {
    if (sender !== ctx.mainOutUserId) return { deliver: 'none', reason: 'not-capture-holder' };
    const stored: CaptureSuggestionState = { ...msg.suggestion, capturedBy: sender, status: 'open', changedBy: sender };
    return { deliver: 'room', payload: { kind: 'suggestion', suggestion: stored }, stored };
  }

  // Log request/response handling
  if (msg.kind === 'log-request') {
    // Check if we have stored events to respond with
    if (ctx.storedEvents && ctx.storedEvents.length > 0) {
      return { 
        deliver: 'main-out', 
        target: msg.fromUserId, 
        payload: { 
          kind: 'log-response', 
          requestId: msg.requestId, 
          events: ctx.storedEvents 
        } 
      };
    } else {
      return { deliver: 'none', reason: 'no-stored-events' };
    }
  }

  if (msg.kind === 'log-response') {
    // This is a response we received, just apply it locally if needed
    // For now, we'll just return none as the processing happens elsewhere
    return { deliver: 'none', reason: 'log-response-received' };
  }

  // view
  const s = ctx.stored;
  if (!s || s.id !== msg.id) return { deliver: 'none', reason: 'unknown-suggestion' };
  if (s.status !== 'open') return { deliver: 'none', reason: 'closed' };
  if (msg.barIndex >= s.bars.length) return { deliver: 'none', reason: 'invalid' };
  if (msg.status === 'applied') {
    // Übernahme NUR durch den Sequencer-Halter (zentraler drumsampler-Lock).
    if (ctx.lockOwner(CAPTURE_TARGET_PLUGIN_ID) !== sender) return { deliver: 'none', reason: 'not-sequencer-holder' };
  } else if (!canSteerCaptureSuggestion(sender, s, ctx.lockOwner, ctx.mainOutUserId)) {
    return { deliver: 'none', reason: 'locked' };
  }
  const stored: CaptureSuggestionState = { ...s, barIndex: msg.barIndex, status: msg.status, changedBy: sender };
  return { deliver: 'room', payload: { kind: 'view', id: s.id, barIndex: msg.barIndex, status: msg.status, changedBy: sender }, stored };
}
