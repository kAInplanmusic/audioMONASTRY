/**
 * IDEA-2026-10-07-A-F1 · Capture-Relay: Zeitbasis, Latenz-Versatz, Validierung
 * und Server-Routing (Lock-/Halter-Regeln). Reine Funktionen.
 */
import { describe, expect, it } from 'vitest';
import { ALL_TRACKS } from '../src/types';
import {
  CAPTURE_LOG_WINDOW_EVENTS,
  CAPTURE_LOG_WINDOW_MS,
  CAPTURE_OPUS_FRAME_MS,
  CAPTURE_RELAY_MAX_EVENTS,
  CAPTURE_RELAY_MAX_LAG_MS,
  mergeCapturedInputs,
  parseCaptureRelayMessage,
  perfToServerMs,
  receiverCompensationMs,
  remoteInputCtxSec,
  routeCaptureRelay,
  senderListenLagMs,
  serverMsToCtxSec,
  type CaptureRelayInput,
  type CaptureRelayServerContext,
  type CaptureSuggestionState,
  type SessionPatterns,
} from '../src/core/capture/captureRelay';

function emptyBar() {
  return Object.fromEntries(ALL_TRACKS.map((t) => [t, new Array<boolean>(16).fill(false)])) as Record<(typeof ALL_TRACKS)[number], boolean[]>;
}

function emptyPatterns(): SessionPatterns {
  return Object.fromEntries(ALL_TRACKS.map((t) => [t, new Array<boolean>(16).fill(false)])) as SessionPatterns;
}

function suggestion(partial: Partial<CaptureSuggestionState> = {}): CaptureSuggestionState {
  return {
    id: 'cap-1', bpm: 120, bars: [emptyBar(), emptyBar()], drumHits: [], notes: [],
    suggestedBarIndex: 1, barIndex: 1, transportAligned: true, capturedBy: 'A', status: 'open', ...partial,
  };
}

function ctx(partial: Partial<CaptureRelayServerContext> = {}, locks: Record<string, string> = { mixer: 'A', drumsampler: 'B' }): CaptureRelayServerContext {
  return {
    senderUserId: 'B',
    mainOutUserId: 'A',
    lockOwner: (id) => locks[id] ?? null,
    senderHoldsAnyLock: true,
    stored: null,
    storedEvents: null,
    ...partial,
  };
}

const drum = (serverMs: number): CaptureRelayInput => ({ serverMs, kind: 'drum-pad', track: 'channel2', note: -1, velocity: 0.9, kitId: 'tr-808', soundId: 'kick' });

describe('Zeitbasis', () => {
  it('perf → Server → ctx (Empfänger) ist bei gleichem Moment verlustfrei', () => {
    // Sender: perf 1000 ms, Offset +5000 → Server 6000.
    const server = perfToServerMs(1000, 5000);
    expect(server).toBe(6000);
    // Empfänger: Offset +2000 → lokal perf 4000; jetzt perf 4500 ↔ ctx 20 s.
    expect(serverMsToCtxSec(server, 20, 4500, 2000)).toBeCloseTo(19.5, 9);
  });

  it('Korrektur wird abgezogen, nie später als jetzt', () => {
    expect(remoteInputCtxSec(6000, 100, 20, 4500, 2000)).toBeCloseTo(19.4, 9);
    expect(remoteInputCtxSec(9000, 0, 20, 4500, 2000)).toBe(20);
  });

  it('Hör-Versatz: Sender-Anteil + Empfänger-RTT/2 − lokale Ausgabelatenz, begrenzt', () => {
    const lag = senderListenLagMs({ rttMs: 40, outputLatencyMs: 10, baseLatencyMs: 5, jitterBufferMs: 50 });
    expect(lag).toBe(20 + 10 + 5 + 50 + CAPTURE_OPUS_FRAME_MS);
    expect(receiverCompensationMs(lag, { rttMs: 30, outputLatencyMs: 10, baseLatencyMs: 5 })).toBe(105);
    expect(receiverCompensationMs(5, { rttMs: 0, outputLatencyMs: 50 })).toBe(0);
    expect(senderListenLagMs({ rttMs: 1e6 })).toBe(CAPTURE_RELAY_MAX_LAG_MS);
    expect(senderListenLagMs({ rttMs: Number.NaN, outputLatencyMs: -3 })).toBe(CAPTURE_OPUS_FRAME_MS);
  });
});

