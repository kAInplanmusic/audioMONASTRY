/**
 * audioMONASTRY · Phase 1 – Referenz-Adapter (1.1.2 … 1.1.6)
 * ==========================================================
 * Konkrete, funktionale Referenzimplementierungen hinter den Abstraktions-
 * Interfaces. Diese Adapter wrappen die bereits vorhandene Engine-Logik
 * (WebRTCManager, spatialMath) und bieten saubere Fallback-Ketten.
 *
 * Hardware-Adapter (WebMIDI/HID/OSC) erzeugen sowohl das Legacy-
 * `ControlMessage` als auch das transportagnostische `ControlEvent`.
 */
import { webRTCManager } from '../utils/WebRTCManager';
import {
  calculateChannelPan, calculateHRTF, getSetup,
} from '../utils/spatialMath';
import { workerPool } from './workers/WorkerPool';
import {
  AIBackendKind, AIResult, AudioSignal, ComputeMode, ControlEvent,
  ControlMessage, IAudioBackend, IAIRuntime, IComputeBackend, IComputeJob,
  IHardwareAdapter, ISpatialRenderer, SpatialSource, ITransport, TransportMode,
} from './interfaces';
import {
  MidiStreamParser, midiEventToControlMessage,
  encodeControlMessage,
} from './hardware/midiCodec';
// Rückwärtskompatibler Re-Export (Funktionen liegen jetzt im MIDI-Codec).
export { midiEventToControlMessage, encodeControlMessage } from './hardware/midiCodec';
import {
  HidReportDescriptor, HidReportField, HidReportType,
  extractHidReportValues, encodeHidOutputReport,
} from './hardware/hidReport';
import {
  decodeOscPacket, encodeOscMessage, OscArgument, OscMessage, parseControlAddress,
} from './hardware/oscCodec';
import { controlMessageToEvent, nowMs } from './hardware/controlEvent';

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
    void hrtf; // HRTF-Anteil fließt über spatialMath-Panning ein
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
  private _onControlEvent: (ev: ControlEvent) => void = () => {};
  private access: MIDIAccess | null = null;
  private parsers = new Map<string, MidiStreamParser>();
  private outputs: MIDIOutput[] = [];
  private stateChangeHandler: ((e: Event) => void) | null = null;
  private midiHandlers = new Map<string, (e: MIDIMessageEvent) => void>();

  onControl(cb: (msg: ControlMessage) => void): void { this._onControl = cb; }
  onControlEvent(cb: (ev: ControlEvent) => void): void { this._onControlEvent = cb; }

  async connect(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      throw new Error('Web MIDI nicht verfügbar');
    }
    // SysEx bevorzugt; manche Browser verweigern das → Fallback ohne SysEx.
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
    } catch {
      this.access = await navigator.requestMIDIAccess();
    }
    this.bindPorts(this.access);
    this.stateChangeHandler = () => {
      if (this.access) this.bindPorts(this.access);
    };
    this.access.onstatechange = this.stateChangeHandler;
  }

  private bindPorts(access: MIDIAccess): void {
    const currentIds = new Set<string>();
    access.inputs.forEach((port) => {
      currentIds.add(port.id);
      if (!this.parsers.has(port.id)) this.parsers.set(port.id, new MidiStreamParser());
      const parser = this.parsers.get(port.id)!;
      const deviceId = port.id;

      // addEventListener statt onmidimessage: koexistiert mit dem useMIDI-Hook
      // (der die Legacy-Property nutzt) und weiteren ControlHub-Listenern.
      if (this.midiHandlers.has(port.id)) return;
      const handler = (e: MIDIMessageEvent) => {
        const events = parser.push(e.data as unknown as ArrayLike<number>);
        for (const ev of events) {
          const msg = midiEventToControlMessage(ev);
          this._onControl(msg);
          this._onControlEvent(controlMessageToEvent(msg, deviceId, 'midi'));
        }
      };
      this.midiHandlers.set(port.id, handler);
      try {
        port.addEventListener?.('midimessage', handler as EventListener);
      } catch {
        // Fallback für sehr alte Implementierungen.
        port.onmidimessage = handler;
      }
    });
    // Entfernte Ports aufräumen.
    for (const [id, handler] of [...this.midiHandlers]) {
      if (!currentIds.has(id)) {
        const port = access.inputs.get(id);
        if (port) {
          try { port.removeEventListener?.('midimessage', handler as EventListener); } catch { /* ignore */ }
          if (port.onmidimessage === (handler as unknown as typeof port.onmidimessage)) port.onmidimessage = null;
        }
        this.midiHandlers.delete(id);
        this.parsers.delete(id);
      }
    }
    this.outputs = Array.from(access.outputs.values());
  }

  disconnect(): void {
    if (this.access) {
      this.access.onstatechange = null;
      this.access.inputs.forEach((p) => {
        const handler = this.midiHandlers.get(p.id);
        if (handler) {
          try { p.removeEventListener?.('midimessage', handler as EventListener); } catch { /* ignore */ }
          if (p.onmidimessage === (handler as unknown as typeof p.onmidimessage)) p.onmidimessage = null;
        }
      });
    }
    this.midiHandlers.clear();
    this.parsers.clear();
    this.outputs = [];
    this.access = null;
  }

  send(msg: ControlMessage): void {
    const bytes = encodeControlMessage(msg);
    if (bytes.length === 0) return;
    for (const out of this.outputs) {
      try { out.send(bytes); } catch { /* Port getrennt – best effort */ }
    }
  }
}


