/**
 * IDEA-2026-10-07-A-F1 · Capture mit zwei simulierten Clients.
 *
 * A hält mixerMONK (Capture-Halter, Main), B hält drumsamplerMONK. Jeder Client
 * hat eigene Modul-Instanzen (eigener Spiegel-Store, eigenes Eingabe-Log),
 * eigene performance.now()-/AudioContext-Uhren und einen eigenen Offset zur
 * Serveruhr. Der „Server“ routet mit derselben Funktion wie server/realtime.ts
 * (`routeCaptureRelay`) und hält die Locks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RelayMod from '../src/core/capture/captureRelay';
import type * as BridgeMod from '../src/core/capture/captureRelayBridge';
import type * as MirrorMod from '../src/core/capture/captureMirror';
import type * as LogMod from '../src/core/capture/eventCaptureLog';
import type * as SessionMod from '../src/core/capture/captureSession';

/** Wahre Zeit in ms (für alle gleich). */
let T = 0;
/** Serverzeit = T + 5 000 000. */
const SERVER = 5_000_000;
const BPM = 120; // 16tel = 125 ms, Takt = 2 s

interface ClientSpec {
  id: string;
  /** performance.now() = T − perfOrigin. */
  perfOrigin: number;
  /** AudioContext-Start in wahrer Zeit (ms). */
  ctxOrigin: number;
  rttMs: number;
  outputLatencyMs: number;
  baseLatencyMs: number;
  jitterBufferMs: number;
}

interface Client {
  spec: ClientSpec;
  log: LogMod.EventCaptureLog;
  bridge: BridgeMod.CaptureRelayBridge;
  mirror: typeof MirrorMod;
  session: typeof SessionMod;
  flushPending: boolean;
  /** Vom Server zurückgesetzte (abgelehnte) Nachrichten. */
  resyncs: number;
}

const locks: Record<string, string> = {};
let mainOut = 'A';
let stored: RelayMod.CaptureSuggestionState | null = null;
/** Übergabe-Vorrat des Fake-Servers (dieselbe Funktion wie server/realtime.ts). */
let storedInputs: RelayMod.CaptureRelayInput[] | null = null;
let storedInputsLagMs = 0;
const clients = new Map<string, Client>();
let relay: typeof RelayMod;

function perfOf(c: ClientSpec) { return T - c.perfOrigin; }
function ctxOf(c: ClientSpec) { return (T - c.ctxOrigin) / 1000; }

/** Fake-Server: dieselbe Regel wie server/realtime.ts. */
function serverReceive(sender: string, data: unknown) {
  const route = relay.routeCaptureRelay(JSON.parse(JSON.stringify(data)), {
    senderUserId: sender,
    mainOutUserId: mainOut,
    lockOwner: (id) => locks[id] ?? null,
    senderHoldsAnyLock: Object.values(locks).includes(sender),
    stored,
    storedEvents: storedInputs,
    storedLagMs: storedInputsLagMs,
  });
  if (route.deliver === 'main-out') {
    // Übergabe-Vorrat fortschreiben (IDEA-2026-10-07-A-F2), genau wie der Server.
    if (route.payload.kind === 'inputs') {
      storedInputs = relay.mergeCapturedInputs(storedInputs, route.payload.events);
      storedInputsLagMs = route.payload.lagMs;
    }
    clients.get(route.target)?.bridge.receive(JSON.parse(JSON.stringify(route.payload)));
  } else if (route.deliver === 'room') {
    stored = route.stored;
    for (const [id, c] of clients) if (id !== sender) c.bridge.receive(JSON.parse(JSON.stringify(route.payload)));
  } else if (stored && (data as { kind?: string }).kind === 'view' && route.reason !== 'invalid') {
    const c = clients.get(sender)!;
    c.resyncs++;
    c.bridge.receive({ kind: 'suggestion', suggestion: stored });
  }
  return route;
}

