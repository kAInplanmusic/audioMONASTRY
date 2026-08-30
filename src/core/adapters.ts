/**
 * audioMONASTRY · Phase 1 – Referenz-Adapter (1.1.2 … 1.1.6)
 * ==========================================================
 * Konkrete, funktionale Referenzimplementierungen hinter den Abstraktions-
 * Interfaces. Diese Adapter wrappen die bereits vorhandene Engine-Logik
 * (WebRTCManager, spatialMath) und bieten saubere Fallback-Ketten.
 */
import { webRTCManager } from '../utils/WebRTCManager';
import {
  calculateChannelPan, calculateHRTF, getSetup,
} from '../utils/spatialMath';
import { workerPool } from './workers/WorkerPool';
import {
  AIBackendKind, AIResult, AudioSignal, ComputeMode, ControlMessage,
  IAudioBackend, IAIRuntime, IComputeBackend, IComputeJob, IHardwareAdapter,
  ISpatialRenderer, SpatialSource, ITransport, TransportMode,
} from './interfaces';

// ---------------------------------------------------------------------------
// 1.1.6 · WebRTCTransport  (Referenz für ITransport)
// ---------------------------------------------------------------------------
export class WebRTCTransport implements ITransport {
  readonly id = 'webrtc';
  readonly mode: TransportMode = 'p2p';
  private _onMessage: (payload: unknown, fromPeerId: string) => void = () => {};
  private _onPeerJoin: (peerId: string) => void = () => {};
  private _onPeerLeave: (peerId: string) => void = () => {};
  private _unsubscribeData: (() => void) | null = null;

  onMessage: ITransport['onMessage'] = (cb) => { this._onMessage = cb; };
  onPeerJoin: ITransport['onPeerJoin'] = (cb) => { this._onPeerJoin = cb; };
  onPeerLeave: ITransport['onPeerLeave'] = (cb) => { this._onPeerLeave = cb; };

  async connect(_sessionId: string, _userId: string): Promise<void> {
    // Der WebRTCManager ist bereits per WebSocket-Signaling verdrahtet.
    // Multi-Listener (F2-Fix): eigener Listener statt Single-Slot-Überschreiben.
    this._unsubscribeData = webRTCManager.addDataChannelListener((payload) => this._onMessage(payload, 'peer'));
  }
  disconnect(): void {
    this._unsubscribeData?.();
    this._unsubscribeData = null;
  }

  broadcast(payload: unknown): void { webRTCManager.sendData(payload); }
  sendTo(_peerId: string, payload: unknown): void { webRTCManager.sendData(payload); }

  syncClock(): void {
    // Das bestehende Clock-Sync-/PLL-Protokoll läuft über WebRTCManager peering.
  }
}

export const webRTCTransport = new WebRTCTransport();

// ---------------------------------------------------------------------------
// 1.1.2 · AIRuntime  (Referenz für IAIRuntime – mit Fallback-Kette)
// ---------------------------------------------------------------------------
/**
 * Abstrahiert lokale/remote/deterministische Inferenz. Die echten KI-Module
 * (stemMONK, voiceMONK, biblioMONK) hängen hier an; der Referenz-Fallback ist
 * deterministisch, damit die App ohne Backend-Fachwissen verwendbar bleibt.
 */
export class AIRuntime implements IAIRuntime {
  readonly id = 'ai-default';

  canRun(_kind: AIBackendKind, _task: string): boolean { return true; }

  async infer(task: string, input: unknown): Promise<AIResult> {
    // Placeholder: löst kein echtes Modell aus, sondern meldet "deterministic".
    // Echte Tasks (stems/voice/embedding) sollen hier an lokale/remote Adapter
    // delegiert werden. Struktur ist vorbereitet.
    const started = performance.now();
    await Promise.resolve();
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return { kind: 'deterministic', latencyMs: performance.now() - started, data: { task, echo: text } };
  }
}

export const aiRuntime = new AIRuntime();

// ---------------------------------------------------------------------------
// 1.1.3 · ComputeBackend  (Referenz für IComputeBackend)
// ---------------------------------------------------------------------------
/**
 * Trennt Live- (kurz, vorhersagbar, auf Main-Thread erlaubt) von Offline-
 * (lang, in Web-Worker ausgelagert) Jobs. So blockiert eine schwere Offline-
 * Analyse den Audio-Thread/Echtzeitpfad nie.
 */
export class ComputeBackend implements IComputeBackend {
  readonly id = 'compute-default';

  async submit<T, R>(job: IComputeJob<T>): Promise<R> {
    if (job.mode === 'live') {
      // Live: synchron/leicht – direkt im Main-Thread ausführen.
      return await this.runLocal(job);
    }
    // Offline: in den echten Web-Worker-Pool auslagern (blockiert nie den
    // Main-/Audio-Thread); schlägt das fehl, Fallback auf lokale Ausführung.
    try {
      const r = await workerPool.submit<unknown, unknown>(job.task, job.input);
      return r as R;
    } catch {
      return await this.runLocal(job);
    }
  }