export const webMIDIAdapter = new WebMIDIAdapter();

// ---------------------------------------------------------------------------
// 1.1.5 · HIDAdapter – generische WebHID-Anbindung (Report-Descriptoren)
// ---------------------------------------------------------------------------

interface WebHidLikeDevice {
  vendorId?: number;
  productId?: number;
  productName?: string;
  opened?: boolean;
  open?: () => Promise<void>;
  close?: () => void;
  collections?: WebHidCollection[];
  oninputreport?: ((e: { data?: Uint8Array | DataView }) => void) | null;
}

interface WebHidCollection {
  usagePage?: number;
  usage?: number;
  inputReports?: WebHidReport[];
  outputReports?: WebHidReport[];
  featureReports?: WebHidReport[];
  children?: WebHidCollection[];
}

interface WebHidReport {
  reportId?: number;
  items?: WebHidItem[];
}

interface WebHidItem {
  usagePage?: number;
  usages?: number[];
  usageMinimum?: number;
  usageMaximum?: number;
  reportSize?: number;
  reportCount?: number;
  logicalMinimum?: number;
  logicalMaximum?: number;
  isAbsolute?: boolean;
}

/** Baut Feld-Definitionen aus WebHID-Collections (Browser hat Descriptor geparst). */
export function fieldsFromWebHidCollections(collections: WebHidCollection[] | undefined): HidReportDescriptor {
  const fields: HidReportField[] = [];
  const usagePages = new Set<number>();
  const usages = new Set<number>();

  const walk = (cols: WebHidCollection[], reportType: HidReportType): void => {
    for (const col of cols) {
      const reports = reportType === 'input'
        ? col.inputReports
        : reportType === 'output'
          ? col.outputReports
          : col.featureReports;
      for (const report of reports ?? []) {
        let bitOffset = 0;
        for (const item of report.items ?? []) {
          const count = Math.max(1, item.reportCount ?? 1);
          const size = Math.max(1, item.reportSize ?? 1);
          const usagesList = item.usages ?? [];
          const hasRange = item.usageMinimum !== undefined && item.usageMaximum !== undefined;
          for (let i = 0; i < count; i++) {
            const usage = usagesList[i] ?? (hasRange ? (item.usageMinimum ?? 0) + i : item.usageMinimum ?? 0);
            const page = item.usagePage ?? 0;
            usagePages.add(page);
            usages.add(usage);
            fields.push({
              reportId: report.reportId ?? 0,
              reportType,
              usagePage: page,
              usage,
              bitOffset: bitOffset + i * size,
              bitSize: size,
              logicalMin: item.logicalMinimum ?? 0,
              logicalMax: item.logicalMaximum ?? 1,
              isRelative: item.isAbsolute === false,
              isArray: usagesList.length === 0 && hasRange,
            });
          }
          bitOffset += count * size;
        }
      }
      walk(col.children ?? [], reportType);
    }
  };
  walk(collections ?? [], 'input');
  walk(collections ?? [], 'output');
  walk(collections ?? [], 'feature');

  return {
    fields,
    usagePages: [...usagePages].sort((a, b) => a - b),
    usages: [...usages].sort((a, b) => a - b),
  };
}

export class HIDAdapter implements IHardwareAdapter {
  readonly id = 'hid';