async function makeClient(spec: ClientSpec): Promise<Client> {
  // Eigene Modul-Instanzen je Client (eigener Spiegel-Store).
  vi.resetModules();
  const bridgeMod: typeof BridgeMod = await import('../src/core/capture/captureRelayBridge');
  const mirror: typeof MirrorMod = await import('../src/core/capture/captureMirror');
  const logMod: typeof LogMod = await import('../src/core/capture/eventCaptureLog');
  const session: typeof SessionMod = await import('../src/core/capture/captureSession');
  const log = new logMod.EventCaptureLog();
  const client = { spec, log, mirror, session, flushPending: false, resyncs: 0 } as Client;
  client.bridge = new bridgeMod.CaptureRelayBridge(
    {
      log,
      ctxNowSec: () => ctxOf(spec),
      latency: () => ({ outputLatencyMs: spec.outputLatencyMs, baseLatencyMs: spec.baseLatencyMs }),
      jitterBufferMs: () => spec.jitterBufferMs,
    },
    {
      isCaptureHolder: () => mainOut === spec.id,
      inSession: () => mainOut.length > 0,
      send: (msg) => serverReceive(spec.id, msg),
      onMessage: () => () => {},
    },
    {
      perfNow: () => perfOf(spec),
      serverOffsetMs: () => SERVER + spec.perfOrigin, // Server − perf
      rttMs: () => spec.rttMs,
    },
    {
      setTimeout: () => { client.flushPending = true; return 1; },
      clearTimeout: () => { client.flushPending = false; },
    },
  );
  client.bridge.start();
  clients.set(spec.id, client);
  return client;
}

const A_SPEC: ClientSpec = { id: 'A', perfOrigin: 1_000, ctxOrigin: 2_000, rttMs: 30, outputLatencyMs: 10, baseLatencyMs: 5, jitterBufferMs: 50 };
const B_SPEC: ClientSpec = { id: 'B', perfOrigin: 777_000, ctxOrigin: 3_456, rttMs: 40, outputLatencyMs: 10, baseLatencyMs: 5, jitterBufferMs: 50 };
/** Dritter Client: übernimmt den Mixer-Lock mitten in der Session (Übergabe). */
const C_SPEC: ClientSpec = { id: 'C', perfOrigin: 12_345, ctxOrigin: 5_678, rttMs: 50, outputLatencyMs: 12, baseLatencyMs: 5, jitterBufferMs: 60 };
// B hört Main um 20 + 10 + 5 + 50 + 20 = 105 ms (Sender) + 15 (A rtt/2) − 15 (A Ausgabe) = 105 ms später.
const LISTEN_LAG = 105;

/** A's Transport-Start (wahre Zeit), Takt 0 beginnt hier. */
const TRANSPORT_T = 12_000;

/** B schlägt den Rasterpunkt (Takt, Step) so, wie er ihn hört (+ Hör-Versatz + Mensch). */
function bHits(c: Client, steps: Array<[bar: number, step: number, sound: string]>, humanMs = [8, -12, 3, -6]) {
  steps.forEach(([bar, step, sound], i) => {
    T = TRANSPORT_T + bar * 2000 + step * 125 + LISTEN_LAG + humanMs[i % humanMs.length];
    c.log.recordDrum(ctxOf(c.spec), 'drum-pad', 'channel2', 'tr-808', sound, 0.9);
  });
}

beforeEach(async () => {
  T = 0;
  mainOut = 'A';
  stored = null;
  storedInputs = null;
  storedInputsLagMs = 0;
  clients.clear();
  for (const k of Object.keys(locks)) delete locks[k];
  locks.mixer = 'A';
  locks.drumsampler = 'B';
  vi.resetModules();
  relay = await import('../src/core/capture/captureRelay');
});

function captureOnA(a: Client) {
  return a.session.buildCaptureResult({
    log: a.log, handle: null, supported: false,
    nowSec: ctxOf(a.spec), bpm: BPM, transportStartSec: (TRANSPORT_T - a.spec.ctxOrigin) / 1000,
  });
}

