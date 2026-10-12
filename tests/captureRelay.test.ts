/**
 * IDEA-2026-10-07-A-F1 · Capture-Relay: Zeitbasis, Latenz-Versatz, Validierung
 * und Server-Routing (Lock-/Halter-Regeln). Reine Funktionen.
 */
import { describe, expect, it } from 'vitest';
import { ALL_TRACKS } from '../src/types';
import {
  CAPTURE_OPUS_FRAME_MS,
  CAPTURE_RELAY_MAX_EVENTS,
  CAPTURE_RELAY_MAX_LAG_MS,
  parseCaptureRelayMessage,
  perfToServerMs,
  receiverCompensationMs,
  remoteInputCtxSec,
  routeCaptureRelay,
  senderListenLagMs,
  serverMsToCtxSec,
  type CaptureRelayServerContext,
  type CaptureSuggestionState,
} from '../src/core/capture/captureRelay';

function emptyBar() {
  return Object.fromEntries(ALL_TRACKS.map((t) => [t, new Array<boolean>(16).fill(false)])) as Record<(typeof ALL_TRACKS)[number], boolean[]>;
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
    ...partial,
  };
}

const drum = (serverMs: number) => ({ serverMs, kind: 'drum-pad', track: 'channel2', note: -1, velocity: 0.9, kitId: 'tr-808', soundId: 'kick' });

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
