/**
 * 
 * audioMONASTRY · Phase 1 – Core-Abstraktionsschichten
 * =====================================================
 * Technologieunabhängige Interfaces (Aufg. 1.1), damit die 16 Kernmodule
 * ausschließlich über Abstraktionen mit Browser-/KI-/Compute-/Spatial-/
 * Hardware-/Transport-Backends kommunizieren.
 */

// ---------------------------------------------------------------------------
// Basis-Signal-Typen
// ---------------------------------------------------------------------------
/** Ein mono-/stereo-Audio-Sample oder Live-Signal (64-bit-float, planar). */
export interface AudioSignal {
  channelData: Float32Array[];
  sampleRate: number;
}

/** Eine zeitgestempelte Einzelnotiz/MIDI-ähnliches Event. */
export interface AudioEvent {
  track: string;        // z.B. 'channel1'
  step: number;         // 0..15
  time: number;         // Sekunden (Transport-Zeit)
  velocity: number;     // 0..1
}

// ---------------------------------------------------------------------------
// 1.1.1 · IAudioBackend
// ---------------------------------------------------------------------------
/**
 * Abstrahiert die gesamte Audio-Verarbeitung (Klangsynthese, Sample-Playback,
 * Mixer, Effekte, Analyse). Referenzimplementierung: WebAudioBackend (wrapper
 * um die bestehende AudioEngine/Tone.js-Kette).
 */
export interface IAudioBackend {
  readonly id: string;

  /** Einmalige Initialisierung (weckt Browser-AudioContext etc.). */
  init(): Promise<void>;

  /** Play/Pause der globalen Uhr. */
  play(): Promise<void>;
  stop(): void;

  /** Setzt das Tempo (BPM) für alle synchronisierten Stimmen. */
  setTempo(bpm: number): void;
  getTempo(): number;

  /** Lade ein externes Audio-Asset (mp3/wav/…). */
  loadTrackSample(track: string, url: string | null): Promise<void>;
  /** Triggert ein (geladenes) Sample/eine Stimme einmalig. */
  triggerEvent(track: string, velocity?: number, time?: number): void;

  /** Kanal-Mischung: Lautstärke (0..~1.5), Pan (-1..1). */
  setChannelGain(track: string, gain01: number): void;
  setChannelPan(track: string, pan: number): void;
  /** 3-Band-EQ pro Kanal (gain in dB). */
  setChannelEQ(track: string, band: 'low' | 'mid' | 'high', gain: number): void;

  /** Master-Lautstärke. */
  setMasterVolume(gain01: number): void;

  /** Fortschritt des Sequenzers (Step 0..15). */
  onStepUpdate: (cb: (step: number) => void) => void;
}

// ---------------------------------------------------------------------------
// 1.1.2 · IAIRuntime
// ---------------------------------------------------------------------------
export type AIBackendKind = 'local' | 'remote' | 'deterministic';

/** Einheits-Ergebnis einer KI-Inferenz. */
export interface AIResult {
  kind: AIBackendKind;
  latencyMs: number;
  data: unknown;
}

export interface AIAudioResult extends AIResult {
  /** Stem-Separation, Voice-Synthese o.ä. Dazu zählt z.B. 'stems' | 'voice' | 'embedding'. */
  audio?: Record<string, AudioSignal>;
}

/**
 * Abstrahiert lokale (WebGPU/ONNX/WASM) vs. remote (API) vs. deterministische
 * Inferenz. Referenzadapter: VoiceGen/StemExtractor, Fallback deterministisch.
 */
export interface IAIRuntime {
  readonly id: string;
  canRun(kind: AIBackendKind, task: string): boolean;
  /** Führt eine (optionale, asynchrone) Inferenz aus – darf echten Audio-Thread nie blockieren. */
  infer(task: string, input: unknown): Promise<AIResult>;
}

// ---------------------------------------------------------------------------
// 1.1.3 · IComputeBackend
// ---------------------------------------------------------------------------
export type ComputeMode = 'live' | 'offline';

/** Abstrahiert rechenintensive, NICHT-echtzeitkritische Operationen. */
export interface IComputeJob<T = unknown> {
  mode: ComputeMode;
  task: string;
  input: T;
}

export interface IComputeBackend {
  readonly id: string;
  submit<T, R>(job: IComputeJob<T>): Promise<R>;
  /** Live-Modus: kurz & vorhersagbar; Offline-Modus: darf lange blockieren. */
}

// ---------------------------------------------------------------------------
// 1.1.4 · ISpatialRenderer
// ---------------------------------------------------------------------------
export interface SpatialSource {
  id: string;
  x: number;        // -1..1 (Ring-Position)
  y: number;        // -1..1
  gain: number;     // 0..1
  spread: number;   // 0..1
}

export interface ISpatialRenderer {
  readonly id: string;
  /** Setzt Position/Gain/Spread einer Quelle. */
  setSource(src: SpatialSource): void;
  /** Räumt einen Audio-Signalbaum auf die Ziel-Kanal-Konfiguration. */
  render(signal: AudioSignal, source: SpatialSource): AudioSignal;
  /** Welche Mehrkanal-Konfiguration (z.B. 'stereo', 'binaural', '18.2'). */
  setSetup(setupId: string): void;
  /** Aktive Konfiguration (für Monitoring/Debugging). */
  getSetup(): string;
}