  private async runLocal<T, R>(job: IComputeJob<T>): Promise<R> {
    const fn = ComputeBackend.registry[job.task];
    if (!fn) throw new Error(`Compute-Task nicht registriert: ${job.task}`);
    return fn(job.input) as Promise<R>;
  }

  private static registry: Record<string, (input: unknown) => unknown> = {};

  /** Registriert eine (typischerweise lokal importierte) rechenintensive Funktion. */
  static registerTask(task: string, fn: (input: unknown) => unknown | Promise<unknown>): void {
    ComputeBackend.registry[task] = fn as (input: unknown) => unknown;
  }
}

export const computeBackend = new ComputeBackend();

// ---------------------------------------------------------------------------
// 1.1.4 · SpatialRenderer  (Referenz für ISpatialRenderer)
// ---------------------------------------------------------------------------
/**
 * Wrappt die bestehende spatialMath-Mehrkanal-/HRTF-Berechnung hinter ein
 * objektbasiertes, renderer-unabhängiges Interface.
 */
export class SpatialRenderer implements ISpatialRenderer {
  readonly id = 'spatial-default';
  private setupId = '10.0';
  private sources = new Map<string, SpatialSource>();

  setSource(src: SpatialSource): void { this.sources.set(src.id, src); }

  setSetup(setupId: string): void { this.setupId = setupId; }

  getSetup(): string { return this.setupId; }

  render(signal: AudioSignal, source: SpatialSource): AudioSignal {
    const setup = getSetup(this.setupId);
    const pan = calculateChannelPan(source.x, source.y, this.setupId);
    // HRTF für Stereo-/Binaural-Feinfühlung (ILD).
    const hrtf = calculateHRTF(source.x, source.y, signal.sampleRate);

    // Mono-Downmix des Eingangs als Basis.
    const mono = new Float32Array(signal.channelData[0]?.length ?? 0);
    for (const ch of signal.channelData) {
      for (let i = 0; i < Math.min(mono.length, ch.length); i++) mono[i] += ch[i] ?? 0;
    }
    for (let i = 0; i < mono.length; i++) mono[i] /= Math.max(1, signal.channelData.length);

    const out: Float32Array[] = [];
    const nCh = Math.max(2, setup.numChannels);
    for (let c = 0; c < nCh; c++) {
      const g = pan.channels[c] ?? 0;
      const buf = new Float32Array(mono.length);
      for (let i = 0; i < mono.length; i++) buf[i] = mono[i] * g;
      out.push(buf);
    }
    return { channelData: out, sampleRate: signal.sampleRate };
  }
}

export const spatialRenderer = new SpatialRenderer();

// ---------------------------------------------------------------------------
// 1.1.5 · WebMIDIAdapter  (Referenz für IHardwareAdapter)
// ---------------------------------------------------------------------------
export class WebMIDIAdapter implements IHardwareAdapter {
  readonly id = 'webmidi';
  private _onControl: (msg: ControlMessage) => void = () => {};
  private access: MIDIAccess | null = null;

  onControl(cb: (msg: ControlMessage) => void): void { this._onControl = cb; }

  async connect(): Promise<void> {
    if (!navigator?.requestMIDIAccess) throw new Error('Web MIDI nicht verfügbar');
    this.access = await navigator.requestMIDIAccess();
    this.access.inputs.forEach((port) => {
      port.onmidimessage = (e) => {
        const [status, d1, d2] = e.data;
        const chan = (status & 0x0f) + 1;
        const kind = (status >> 4) as 0x8 | 0x9 | 0xB | 0xC | 0xE;
        let k: ControlMessage['kind'];
        switch (kind) {
          case 0x8: k = 'noteOff'; break;
          case 0x9: k = d2 > 0 ? 'noteOn' : 'noteOff'; break;
          case 0xB: k = 'cc'; break;
          case 0xC: k = 'program'; break;
          case 0xE: k = 'pitch'; break;
          default: k = 'cc';
        }
        // Bei Program-Change trägt d1 die Programmnummer (d2 ist ungenutzt).
        this._onControl({ kind: k, idNum: d1, value: kind === 0xC ? d1 : d2, channel: chan });
      };
    });
  }

  disconnect(): void {
    this.access?.inputs.forEach((p) => { p.onmidimessage = null; });
  }

  send(_msg: ControlMessage): void { /* Rück-Kanal (LEDs) – best-effort, hier no-op. */ }
}

export const webMIDIAdapter = new WebMIDIAdapter();

// ---------------------------------------------------------------------------
// 1.1.5 · HIDAdapter – WebHID-Controller (Pads/Fader/Rotaries)
// ---------------------------------------------------------------------------
export class HIDAdapter implements IHardwareAdapter {
  readonly id = 'hid';

  private _onControl: (msg: ControlMessage) => void = () => {};
  private devices: unknown[] = [];

