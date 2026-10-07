/**
 * audioMONASTRY · Capture – Audio-Abgriff im Main-Thread (IDEA-2026-10-07-A)
 * ==========================================================================
 * Baut den `capture-tap-processor` als PARALLELEN Fan-out an den hörbaren
 * V2-Ausgang (`V2LiveSink.connectExtra`) und legt die SharedArrayBuffer für
 * den 60-s-Stereo-Ring an. Der Hauptpfad bekommt keine zusätzliche Latenz:
 * der Tap hängt neben der Destination, sein Ausgang liefert nur Nullen.
 *
 * Ohne `crossOriginIsolated` + `SharedArrayBuffer` bleibt Capture AUS (die UI
 * zeigt einen Hinweis). Es gibt bewusst keinen Rückfall, der Audio-Blöcke per
 * postMessage kopiert – das wäre Allokation im Audio-Thread.
 *
 * Nichts davon landet auf dem Gerät: der Ring lebt nur im Arbeitsspeicher, beim
 * Capture geht das WAV über `addSample` auf den Server.
 */
import {
  CAPTURE_CHANNELS,
  CAPTURE_HEADER_LENGTH,
  initCaptureHeader,
  readCaptureRing,
} from './captureRing';

export const CAPTURE_TAP_PROCESSOR = 'capture-tap-processor';
export const CAPTURE_TAP_WORKLET_URL = '/worklets/captureTapProcessor.js';
export const CAPTURE_SECONDS = 60;
/**
 * Sicherheitsreserve im Ring: beim Auslesen von 60 s darf der Audio-Thread
 * weiterschreiben, ohne den ältesten gelesenen Abschnitt zu überholen.
 */
export const CAPTURE_GUARD_SECONDS = 1;

/** Was der Abgriff vom V2-Sink braucht (V2LiveSink erfüllt das). */
export interface CaptureSink {
  readonly isConnected: boolean;
  connectExtra(dest: AudioNode): boolean;
  disconnectExtra(dest: AudioNode): void;
}

/** SharedArrayBuffer + Cross-Origin-Isolation vorhanden? */
export function isAudioCaptureSupported(): boolean {
  const g = globalThis as { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown };
  return g.crossOriginIsolated === true && typeof g.SharedArrayBuffer === 'function';
}

export interface AudioCaptureHandle {
  readonly context: AudioContext;
  readonly sampleRate: number;
  readonly seconds: number;
  /** Hängt der Tap gerade am V2-Ausgang? */
  readonly attached: boolean;
  /** Letzte `seconds` (Standard: volle Länge) chronologisch, [links, rechts]. */
  read(seconds?: number): [Float32Array, Float32Array];
  /** Nach Neuaufbau des V2-Sinks wieder anhängen (idempotent). */
  reattach(): boolean;
  /** Abgriff trennen und den Knoten beenden. */
  stop(): void;
}

const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * Startet den Audio-Abgriff. Liefert `null`, wenn SAB/AudioWorklet fehlen oder
 * der Knoten nicht erzeugt werden kann.
 */
export async function startAudioCapture(
  ctx: AudioContext,
  sink: CaptureSink,
  seconds = CAPTURE_SECONDS,
): Promise<AudioCaptureHandle | null> {
  if (!isAudioCaptureSupported()) return null;
  if (!ctx || typeof ctx.audioWorklet?.addModule !== 'function') return null;
  if (!loadedContexts.has(ctx)) {
    try {
      await ctx.audioWorklet.addModule(CAPTURE_TAP_WORKLET_URL);
    } catch (e) {
      console.warn('[capture] Worklet-Modul nicht geladen (wird als bereits geladen behandelt):', e);
    }
    loadedContexts.add(ctx);
  }

  const sampleRate = ctx.sampleRate;
  const frames = Math.ceil((seconds + CAPTURE_GUARD_SECONDS) * sampleRate);
  const data = new SharedArrayBuffer(frames * CAPTURE_CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const headerBuf = new SharedArrayBuffer(CAPTURE_HEADER_LENGTH * Int32Array.BYTES_PER_ELEMENT);
  const ringL = new Float32Array(data, 0, frames);
  const ringR = new Float32Array(data, frames * Float32Array.BYTES_PER_ELEMENT, frames);
  const header = new Int32Array(headerBuf);
  initCaptureHeader(header, frames, sampleRate);

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, CAPTURE_TAP_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    node.port.postMessage({ type: 'capture-sab', data, header: headerBuf, frames });
    // Chromium rendert nur Knoten mit Weg zur Destination; Ausgang = Nullen.
    node.connect(ctx.destination);
  } catch (e) {
    console.warn('[capture] Abgriff nicht verfügbar – Capture bleibt aus.', e);
    return null;
  }

  let attached = sink.isConnected && sink.connectExtra(node);
  let stopped = false;

  return {
    context: ctx,
    sampleRate,
    seconds,
    get attached() { return attached && !stopped; },
    read(sec = seconds) {
      return readCaptureRing(ringL, ringR, header, Math.min(sec, seconds), sampleRate);
    },
    reattach() {
      if (stopped) return false;
      // Doppelte connect()-Aufrufe derselben Knoten sind in WebAudio ein No-Op.
      attached = sink.isConnected && sink.connectExtra(node);
      return attached;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      sink.disconnectExtra(node);
      try { node.port.postMessage({ type: 'capture-stop' }); } catch { /* Port zu */ }
      try { node.disconnect(); } catch { /* bereits getrennt */ }
      attached = false;
    },
  };
}

/**
 * Engine-Fassade (Muster wie `MasterStreamTap`): hält höchstens einen Abgriff
 * pro AudioContext und hängt ihn nach jedem V2-Connect wieder an.
 */
export class AudioCaptureTap {
  private handle: AudioCaptureHandle | null = null;
  private pending: Promise<AudioCaptureHandle | null> | null = null;

  constructor(private readonly deps: {
    getContext(): AudioContext | null;
    getSink(): CaptureSink;
    seconds?: number;
  }) {}

  get supported(): boolean {
    return isAudioCaptureSupported();
  }

  get current(): AudioCaptureHandle | null {
    return this.handle;
  }

  /** Startet (einmalig je Kontext) bzw. hängt den Abgriff wieder an. */
  async attach(): Promise<boolean> {
    const ctx = this.deps.getContext();
    if (!ctx || !this.supported) return false;
    if (this.handle && this.handle.context === ctx) return this.handle.reattach();
    if (this.handle) this.stop();
    if (!this.pending) {
      this.pending = startAudioCapture(ctx, this.deps.getSink(), this.deps.seconds ?? CAPTURE_SECONDS);
    }
    const started = await this.pending;
    this.pending = null;
    if (!started) return false;
    if (started.context !== this.deps.getContext()) {
      started.stop();
      return false;
    }
    this.handle = started;
    return started.reattach();
  }

  stop(): void {
    this.handle?.stop();
    this.handle = null;
  }
}
