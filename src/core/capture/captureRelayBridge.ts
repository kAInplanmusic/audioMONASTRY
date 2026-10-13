/**
 * audioMONASTRY · Capture-Relay-Brücke (IDEA-2026-10-07-A-F1, Mehrgeräte)
 * =======================================================================
 * Verdrahtet Eingabe-Log, Uhr und Session-Socket:
 *
 *  - SENDER (jedes Gerät, das NICHT Capture-Halter ist): jede Eingabe, die ins
 *    lokale `EventCaptureLog` geht (drumsamplerMONK-Pads/Steps, Instrument-
 *    Noten), wird zusätzlich mit `performance.now()` in einen VORALLOKIERTEN
 *    Ausgangsring kopiert (keine Allokation, kein Netz im Eingabe-Pfad) und
 *    alle `CAPTURE_RELAY_FLUSH_MS` gebündelt in Serverzeit verschickt.
 *  - EMPFÄNGER (Capture-Halter = Main-Out-Owner): rechnet die Serverzeit über
 *    seinen Uhr-Offset und seine AudioContext-Uhr zurück, zieht den
 *    Hör-Versatz ab (siehe `captureRelay.ts`) und schreibt die Eingaben in
 *    sein Log – der nächste Capture-Klick quantisiert sie mit.
 *  - SPIEGEL: `suggestion`/`view` gehen in den gespiegelten Vorschlag
 *    (`captureMirror.ts`), den alle sehen.
 *
 * Nichts davon berührt den Audio-Thread oder den Render-Pfad.
 * Abhängigkeiten sind injizierbar (Zwei-Client-Tests); die Verdrahtung mit
 * den Singletons macht `src/utils/captureRelayBridge.ts`.
 */
import type { CaptureEventKind, EventCaptureLog } from './eventCaptureLog';
import type { TrackType } from '../../types';
import {
  CAPTURE_RELAY_FLUSH_MS,
  CAPTURE_RELAY_MAX_EVENTS,
  parseCaptureRelayMessage,
  perfToServerMs,
  receiverCompensationMs,
  remoteInputCtxSec,
  senderListenLagMs,
  type CaptureRelayInput,
  type CaptureRelayMessage,
  type CaptureEvent,
} from './captureRelay';
import { applyRemoteCaptureMessage, setCaptureMirrorSender } from './captureMirror';

export interface CaptureRelayTransport {
  /** Ist dieses Gerät der Capture-Halter (Main-Out-Owner)? */
  isCaptureHolder(): boolean;
  /** Ist das Gerät in einer Session (sonst wird nichts verschickt)? */
  inSession(): boolean;
  send(msg: CaptureRelayMessage): void;
  onMessage(cb: (raw: unknown) => void): () => void;
}

export interface CaptureRelayClock {
  perfNow(): number;
  /** Serverzeit − performance.now() in ms. */
  serverOffsetMs(): number;
  rttMs(): number;
}

export interface CaptureRelayEngine {
  log: EventCaptureLog;
  /** AudioContext-Zeit oder null (kein Kontext). */
  ctxNowSec(): number | null;
  latency(): { outputLatencyMs: number; baseLatencyMs: number };
  jitterBufferMs(): number;
}

export interface CaptureRelayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Kapazität des Ausgangsrings (überzählige Eingaben bis zum Flush werden verworfen). */
export const CAPTURE_RELAY_OUTBOX = 512;

interface OutSlot {
  perfMs: number;
  kind: CaptureEventKind;
  track: TrackType;
  note: number;
  velocity: number;
  kitId: string;
  soundId: string;
}

export class CaptureRelayBridge {
  private readonly out: OutSlot[];
  private outCount = 0;
  private dropped = 0;
  private timer: unknown = null;
  private receiving = false;
  private offMessage: (() => void) | null = null;
  private readonly flushBound = () => this.flush();
  private readonly onRecord = (slot: Readonly<{ kind: CaptureEventKind; track: TrackType; note: number; velocity: number; kitId: string; soundId: string }>) => {
    if (this.receiving || !this.transport.inSession() || this.transport.isCaptureHolder()) return;
    if (this.outCount >= this.out.length) { this.dropped++; return; }
    const o = this.out[this.outCount++];
    o.perfMs = this.clock.perfNow();
    o.kind = slot.kind;
    o.track = slot.track;
    o.note = slot.note;
    o.velocity = slot.velocity;
    o.kitId = slot.kitId;
    o.soundId = slot.soundId;
    if (this.timer === null) this.timer = this.timers.setTimeout(this.flushBound, CAPTURE_RELAY_FLUSH_MS);
  };