describe('Zwei Clients · Eingaben des drumsampler-Halters landen im Capture des Mixer-Halters', () => {
  it('Pads von B erscheinen bei A auf den gemeinten Steps (gemeinsame Zeitbasis + Hör-Versatz)', async () => {
    const a = await makeClient(A_SPEC);
    const b = await makeClient(B_SPEC);
    bHits(b, [[1, 0, 'kick'], [1, 4, 'snare'], [1, 8, 'kick'], [1, 12, 'snare']]);
    expect(b.flushPending).toBe(true);
    T += 30; // Bündelungs-Timer
    b.bridge.flush();
    expect(a.log.size).toBe(4);
    T += 200;
    const r = captureOnA(a);
    expect(r.drumHits.map((h) => [h.bar, h.step, h.soundId])).toEqual([
      [0, 0, 'kick'], [0, 4, 'snare'], [0, 8, 'kick'], [0, 12, 'snare'],
    ]);
    expect(r.suggestedBarIndex).toBe(0);
    // B loggt lokal weiter (eigener Ring), relayed aber nur einmal.
    expect(b.log.size).toBe(4);
  });

  it('ohne Versatz-Korrektur lägen die Schläge ein 16tel zu spät (Nachweis, dass sie wirkt)', async () => {
    const a = await makeClient(A_SPEC);
    const b = await makeClient({ ...B_SPEC, rttMs: 0, outputLatencyMs: 0, baseLatencyMs: 0, jitterBufferMs: 0 });
    // Dieselben Schläge, aber B meldet (fälschlich) fast keinen Hör-Versatz.
    bHits(b, [[1, 0, 'kick'], [1, 4, 'snare']], [0, 0]);
    b.bridge.flush();
    T += 200;
    const steps = captureOnA(a).drumHits.map((h) => h.step);
    expect(steps).toEqual([1, 5]);
  });

  it('Hält B den drumsamplerMONK NICHT, verwirft der Server die Pads (B2B)', async () => {
    locks.drumsampler = 'C';
    const a = await makeClient(A_SPEC);
    const b = await makeClient(B_SPEC);
    bHits(b, [[1, 0, 'kick']]);
    b.bridge.flush();
    expect(a.log.size).toBe(0);
  });

  it('Noten eines anderen Plugin-Halters (instru) werden ebenfalls relayed', async () => {
    locks.instru = 'B';
    locks.drumsampler = 'A';
    const a = await makeClient(A_SPEC);
    const b = await makeClient(B_SPEC);
    T = TRANSPORT_T + 2000 + 2 * 125 + LISTEN_LAG;
    b.log.record(ctxOf(b.spec), 'note-on', 'channel4', 64, 0.7);
    b.bridge.flush();
    T += 100;
    const r = captureOnA(a);
    expect(r.notes).toEqual([{ bar: 0, step: 2, track: 'channel4', note: 64, velocity: 0.7 }]);
  });

  it('Eingaben des Capture-Halters selbst gehen nicht ins Netz', async () => {
    const a = await makeClient(A_SPEC);
    const b = await makeClient(B_SPEC);
    T = 20_000;
    a.log.recordDrum(ctxOf(a.spec), 'drum-pad', 'channel2', 'tr-808', 'kick', 1);
    expect(a.flushPending).toBe(false);
    a.bridge.flush();
    expect(b.log.size).toBe(0);
  });

  it('Mixer-Übergabe: der neue Halter empfängt, der alte relayed jetzt selbst', async () => {
    const a = await makeClient(A_SPEC);
    const b = await makeClient(B_SPEC);
    mainOut = 'B';
    locks.mixer = 'B';
    locks.drumsampler = 'A';
    T = 30_000;
    a.log.recordDrum(ctxOf(a.spec), 'drum-pad', 'channel2', 'tr-808', 'kick', 1);
    a.bridge.flush();
    expect(b.log.size).toBe(1);
  });
});