// ---------------------------------------------------------------------------
// 1.1.5 · IHardwareAdapter
// ---------------------------------------------------------------------------
export type ControlMessageKind =
  | 'noteOn' | 'noteOff' | 'cc' | 'pitch' | 'program' | 'osc'
  | 'polyAftertouch' | 'channelAftertouch'
  | 'clock' | 'start' | 'stop' | 'continue' | 'songPosition'
  | 'sysex' | 'nrpn' | 'rpn';

export interface ControlMessage {
  kind: ControlMessageKind;
  idNum: number;
  value: number;     // 0..127 (7-Bit), bei pitch 0..16383
  channel: number;   // 1..16
  /** SysEx-Payload ohne F0/F7 oder Transport-Position (Song Position, 14-Bit). */
  data?: number[];
  position?: number;
}

/**
 * Abstrahiert MIDI-/HID-/OSC-Controller. Referenz: MIDI-WebMIDI-Adapter.
 */
export interface IHardwareAdapter {
  readonly id: string;
  connect(): Promise<void>;
  disconnect(): void;
  onControl: (cb: (msg: ControlMessage) => void) => void;
  /** Transportagnostisches Event-Modell (für Mapping-Engine). Optional. */
  onControlEvent?: (cb: (ev: ControlEvent) => void) => void;
  /** Sende Logik-Ausgabe zurück zur Hardware (LEDs/Motorfader). */
  send(msg: ControlMessage): void;
}

// ---------------------------------------------------------------------------
// 1.1.5.1 · ControlEvent – transportagnostisches Control-Modell
// ---------------------------------------------------------------------------
/** Protokoll-Herkunft eines ControlEvents. */
export type ControlSourceProtocol = 'midi' | 'hid' | 'osc' | 'virtual';

/** Semantik-Klasse eines Controls (für Mapping-Engine). */
export type ControlSemantics =
  | 'absolute'   // Fader/Poti/Encoder mit Absolutwert (0..resolution)
  | 'relative'   // Endlos-Encoder/Jog (Deltawerte, ggf. mit Vorzeichen)
  | 'toggle'     // Umschalter (Wert wechselt 0/1 bei jedem Drücken)
  | 'momentary'; // Taster (1 solange gedrückt, 0 beim Loslassen)

/**
 * Das zentrale, transportagnostische Hardware-Event.
 *
 * PHYSICAL DEVICE → PROTOCOL → CONTROL EVENT → MAPPING → APP PARAMETER
 *
 * `parameter` ist die protokollspezifische Adresse (MIDI-CC-Nummer, HID-Usage,
 * OSC-Address). Applikations-Parameter dürfen dieses Event NIE direkt mit
 * physischen Geräten verknüpfen – das übernimmt ausschließlich die
 * Mapping-Engine.
 */
export interface ControlEvent {
  /** Eindeutige Geräte-ID (MIDI-Port-ID, HID-Device-ID, OSC-Endpoint). */
  sourceDevice: string;
  sourceProtocol: ControlSourceProtocol;
  /** MIDI-Kanal 1..16; für HID/OSC ohne Kanal = 0. */
  channel: number;
  /** Protokoll-Adresse: CC-Nummer, Note, HID-Usage, OSC-Address-Teil. */
  parameter: number;
  /** Rohwert (7-Bit, 14-Bit, HID-Logical, OSC-Float). */
  value: number;
  /** Auflösung des Rohwerts (127, 16383, 65535, 1.0 …). */
  resolution: number;
  messageType: ControlMessageKind;
  /** Monotone Zeit (performance.now()-Basis) in Millisekunden. */
  timestamp: number;
  /** Vom Adapter erkannte Semantik (falls bekannt). */
  semantics?: ControlSemantics;
  /** Freitext-Adresse für OSC (`/control/...`). */
  address?: string;
  /** Song Position (14-Bit) für MIDI-Transport-Events. */
  position?: number;
}

// ---------------------------------------------------------------------------
// 1.1.6 · ITransport
// ---------------------------------------------------------------------------
export type TransportMode = 'p2p' | 'sfu' | 'local';

/**
 * Abstrahiert Kollaborations-Transport (aktuell WebRTC Full-Mesh, zukünftig
 * SFU). Referenzimplementierung: WebRTCTransport (Wrapper um WebRTCManager).
 */
export interface ITransport {
  readonly id: string;
  readonly mode: TransportMode;

  connect(sessionId: string, userId: string): Promise<void>;
  disconnect(): void;

  /** Broadcast an alle verbundenen Peers. */
  broadcast(payload: unknown): void;
  /** Zustellung an einen spezifischen Peer. */
  sendTo(peerId: string, payload: unknown): void;

  onMessage: (cb: (payload: unknown, fromPeerId: string) => void) => void;
  onPeerJoin: (cb: (peerId: string) => void) => void;
  onPeerLeave: (cb: (peerId: string) => void) => void;

  /** Beinhaltet das lokale Clock-/PLL-sync-Protokoll (Zeitstempel-Austausch). */
  syncClock(): void;
}
