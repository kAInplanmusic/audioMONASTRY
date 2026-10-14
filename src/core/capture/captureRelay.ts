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
/**
 * Übergabe-Fenster (IDEA-2026-10-07-A-F2): so viele der zuletzt weitergeleiteten
 * Eingaben hält der Server vor, damit ein NEUER Capture-Halter sie noch bekommt,
 * wenn die Übergabe mitten im Takt passiert. Begrenzt über Anzahl UND Alter
 * (Serverzeit) - ein unbegrenzter Puffer wäre in einer langen Session ein Leck.
 */
export const CAPTURE_LOG_WINDOW_EVENTS = 512;
export const CAPTURE_LOG_WINDOW_MS = 30_000;
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

/**
 * Antwort auf eine Übergabe-Anfrage (IDEA-2026-10-07-A-F2). Die Eingaben tragen
 * SERVERZEIT, nicht AudioContext-Zeit: nur der Empfänger kennt seine
 * AudioContext-Uhr. Er rechnet sie mit derselben Funktion um wie `inputs`
 * (`remoteInputCtxSec`) - der Server kann das nicht.
 */
export interface CaptureLogResponseMessage {
  kind: 'log-response';
  requestId: string;
  events: CaptureRelayInput[];
  /**
   * Hör-Versatz des Geräts, das die Eingaben gesendet hat (wie `inputs.lagMs`).
   * Ohne ihn landeten nachgereichte Eingaben um den Versatz zu spät und fielen
   * im Raster einen Step daneben.
   */
  lagMs: number;
}

export type CaptureRelayMessage = CaptureInputsMessage | CaptureSuggestionMessage | CaptureViewMessage | CaptureLogRequestMessage | CaptureLogResponseMessage | CapturePatternStateMessage | CapturePatternRequestMessage;

/**
 * Engine-Kanal-Pattern als Session-State (IDEA-2026-10-07-A-F2). Je Spur 16
 * oder 32 Steps (`normalizeSteps` auf der Engine-Seite normalisiert 16 auf die
 * aktuelle Schrittanzahl hoch). `revision` vergibt der SERVER (optimistische
 * Nebenläufigkeit: Sends bauen auf `baseRevision` auf, sonst Resync).
 */
export type SessionPatterns = Record<TrackType, boolean[]>;

export interface CapturePatternStateMessage {
  kind: 'pattern';
  /**
   * VOM SERVER vergebene Version (monoton steigend, startet bei 1). Client-
   * Sends tragen 0; der Server setzt die echte Nummer beim Speichern.
   */
  revision: number;
  /**
   * Server-Version, auf der der Absender aufbaut (0 = nie eine gesehen). Bei
   * einem fremden letzten Editor ohne Übereinstimmung lehnt der Server ab und
   * spiegelt den aktuellen Stand zurück (Resync), statt ihn zu überschreiben.
   */
  baseRevision: number;
  patterns: SessionPatterns;
  /** Vom Server autoritativ gesetzt. */
  senderUserId?: string;
}

/**
 * Frage nach dem aktuellen Engine-Pattern (IDEA-2026-10-07-A-F2): stellte ein
 * Gerät BEIDE Locks (mixerMONK + drumsamplerMONK), verschickt es beim Übernehmen
 * selbst - nur dann gibt es kein gesendetes Pattern. Holt ein anderes Gerät
 * NUR den Mixer-Lock, hat es den Stand nie gesehen. Der neue Capture-Halter
 * fragt deshalb bei Übernahme/Antritt den Server-Stand an (Antwort → 'pattern').
 */
export interface CapturePatternRequestMessage {
  kind: 'pattern-request';
}

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