  onControl(cb: (msg: ControlMessage) => void): void { this._onControl = cb; }

  async connect(): Promise<void> {
    const nav = navigator as unknown as {
      hid?: { requestDevice: (opts: { filters: unknown[] }) => Promise<unknown[]> };
    };
    if (!nav?.hid?.requestDevice) throw new Error('WebHID nicht verfügbar');
    const devices = await nav.hid.requestDevice({ filters: [] });
    this.devices = devices;
    for (const raw of devices) {
      const d = raw as {
        opened?: boolean;
        open?: () => Promise<void>;
        oninputreport?: ((e: { data?: Uint8Array }) => void) | null;
      };
      if (!d.opened && d.open) await d.open().catch(() => { /* Gerät blockiert */ });
      d.oninputreport = (e) => {
        const data = e.data;
        if (!data || data.length < 2) return;
        // Pragmatisches Mapping: erster Byte = Control-ID, zweiter = Wert (0..255).
        this._onControl({
          kind: 'cc',
          idNum: data[0] ?? 0,
          value: Math.min(127, Math.round((data[1] ?? 0) / 2)),
          channel: 1,
        });
      };
    }
  }

  disconnect(): void {
    for (const raw of this.devices) {
      const d = raw as { close?: () => void };
      try { d.close?.(); } catch { /* ignore */ }
    }
    this.devices = [];
  }

  send(_msg: ControlMessage): void { /* HID-Rückkanal (LEDs) – best effort, no-op. */ }
}

export const hidAdapter = new HIDAdapter();

// ---------------------------------------------------------------------------
// 1.1.5 · OSCAdapter – OSC-/Netzwerk-Controller (Produktions-Scaffold)
// ---------------------------------------------------------------------------
export class OSCAdapter implements IHardwareAdapter {
  readonly id = 'osc';

  private ws: WebSocket | null = null;
  private _onControl: (msg: ControlMessage) => void = () => {};

  constructor(private url = 'ws://127.0.0.1:9000') {}

  onControl(cb: (msg: ControlMessage) => void): void { this._onControl = cb; }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error(`OSC-Endpoint nicht erreichbar: ${this.url}`));
    });
    this.ws.onmessage = (e) => this.handleIncoming(e.data);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  send(msg: ControlMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // JSON-Fallback für Tools ohne natives OSC; Produktivpfad kann hier
      // echtes OSC-Encoding (Big-Endian) ergänzen.
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Versteht `/control/<kind>/<idNum>/<value>[/<channel>]` (Text-OSC-Fallback). */
  private handleIncoming(data: unknown): void {
    try {
      const text = typeof data === 'string'
        ? data
        : new TextDecoder().decode(data as ArrayBuffer);
      const m = /^\/control\/([a-zA-Z]+)\/(\d+)\/([-0-9.]+)(?:\/(\d+))?/.exec(text.trim());
      if (!m) return;
      const rawKind = m[1].toLowerCase();
      const kind: ControlMessage['kind'] =
        rawKind === 'noteon' ? 'noteOn'
        : rawKind === 'noteoff' ? 'noteOff'
        : rawKind === 'cc' ? 'cc'
        : 'osc';
      this._onControl({
        kind,
        idNum: Math.max(0, Math.min(127, Number(m[2]) || 0)),
        value: Math.max(0, Math.min(127, Number(m[3]) || 0)),
        channel: m[4] ? Math.max(1, Math.min(16, Number(m[4]))) : 1,
      });
    } catch { /* Nicht-Text-Payload ignorieren */ }
  }
}

export const oscAdapter = new OSCAdapter();

// ---------------------------------------------------------------------------
// Zentraler Factory/Registry (für künftiges Hot-Swapping)
// ---------------------------------------------------------------------------
export interface Backends {
  audio: IAudioBackend;
  ai: IAIRuntime;
  compute: IComputeBackend;
  spatial: ISpatialRenderer;
  hardware: IHardwareAdapter;
  transport: ITransport;
}

/**
 * Baut die Standard-Suite von Backends (Audio wird lazy geladen).
 * @param opts.transport 'p2p' (Standard) | 'sfu' – wählt den Kollaborations-
 *   Transport. SFU skaliert für 10+ Benutzer (Mediasoup), P2P ist der Default.
 */
export async function createBackends(opts?: { transport?: 'p2p' | 'sfu' }): Promise<Backends> {
  const { webAudioBackend } = await import('./WebAudioBackend');
  let transport: ITransport = webRTCTransport;
  if (opts?.transport === 'sfu') {
    try {
      const { sfuTransport } = await import('./transport/MediasoupTransport');
      transport = sfuTransport;
    } catch {
      transport = webRTCTransport; // SFU deployment nicht verfügbar → P2P-Fallback
    }
  }
  return {
    audio: webAudioBackend,
    compute: computeBackend,
    hardware: webMIDIAdapter,
    spatial: spatialRenderer,
    ai: aiRuntime,
    transport,
  };
}

export type { ComputeMode };