  private _onControl: (msg: ControlMessage) => void = () => {};
  private _onControlEvent: (ev: ControlEvent) => void = () => {};
  private devices: WebHidLikeDevice[] = [];
  private descriptors = new Map<WebHidLikeDevice, HidReportDescriptor>();

  onControl(cb: (msg: ControlMessage) => void): void { this._onControl = cb; }
  onControlEvent(cb: (ev: ControlEvent) => void): void { this._onControlEvent = cb; }

  async connect(): Promise<void> {
    const nav = navigator as unknown as {
      hid?: { requestDevice: (opts: { filters: unknown[] }) => Promise<WebHidLikeDevice[]> };
    };
    if (!nav?.hid?.requestDevice) throw new Error('WebHID nicht verfügbar');
    const devices = await nav.hid.requestDevice({ filters: [] });
    this.devices = devices;
    for (const raw of devices) {
      if (!raw.opened && raw.open) {
        try { await raw.open(); } catch { /* Gerät blockiert – überspringen */ }
      }
      const descriptor = fieldsFromWebHidCollections(raw.collections);
      this.descriptors.set(raw, descriptor);
      raw.oninputreport = (e) => {
        const data = e.data;
        if (!data || data.byteLength === 0) return;
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const values = extractHidReportValues(bytes, descriptor);
        for (const v of values) {
          this.emitHidValue(raw, v.field.usagePage, v.field.usage, v.raw, v.normalized01, v.field);
        }
      };
    }
  }

  private emitHidValue(device: WebHidLikeDevice, usagePage: number, usage: number, raw: number, normalized01: number, field: HidReportField): void {
    // Eindeutige numerische Adresse: UsagePage in den oberen 16 Bit.
    const parameter = ((usagePage & 0xffff) * 65536) + (usage & 0xffff);
    const resolution = Math.max(1, field.logicalMax - field.logicalMin);
    const semantics = field.isRelative ? 'relative'
      : usagePage === 0x09 ? 'momentary'
      : 'absolute';
    const ev: ControlEvent = {
      sourceDevice: `${device.vendorId?.toString(16) ?? '0000'}:${device.productId?.toString(16) ?? '0000'}`,
      sourceProtocol: 'hid',
      channel: 0,
      parameter,
      value: raw,
      resolution,
      messageType: 'cc',
      timestamp: nowMs(),
      semantics,
      address: `hid:0x${usagePage.toString(16)}:0x${usage.toString(16)}`,
    };
    this._onControlEvent(ev);
    // Legacy-Äquivalent: 7-Bit-kompatibles CC (Buttons/Fader direkt nutzbar).
    const v7 = Math.max(0, Math.min(127, Math.round(normalized01 * 127)));
    this._onControl({ kind: 'cc', idNum: parameter & 0x7f, value: v7, channel: 1 });
  }

  disconnect(): void {
    for (const raw of this.devices) {
      if (raw.oninputreport) raw.oninputreport = null;
      try { raw.close?.(); } catch { /* ignore */ }
    }
    this.devices = [];
    this.descriptors.clear();
  }

  send(msg: ControlMessage): void {
    // HID-Rückkanal (LEDs/Motorfader): schreibt Output-Reports, wenn der
    // Descriptor passende Output-Felder enthält. Die Adresse folgt der
    // emitHidValue-Kodierung: usagePage in den oberen, usage in den unteren
    // 16 Bit von `idNum`. Ohne Output-Deskriptor bleibt der Aufruf no-op
    // (dokumentierter Best-Effort, kein Fake).
    if (!Number.isFinite(msg.idNum) || msg.idNum < 0) return;
    const usagePage = Math.floor(msg.idNum / 65536) & 0xffff;
    const usage = msg.idNum % 65536;

    for (const device of this.devices) {
      const descriptor = this.descriptors.get(device);
      if (!descriptor) continue;
      const outputFields = descriptor.fields.filter((f) => f.reportType === 'output');
      if (outputFields.length === 0) continue;

      const field = outputFields.find((f) => f.usagePage === usagePage && f.usage === usage);
      if (!field) continue;

      const span = field.logicalMax - field.logicalMin;
      const raw = span > 0
        ? field.logicalMin + (Math.max(0, Math.min(127, msg.value)) / 127) * span
        : msg.value > 0 ? field.logicalMax : field.logicalMin;

      const data = encodeHidOutputReport(descriptor.fields, 'output', field.reportId, [
        { usagePage, usage, raw },
      ]);
      if (data.length === 0) continue;

      const out = device as WebHidLikeDevice & { sendReport?: (reportId: number, data: Uint8Array) => Promise<void> };
      try {
        void out.sendReport?.(field.reportId, data);
      } catch { /* Gerät getrennt – Best Effort */ }
    }
  }
}