describe('parseCaptureRelayMessage', () => {
  it('bereinigt Eingaben, verwirft Kaputtes, deckelt die Menge', () => {
    const events = [
      drum(1), { ...drum(2), kitId: '' }, { serverMs: 3, kind: 'note-on', track: 'channel4', note: 60, velocity: 3 },
      { serverMs: 4, kind: 'hack', track: 'channel1' }, { serverMs: 5, kind: 'trigger', track: 'channel9' },
      ...Array.from({ length: 300 }, () => drum(9)),
    ];
    const msg = parseCaptureRelayMessage({ kind: 'inputs', lagMs: 5000, events, senderUserId: 'spoof' });
    expect(msg?.kind).toBe('inputs');
    if (msg?.kind !== 'inputs') return;
    expect(msg.lagMs).toBe(CAPTURE_RELAY_MAX_LAG_MS);
    expect(msg.events[0]).toEqual(drum(1));
    expect(msg.events[1]).toEqual({ serverMs: 3, kind: 'note-on', track: 'channel4', note: 60, velocity: 1 });
    expect(msg.events.length).toBe(CAPTURE_RELAY_MAX_EVENTS - 3);
  });

  it('Vorschlag: Raster muss 8 × 16 sein, Treffer außerhalb fliegen raus', () => {
    expect(parseCaptureRelayMessage({ kind: 'suggestion', suggestion: { ...suggestion(), bars: [{}] } })).toBeNull();
    const msg = parseCaptureRelayMessage({
      kind: 'suggestion',
      suggestion: { ...suggestion(), drumHits: [{ bar: 1, step: 3, kitId: 'k', soundId: 's', velocity: 1 }, { bar: 7, step: 0, kitId: 'k', soundId: 's' }] },
    });
    expect(msg?.kind === 'suggestion' && msg.suggestion.drumHits).toEqual([{ bar: 1, step: 3, kitId: 'k', soundId: 's', velocity: 1 }]);
    expect(parseCaptureRelayMessage({ kind: 'view', id: 'x', barIndex: 0, status: 'weird' })).toBeNull();
    expect(parseCaptureRelayMessage(null)).toBeNull();
  });
});