/** Engine-Pattern (8 Spuren × 16/32 Steps, nur Booleans) prüfen und säubern. */
export function parseSessionPattern(raw: unknown): SessionPatterns | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out = {} as SessionPatterns;
  for (const t of ALL_TRACKS) {
    const steps = r[t];
    if (!Array.isArray(steps) || (steps.length !== 16 && steps.length !== 32)) return null;
    out[t] = steps.map((s) => s === true);
  }
  return out;
}

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
    // Übergabe (IDEA-2026-10-07-A-F2). Ohne diese beiden Fälle war der ganze
    // Pfad tot: der Parser gab null zurück, das Routing antwortete 'invalid' -
    // eine Anfrage konnte nie beantwortet werden (der Vorrat lief ins Leere).
    case 'log-request': {
      const requestId = str(r.requestId, MAX_ID);
      if (!requestId) return null;
      return { kind: 'log-request', requestId, fromUserId: str(r.fromUserId, MAX_ID) ?? '' };
    }
    case 'log-response': {
      const requestId = str(r.requestId, MAX_ID);
      if (!requestId || !Array.isArray(r.events)) return null;
      const events = r.events.slice(0, CAPTURE_LOG_WINDOW_EVENTS).map(parseInput).filter((e): e is CaptureRelayInput => e !== null);
      if (events.length === 0) return null;
      return { kind: 'log-response', requestId, events, lagMs: clampLag(num(r.lagMs) ?? 0) };
    }
    // Engine-Kanal-Pattern als Session-State (IDEA-2026-10-07-A-F2). Ohne
    // eigene Fälle hier war die Antwort auf pattern-request 'invalid' - derselbe
    // tote Pfad, den log-request/log-response vorher hatten.
    case 'pattern': {
      const revision = num(r.revision);
      const baseRevision = num(r.baseRevision);
      const patterns = parseSessionPattern(r.patterns);
      if (revision === null || revision < 0 || baseRevision === null || baseRevision < 0 || !patterns) return null;
      const msg: CapturePatternStateMessage = { kind: 'pattern', revision, baseRevision, patterns };
      const sender = str(r.senderUserId, MAX_ID);
      if (sender) msg.senderUserId = sender;
      return msg;
    }
    case 'pattern-request':
      return { kind: 'pattern-request' };
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
  /** Vorrat der zuletzt weitergeleiteten Eingaben für Übergaben oder null. */
  storedEvents: CaptureRelayInput[] | null;
  /** Hör-Versatz des Senders dieser Eingaben (für die Nachreichung). */
  storedLagMs?: number;
  /** Zuletzt gesendetes Engine-Kanal-Pattern (Server-Speicher) oder null. */
  storedPattern?: CapturePatternStateMessage | null;
}

export type CaptureRelayRoute =
  | { deliver: 'main-out'; target: string; payload: CaptureInputsMessage }
  | { deliver: 'room'; payload: CaptureSuggestionMessage | CaptureViewMessage; stored: CaptureSuggestionState }
  | { deliver: 'main-out'; target: string; payload: CaptureLogResponseMessage }
  | { deliver: 'room-pattern'; payload: CapturePatternStateMessage; storedPattern: CapturePatternStateMessage }
  | { deliver: 'main-out'; target: string; payload: CapturePatternStateMessage }
  | { deliver: 'none'; reason: string };

/**
 * Tiefenvergleich zweier Pattern-Maps (alle Spuren, alle Steps). Genutzt von
 * Tests/Anzeige; der Server vergleicht nicht den Inhalt, sondern die Version.
 */
export function sessionPatternsEqual(a: SessionPatterns, b: SessionPatterns): boolean {
  for (const t of ALL_TRACKS) {
    const sa = a[t];
    const sb = b[t];
    if (!sa || !sb || sa.length !== sb.length) return false;
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  }
  return true;
}

/**
 * Übergabe-Vorrat fortschreiben (IDEA-2026-10-07-A-F2): hängt die soeben
 * weitergeleiteten Eingaben an und begrenzt das Fenster über Anzahl UND Alter
 * (Serverzeit des jüngsten Eintrags). Ohne die Altersgrenze wächst der Vorrat in
 * einer langen Session unbegrenzt; ohne die Anzahlgrenze wäre die Antwort
 * beliebig groß. Beides ist eine harte Obergrenze, keine Heuristik.
 */