describe('Zwei Clients · gespiegelter Vorschlag', () => {
  async function published() {
    const a = await makeClient(A_SPEC);
    const b = await makeClient(B_SPEC);
    const bars = captureOnA(a).bars;
    const emptyBars = bars.length ? bars : [Object.fromEntries(['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'].map((t) => [t, new Array(16).fill(false)]))];
    a.mirror.publishCaptureSuggestion({
      id: 'cap-42', bpm: BPM, bars: [emptyBars[0], emptyBars[0]] as never, drumHits: [{ bar: 1, step: 0, kitId: 'tr-808', soundId: 'kick', velocity: 1 }],
      notes: [], suggestedBarIndex: 1, barIndex: 1, transportAligned: true, capturedBy: 'A', status: 'open',
    });
    return { a, b };
  }

  it('B sieht denselben Vorschlag wie A', async () => {
    const { a, b } = await published();
    expect(b.mirror).not.toBe(a.mirror);
    expect(b.mirror.getCaptureSuggestion()).toEqual({ ...a.mirror.getCaptureSuggestion(), changedBy: 'A' });
  });

  it('Taktwahl des Sequencer-Halters wird bei A gespiegelt', async () => {
    const { a, b } = await published();
    b.mirror.updateCaptureView('cap-42', 0, 'open', 'B');
    expect(a.mirror.getCaptureSuggestion()?.barIndex).toBe(0);
  });

  it('Übernahme nur durch den Sequencer-Halter: A wird zurückgesetzt, B setzt durch', async () => {
    const { a, b } = await published();
    a.mirror.updateCaptureView('cap-42', 1, 'applied', 'A');
    // Server lehnt ab → A bekommt den Server-Stand zurück.
    expect(a.resyncs).toBe(1);
    expect(a.mirror.getCaptureSuggestion()?.status).toBe('open');
    expect(b.mirror.getCaptureSuggestion()?.status).toBe('open');

    b.mirror.updateCaptureView('cap-42', 1, 'applied', 'B');
    expect(a.mirror.getCaptureSuggestion()).toMatchObject({ status: 'applied', changedBy: 'B' });
    expect(stored?.status).toBe('applied');
  });

  it('ein Dritter ohne Lock kann weder blättern noch verwerfen', async () => {
    const { a } = await published();
    const c = await makeClient({ ...B_SPEC, id: 'C' });
    c.bridge.receive({ kind: 'suggestion', suggestion: stored });
    c.mirror.updateCaptureView('cap-42', 0, 'discarded', 'C');
    expect(c.resyncs).toBe(1);
    expect(c.mirror.getCaptureSuggestion()?.status).toBe('open');
    expect(a.mirror.getCaptureSuggestion()?.status).toBe('open');
  });
});

/**
 * IDEA-2026-10-07-A-F2 · Übergabe: Eingaben, die noch an den VORGÄNGER gingen,
 * werden dem NEUEN Capture-Halter nachgereicht (begrenztes Fenster, Serverzeit).
 */
describe('Übergabe · nachgereichte Eingaben für den neuen Capture-Halter', () => {
  it('Schläge, die den Vorgänger erreicht hätten, landen nach der Übergabe bei C auf denselben Steps', async () => {
    const a = await makeClient(A_SPEC);
    const b = await makeClient(B_SPEC);
    bHits(b, [[1, 0, 'kick'], [1, 4, 'snare']]);
    T += 30;
    b.bridge.flush();
    expect(a.log.size).toBe(2); // wie bisher: der Halter A bekommt sie

    // Übergabe mitten im Takt: C übernimmt den Mixer-Lock (Capture-Halter) und
    // holt den Vorrat ab, den der Server seit dem letzten Weiterleiten hält.
    locks.mixer = 'C';
    mainOut = 'C';
    const c = await makeClient(C_SPEC);
    c.bridge.requestHeldOverInputs('req-1');
    expect(c.log.size).toBe(2);

    T += 200;
    const r = c.session.buildCaptureResult({
      log: c.log, handle: null, supported: false,
      nowSec: ctxOf(c.spec), bpm: BPM, transportStartSec: (TRANSPORT_T - c.spec.ctxOrigin) / 1000,
    });
    expect(r.drumHits.map((h) => [h.bar, h.step, h.soundId])).toEqual([[0, 0, 'kick'], [0, 4, 'snare']]);
  });

  it('ohne Vorrat antwortet der Server nicht (kein Leer-Versand, kein Log-Eintrag)', async () => {
    locks.mixer = 'C';
    mainOut = 'C';
    const c = await makeClient(C_SPEC);
    c.bridge.requestHeldOverInputs('req-2');
    expect(c.log.size).toBe(0);
  });

  it('ein Gerät ohne Capture-Halter-Rolle schickt gar keine Anfrage', async () => {
    const b = await makeClient(B_SPEC); // hält drumsamplerMONK, nicht mixerMONK
    b.bridge.requestHeldOverInputs('req-3');
    expect(b.log.size).toBe(0);
  });
});