describe('routeCaptureRelay (Server-Regeln)', () => {
  it('Drum-Eingaben des drumsampler-Halters gehen an den Capture-Halter, Absender autoritativ', () => {
    const r = routeCaptureRelay({ kind: 'inputs', lagMs: 10, events: [drum(1)], senderUserId: 'A' }, ctx());
    expect(r).toEqual({ deliver: 'main-out', target: 'A', payload: { kind: 'inputs', lagMs: 10, events: [drum(1)], senderUserId: 'B' } });
  });

  it('Drum-Eingaben ohne drumsampler-Lock werden verworfen (B2B)', () => {
    const r = routeCaptureRelay({ kind: 'inputs', lagMs: 0, events: [drum(1)] }, ctx({ senderUserId: 'C' }));
    expect(r).toEqual({ deliver: 'none', reason: 'not-holder' });
  });

  it('Noten nur von Plugin-Haltern; Capture-Halter selbst wird nicht relayed', () => {
    const note = { serverMs: 1, kind: 'note-on', track: 'channel4', note: 60, velocity: 1 };
    expect(routeCaptureRelay({ kind: 'inputs', lagMs: 0, events: [note] }, ctx({ senderUserId: 'C', senderHoldsAnyLock: true })).deliver).toBe('main-out');
    expect(routeCaptureRelay({ kind: 'inputs', lagMs: 0, events: [note] }, ctx({ senderUserId: 'C', senderHoldsAnyLock: false }))).toEqual({ deliver: 'none', reason: 'not-holder' });
    expect(routeCaptureRelay({ kind: 'inputs', lagMs: 0, events: [note] }, ctx({ senderUserId: 'A' }))).toEqual({ deliver: 'none', reason: 'own-device' });
    expect(routeCaptureRelay({ kind: 'inputs', lagMs: 0, events: [note] }, ctx({ mainOutUserId: '' }))).toEqual({ deliver: 'none', reason: 'no-capture-holder' });
  });

  it('Vorschlag nur vom Capture-Halter; Server setzt capturedBy/status', () => {
    expect(routeCaptureRelay({ kind: 'suggestion', suggestion: suggestion() }, ctx({ senderUserId: 'B' }))).toEqual({ deliver: 'none', reason: 'not-capture-holder' });
    const r = routeCaptureRelay({ kind: 'suggestion', suggestion: suggestion({ capturedBy: 'X', status: 'applied' }) }, ctx({ senderUserId: 'A' }));
    expect(r.deliver).toBe('room');
    if (r.deliver !== 'room') return;
    expect(r.stored).toMatchObject({ capturedBy: 'A', status: 'open', changedBy: 'A' });
  });

  it('Taktwahl: Capture- oder Sequencer-Halter; Dritte gesperrt', () => {
    const stored = suggestion();
    expect(routeCaptureRelay({ kind: 'view', id: 'cap-1', barIndex: 0, status: 'open' }, ctx({ senderUserId: 'B', stored })).deliver).toBe('room');
    expect(routeCaptureRelay({ kind: 'view', id: 'cap-1', barIndex: 0, status: 'open' }, ctx({ senderUserId: 'A', stored })).deliver).toBe('room');
    expect(routeCaptureRelay({ kind: 'view', id: 'cap-1', barIndex: 0, status: 'discarded' }, ctx({ senderUserId: 'C', stored }))).toEqual({ deliver: 'none', reason: 'locked' });
    expect(routeCaptureRelay({ kind: 'view', id: 'other', barIndex: 0, status: 'open' }, ctx({ stored }))).toEqual({ deliver: 'none', reason: 'unknown-suggestion' });
    expect(routeCaptureRelay({ kind: 'view', id: 'cap-1', barIndex: 5, status: 'open' }, ctx({ stored }))).toEqual({ deliver: 'none', reason: 'invalid' });
  });

  it('„übernommen“ NUR vom Sequencer-Halter, danach ist der Vorschlag zu', () => {
    const stored = suggestion();
    expect(routeCaptureRelay({ kind: 'view', id: 'cap-1', barIndex: 1, status: 'applied' }, ctx({ senderUserId: 'A', stored }))).toEqual({ deliver: 'none', reason: 'not-sequencer-holder' });
    const r = routeCaptureRelay({ kind: 'view', id: 'cap-1', barIndex: 1, status: 'applied' }, ctx({ senderUserId: 'B', stored }));
    expect(r.deliver === 'room' && r.stored).toMatchObject({ status: 'applied', changedBy: 'B' });
    const closed = suggestion({ status: 'applied' });
    expect(routeCaptureRelay({ kind: 'view', id: 'cap-1', barIndex: 0, status: 'open' }, ctx({ senderUserId: 'B', stored: closed }))).toEqual({ deliver: 'none', reason: 'closed' });
  });
});

/**
 * IDEA-2026-10-07-A-F2 · Übergabe-Vorrat: was der Server vorhält, wenn ein neuer
 * Capture-Halter übernimmt (begrenzt über Anzahl UND Alter, Serverzeit).
 */