  constructor(
    private readonly engine: CaptureRelayEngine,
    private readonly transport: CaptureRelayTransport,
    private readonly clock: CaptureRelayClock,
    private readonly timers: CaptureRelayTimers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  ) {
    this.out = new Array<OutSlot>(CAPTURE_RELAY_OUTBOX);
    for (let i = 0; i < CAPTURE_RELAY_OUTBOX; i++) {
      this.out[i] = { perfMs: 0, kind: 'trigger', track: 'channel1', note: -1, velocity: 0, kitId: '', soundId: '' };
    }
  }

  start(): void {
    this.engine.log.setRecordListener(this.onRecord);
    this.offMessage = this.transport.onMessage((raw) => this.receive(raw));
    setCaptureMirrorSender((msg) => this.transport.send(msg));
  }

  stop(): void {
    this.engine.log.setRecordListener(null);
    this.offMessage?.();
    this.offMessage = null;
    setCaptureMirrorSender(null);
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.outCount = 0;
  }

  /** Verworfene Eingaben (Ring voll) – Diagnose/Tests. */
  get droppedInputs(): number {
    return this.dropped;
  }

  /** Gebündelt verschicken (Timer; Allokation hier erlaubt). */
  flush(): void {
    this.timer = null;
    const n = this.outCount;
    this.outCount = 0;
    if (n === 0 || !this.transport.inSession() || this.transport.isCaptureHolder()) return;
    const offset = this.clock.serverOffsetMs();
    const lat = this.engine.latency();
    const lagMs = senderListenLagMs({
      rttMs: this.clock.rttMs(),
      outputLatencyMs: lat.outputLatencyMs,
      baseLatencyMs: lat.baseLatencyMs,
      jitterBufferMs: this.engine.jitterBufferMs(),
    });
    for (let start = 0; start < n; start += CAPTURE_RELAY_MAX_EVENTS) {
      const events: CaptureRelayInput[] = [];
      const end = Math.min(n, start + CAPTURE_RELAY_MAX_EVENTS);
      for (let i = start; i < end; i++) {
        const o = this.out[i];
        const e: CaptureRelayInput = { serverMs: perfToServerMs(o.perfMs, offset), kind: o.kind, track: o.track, note: o.note, velocity: o.velocity };
        if (o.kitId) { e.kitId = o.kitId; e.soundId = o.soundId; }
        events.push(e);
      }
      this.transport.send({ kind: 'inputs', lagMs, events });
    }
  }

  /** Nachricht vom Server (bereits geprüft und geroutet; hier erneut validiert). */
  receive(raw: unknown): void {
    const msg = parseCaptureRelayMessage(raw);
    if (!msg) return;
    if (msg.kind !== 'inputs') {
      applyRemoteCaptureMessage(msg);
      return;
    }
    if (!this.transport.isCaptureHolder()) return;
    const ctxNow = this.engine.ctxNowSec();
    if (ctxNow === null) return;
    const perfNow = this.clock.perfNow();
    const offset = this.clock.serverOffsetMs();
    const lat = this.engine.latency();
    const comp = receiverCompensationMs(msg.lagMs, { rttMs: this.clock.rttMs(), outputLatencyMs: lat.outputLatencyMs, baseLatencyMs: lat.baseLatencyMs });
    this.receiving = true;
    try {
      for (const e of msg.events) {
        const t = remoteInputCtxSec(e.serverMs, comp, ctxNow, perfNow, offset);
        if (e.kind === 'drum-pad' || e.kind === 'drum-step') {
          this.engine.log.recordDrum(t, e.kind, e.track, e.kitId ?? '', e.soundId ?? '', e.velocity);
        } else {
          this.engine.log.record(t, e.kind, e.track, e.note, e.velocity);
        }
      }
    } finally {
      this.receiving = false;
    }
  }
}