export function mergeCapturedInputs(
  existing: CaptureRelayInput[] | null,
  incoming: CaptureRelayInput[],
  windowEvents: number = CAPTURE_LOG_WINDOW_EVENTS,
  windowMs: number = CAPTURE_LOG_WINDOW_MS,
): CaptureRelayInput[] | null {
  if (incoming.length === 0) return existing;
  const all = existing === null ? incoming.slice() : existing.concat(incoming);
  const newest = all[all.length - 1].serverMs;
  const fresh = all.filter((e) => newest - e.serverMs <= windowMs);
  return fresh.slice(-windowEvents);
}

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

  // Übergabe (IDEA-2026-10-07-A-F2): der NEUE Capture-Halter holt die Eingaben,
  // die noch an den vorherigen Halter gehen sollten. Nur der Halter darf fragen,
  // und die Antwort geht an den ABSENDER (autoritativ aus der Session-Zuordnung) -
  // nicht an eine vom Client genannte Kennung.
  if (msg.kind === 'log-request') {
    if (sender !== ctx.mainOutUserId) return { deliver: 'none', reason: 'not-capture-holder' };
    if (!ctx.storedEvents || ctx.storedEvents.length === 0) return { deliver: 'none', reason: 'no-stored-events' };
    return {
      deliver: 'main-out',
      target: sender,
      payload: { kind: 'log-response', requestId: msg.requestId, events: ctx.storedEvents, lagMs: ctx.storedLagMs ?? 0 },
    };
  }

  if (msg.kind === 'log-response') {
    // Eine Antwort ist für den Anfragenden bestimmt; der Server leitet sie weiter
    // (siehe oben) und verarbeitet sie selbst nicht.
    return { deliver: 'none', reason: 'log-response-received' };
  }

  // Engine-Kanal-Pattern als Session-State (IDEA-2026-10-07-A-F2). Das Pattern
  // wohnt in der LOKALEN Engine (kein Session-State) - der Server spiegelt nur
  // den Stand, das Übernehmen bleibt am Sequencer-Halter (B2B unangetastet).
  if (msg.kind === 'pattern') {
    // B2B: nur der drumsampler-Halter darf das Engine-Pattern senden; ob
    // jemand mixerMONK (Capture) hält, ist dafür egal.
    const senderOwnsSequencer = ctx.lockOwner(CAPTURE_TARGET_PLUGIN_ID) === sender;
    if (!senderOwnsSequencer) return { deliver: 'none', reason: 'not-sequencer-holder' };
    // Optimistische Nebenläufigkeit: baute ein ANDERES Gerät auf einem
    // veralteten Stand auf (baseRevision ≠ Server-Stand), lehnt der Server ab
    // und spiegelt den aktuellen Stand an den Absender zurück (Resync), statt
    // ihn still zu überschreiben. Der letzte Schreiber darf ungeprüft weiter-
    // schreiben (er hält den Server-Stand per Definition).
    const prev = ctx.storedPattern ?? null;
    if (prev && prev.senderUserId !== sender && msg.baseRevision !== prev.revision) {
      return { deliver: 'main-out', target: sender, payload: prev };
    }
    const storedPattern: CapturePatternStateMessage = {
      kind: 'pattern',
      revision: (prev?.revision ?? 0) + 1,
      baseRevision: msg.baseRevision,
      patterns: msg.patterns,
      senderUserId: sender,
    };
    return { deliver: 'room-pattern', payload: storedPattern, storedPattern };
  }
  if (msg.kind === 'pattern-request') {
    // Der Capture-Halter (Hol-Pfad bei Übernahme/Antritt) UND der Sequencer-
    // Halter (Einstieg: bevor er seinen Stand sendet, muss er den Session-
    // Stand kennen, sonst überschreibt er ihn) dürfen anfragen.
    if (sender !== ctx.mainOutUserId && ctx.lockOwner(CAPTURE_TARGET_PLUGIN_ID) !== sender) {
      return { deliver: 'none', reason: 'not-capture-holder' };
    }
    if (!ctx.storedPattern) return { deliver: 'none', reason: 'no-stored-pattern' };
    return { deliver: 'main-out', target: sender, payload: ctx.storedPattern };
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