describe('Übergabe-Vorrat (mergeCapturedInputs + log-request)', () => {
  it('hängt Eingaben an und deckelt die Anzahl auf das Fenster', () => {
    const many = Array.from({ length: CAPTURE_LOG_WINDOW_EVENTS + 20 }, (_, i) => drum(i));
    const merged = mergeCapturedInputs(null, many);
    expect(merged?.length).toBe(CAPTURE_LOG_WINDOW_EVENTS);
    // Die JÜNGSTEN bleiben (die ältesten fallen vorn heraus).
    expect(merged?.[merged.length - 1].serverMs).toBe(CAPTURE_LOG_WINDOW_EVENTS + 19);
    expect(merged?.[0].serverMs).toBe(20);
  });

  it('wirft Eingaben weg, die älter als das Zeitfenster sind', () => {
    const old = drum(1_000);
    const fresh = drum(1_000 + CAPTURE_LOG_WINDOW_MS + 1);
    expect(mergeCapturedInputs([old], [fresh])).toEqual([fresh]);
    expect(mergeCapturedInputs([old], [drum(1_000 + CAPTURE_LOG_WINDOW_MS)])).toHaveLength(2);
  });

  it('leere Eingaben lassen den Vorrat unberührt und null bleibt null', () => {
    expect(mergeCapturedInputs(null, [])).toBeNull();
    const one = [drum(5)];
    expect(mergeCapturedInputs(one, [])).toBe(one);
  });

  it('log-request: nur der Capture-Halter bekommt den Vorrat, Ziel ist der Absender', () => {
    const stored = [drum(10), drum(11)];
    const msg = { kind: 'log-request', requestId: 'r1', fromUserId: 'FREMD' };
    // Ein Dritter fragt: keine Antwort.
    expect(routeCaptureRelay(msg, ctx({ senderUserId: 'B', storedEvents: stored }))).toEqual({ deliver: 'none', reason: 'not-capture-holder' });
    // Der Halter fragt: Antwort an den ABSENDER - nicht an die im Feld genannte Kennung,
    // und mit dem Hör-Versatz des Senders (sonst fällt der nachgereichte Schlag daneben).
    expect(routeCaptureRelay(msg, ctx({ senderUserId: 'A', storedEvents: stored, storedLagMs: 105 }))).toEqual({
      deliver: 'main-out',
      target: 'A',
      payload: { kind: 'log-response', requestId: 'r1', events: stored, lagMs: 105 },
    });
    // Ohne gespeicherten Versatz bleibt es bei 0 (kein erfundener Wert).
    const r = routeCaptureRelay(msg, ctx({ senderUserId: 'A', storedEvents: stored }));
    expect(r.deliver === 'main-out' && r.payload.kind === 'log-response' && r.payload.lagMs).toBe(0);
  });

  it('log-request ohne Vorrat: keine leere Antwort', () => {
    const msg = { kind: 'log-request', requestId: 'r2', fromUserId: 'A' };
    expect(routeCaptureRelay(msg, ctx({ senderUserId: 'A' }))).toEqual({ deliver: 'none', reason: 'no-stored-events' });
    expect(routeCaptureRelay(msg, ctx({ senderUserId: 'A', storedEvents: [] }))).toEqual({ deliver: 'none', reason: 'no-stored-events' });
  });
});

/**
 * IDEA-2026-10-07-A-F2 · Engine-Kanal-Pattern als Session-State. Das Kanal-
 * Pattern wohnt in der lokalen Engine des drumsampler-Halters; der Server
 * spiegelt den Stand (Server-Revision, optimistische Nebenläufigkeit) und
 * beantwortet pattern-request von Capture- und Sequencer-Haltern.
 */