export const hidAdapter = new HIDAdapter();

// ---------------------------------------------------------------------------
// 1.1.5 · OSCAdapter – echter OSC-Codec (UDP via Server-Bridge/WS-Transport)
// ---------------------------------------------------------------------------
export class OSCAdapter implements IHardwareAdapter {
  readonly id = 'osc';

  private ws: WebSocket | null = null;
  private _onControl: (msg: ControlMessage) => void = () => {};
  private _onControlEvent: (ev: ControlEvent) => void = () => {};

  constructor(private url = 'ws://127.0.0.1:9000') {}

  onControl(cb: (msg: ControlMessage) => void): void { this._onControl = cb; }
  onControlEvent(cb: (ev: ControlEvent) => void): void { this._onControlEvent = cb; }

  async connect(): Promise<void> {
    if (typeof WebSocket === 'undefined') throw new Error('WebSocket nicht verfügbar');
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
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Echtes OSC (Big-Endian): /control/<kind>/<id> mit Args [value, channel].
    const address = `/control/${msg.kind}/${Math.max(0, Math.round(msg.idNum))}`;
    const args: OscArgument[] = [
      { type: 'f', value: msg.value },
      { type: 'i', value: msg.channel },
    ];
    try {
      this.ws.send(encodeOscMessage(address, args));
    } catch {
      // Transportfehler isolieren – App bleibt stabil.
    }
  }

  /** Versteht binäre OSC-Pakete und (legacy) Text-Pfade. */
  private handleIncoming(data: unknown): void {
    try {
      if (typeof data === 'string') {
        this.handleText(data);
        return;
      }
      const bytes = data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : null;
      if (!bytes) return;
      const packet = decodeOscPacket(bytes);
      const messages: OscMessage[] = packet.kind === 'bundle'
        ? packet.elements.filter((p): p is OscMessage => p.kind === 'message')
        : [packet];
      for (const m of messages) this.handleOscMessage(m);
    } catch { /* Nicht-OSC-Payload ignorieren */ }
  }

  private handleOscMessage(m: OscMessage): void {
    const parsed = parseControlAddress(m.address);
    if (!parsed) return;
    const value = m.args[0]?.type === 'f' || m.args[0]?.type === 'i' || m.args[0]?.type === 'd'
      ? (m.args[0] as { value: number }).value
      : parsed.value;
    const channel = m.args[1]?.type === 'i' ? (m.args[1] as { value: number }).value : parsed.channel;

    const kind: ControlMessage['kind'] =
      parsed.kind === 'noteon' ? 'noteOn'
      : parsed.kind === 'noteoff' ? 'noteOff'
      : parsed.kind === 'cc' ? 'cc'
      : parsed.kind === 'pitch' ? 'pitch'
      : parsed.kind === 'program' ? 'program'
      : 'osc';

    const msg: ControlMessage = {
      kind,
      idNum: Math.max(0, Math.min(127, parsed.id)),
      value: Math.max(0, Math.min(127, Number(value) || 0)),
      channel: Math.max(1, Math.min(16, channel || 1)),
    };
    this._onControl(msg);
    this._onControlEvent(controlMessageToEvent(msg, this.url, 'osc'));
  }

  private handleText(text: string): void {
    const m = /^\/control\/([a-zA-Z]+)\/(\d+)\/([-0-9.]+)(?:\/(\d+))?/.exec(text.trim());
    if (!m) return;
    const rawKind = m[1].toLowerCase();
    const kind: ControlMessage['kind'] =
      rawKind === 'noteon' ? 'noteOn'
      : rawKind === 'noteoff' ? 'noteOff'
      : rawKind === 'cc' ? 'cc'
      : rawKind === 'pitch' ? 'pitch'
      : rawKind === 'program' ? 'program'
      : 'osc';
    const msg: ControlMessage = {
      kind,
      idNum: Math.max(0, Math.min(127, Number(m[2]) || 0)),
      value: Math.max(0, Math.min(127, Number(m[3]) || 0)),
      channel: m[4] ? Math.max(1, Math.min(16, Number(m[4]))) : 1,
    };
    this._onControl(msg);
    this._onControlEvent(controlMessageToEvent(msg, this.url, 'osc'));
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