describe('Engine-Pattern als Session-State (routeCaptureRelay)', () => {
  function barPattern(over: Partial<Record<string, boolean[]>> = {}): SessionPatterns {
    return Object.fromEntries(ALL_TRACKS.map((t) => [t, over[t] ?? new Array<boolean>(16).fill(false)])) as SessionPatterns;
  }
  function send(patterns: SessionPatterns, baseRevision = 0) {
    return { kind: 'pattern', revision: 0, baseRevision, patterns };
  }

  it('nur der drumsampler-Halter sendet; Server vergibt Revision 1 und spiegelt an alle', () => {
    const r = routeCaptureRelay(send(barPattern()), ctx({ senderUserId: 'B' }));
    expect(r).toMatchObject({
      deliver: 'room-pattern',
      storedPattern: { kind: 'pattern', revision: 1, baseRevision: 0, senderUserId: 'B' },
    });
    if (r.deliver === 'room-pattern') {
      expect(r.payload.revision).toBe(1);
      expect(r.payload.senderUserId).toBe('B');
    }
    // A hält nur mixerMONK: kein Senderecht (B2B, Server prüft mit).
    expect(routeCaptureRelay(send(barPattern()), ctx({ senderUserId: 'A' }))).toEqual({ deliver: 'none', reason: 'not-sequencer-holder' });
  });

  it('letzter Schreiber darf ohne baseRevision-Prüfung weiterschreiben; fremder veralteter Stand wird mit Resync abgelehnt', () => {
    const first = routeCaptureRelay(send(barPattern()), ctx({ senderUserId: 'B' }));
    const stored = first.deliver === 'room-pattern' ? first.storedPattern : null;
    expect(stored?.revision).toBe(1);

    // Derselbe Absender (Server-Revision 1): baseRevision wird nicht geprüft.
    const again = routeCaptureRelay(send(barPattern(), 0), ctx({ senderUserId: 'B', storedPattern: stored }));
    expect(again.deliver === 'room-pattern' && again.storedPattern.revision).toBe(2);

    // NEUER Halter C auf veraltetem Stand (baseRevision 0, Server bei 1):
    // kein Überschreiben - Resync an C mit dem aktuellen Stand (main-out).
    const stale = routeCaptureRelay(send(barPattern(), 0), ctx({ senderUserId: 'C', storedPattern: stored }, { mixer: 'A', drumsampler: 'C' }));
    expect(stale).toEqual({ deliver: 'main-out', target: 'C', payload: stored });

    // Auf der richtigen Basis (1) kommt C durch.
    const fresh = routeCaptureRelay(send(barPattern(), 1), ctx({ senderUserId: 'C', storedPattern: stored }, { mixer: 'A', drumsampler: 'C' }));
    expect(fresh.deliver === 'room-pattern' && fresh.storedPattern.revision).toBe(2);
    expect(fresh.deliver === 'room-pattern' && fresh.storedPattern.senderUserId).toBe('C');
  });

  it('pattern-request: Capture- oder Sequencer-Halter bekommt den Stand, Dritte nichts', () => {
    const stored = { kind: 'pattern' as const, revision: 3, baseRevision: 2, patterns: barPattern() as SessionPatterns, senderUserId: 'B' };
    const req = { kind: 'pattern-request' };
    // Neuer Capture-Halter A holt den Stand (Hol-Pfad bei Übernahme/Antritt).
    expect(routeCaptureRelay(req, ctx({ senderUserId: 'A', storedPattern: stored }))).toEqual({
      deliver: 'main-out', target: 'A', payload: stored,
    });
    // Neuer Sequencer-Halter B ebenfalls (bevor er seinen Stand sendet).
    expect(routeCaptureRelay(req, ctx({ senderUserId: 'B', storedPattern: stored }))).toEqual({
      deliver: 'main-out', target: 'B', payload: stored,
    });
    // Ein Dritter ohne einen der Locks darf nicht anfragen.
    expect(routeCaptureRelay(req, ctx({ senderUserId: 'C', storedPattern: stored }))).toEqual({ deliver: 'none', reason: 'not-capture-holder' });
    // Ohne gespeicherten Stand: keine leere Antwort.
    expect(routeCaptureRelay(req, ctx({ senderUserId: 'A' }))).toEqual({ deliver: 'none', reason: 'no-stored-pattern' });
  });
});

describe('Engine-Pattern-Nachricht (parseSessionPattern über parseCaptureRelayMessage)', () => {
  it('kaputte Stände fliegen raus (Spur fehlt, falsche Stepzahl), saubere mit Server-Feldern durch', () => {
    const good = { kind: 'pattern', revision: 0, baseRevision: 0, patterns: emptyPatterns(), senderUserId: 'B' };
    const parsed = parseCaptureRelayMessage(good);
    expect(parsed).toEqual(good);
    // Spur fehlt / Stepzahl falsch / kein Objekt:
    const broken: Record<string, unknown> = { ...good, patterns: { ...emptyPatterns() } };
    delete (broken.patterns as Record<string, unknown>).channel8;
    expect(parseCaptureRelayMessage(broken)).toBeNull();
    const short = { ...good, patterns: { ...emptyPatterns(), channel1: new Array<boolean>(15).fill(false) } };
    expect(parseCaptureRelayMessage(short)).toBeNull();
    expect(parseCaptureRelayMessage({ ...good, patterns: 'kein objekt' })).toBeNull();
    expect(parseCaptureRelayMessage({ ...good, revision: -1 })).toBeNull();
    expect(parseCaptureRelayMessage({ kind: 'pattern-request' })).toEqual({ kind: 'pattern-request' });
  });
});
