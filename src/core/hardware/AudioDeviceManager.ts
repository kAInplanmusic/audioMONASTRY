/**
 * audioMONASTRY · Phase 2/4 – Audio Device Manager
 * =================================================
 * Plugin-Architektur für Audio-Backends (ASIO/CoreAudio/PipeWire/WASAPI).
 *
 * Erweiterung gegenüber dem Audit-Stand:
 * - Capabilities (Samplerates, Buffer, Kanäle, Bit-Tiefe) statt hartem
 *   48 kHz/Stereo-Default
 * - Latency-Modell (Input/Output/Round-Trip/Buffer/Safety-Offset)
 * - Device-Events (CONNECTED/DISCONNECTED/CHANGED/RECONNECTED)
 * - Start/Stop + Device-State-Maschine
 */
export type AudioDeviceBackendKind = 'asio' | 'coreaudio' | 'pipewire' | 'wasapi';

export type AudioDeviceState = 'disconnected' | 'connected' | 'opened' | 'running';

export interface AudioDeviceCapabilities {
  /** Unterstützte Samplerates (leer = unbekannt, nicht annehmen!). */
  sampleRates: number[];
  /** Unterstützte Puffergrößen in Samples (leer = unbekannt). */
  bufferSizes: number[];
  inputChannels: number;
  outputChannels: number;
  /** Unterstützte Bit-Tiefen (leer = unbekannt). */
  bitDepths?: number[];
}

export interface AudioLatencyInfo {
  inputLatencyMs: number;
  outputLatencyMs: number;
  roundTripMs: number;
  bufferMs: number;
  /** Sicherheits-Offset für Scheduling (Backend-spezifisch). */
  safetyOffsetMs: number;
}

export interface AudioDevice {
  id: string;
  name: string;
  backend: AudioDeviceBackendKind;
  inputChannels: number;
  outputChannels: number;
  isDefault: boolean;
  state: AudioDeviceState;
  /** Vom Backend gemeldete Fähigkeiten (NIE hart annehmen). */
  capabilities?: AudioDeviceCapabilities;
  /** Aktuelle Latenz (nur nach open() bzw. aus Backend-Metriken). */
  latency?: AudioLatencyInfo;
}

export type AudioDeviceEventKind = 'CONNECTED' | 'DISCONNECTED' | 'CHANGED' | 'RECONNECTED';

export interface AudioDeviceEvent {
  kind: AudioDeviceEventKind;
  device: AudioDevice;
  at: number;
}

export interface IAudioDeviceBackend {
  readonly kind: AudioDeviceBackendKind;
  readonly available: boolean;
  listDevices(): Promise<AudioDevice[]>;
  open(deviceId: string): Promise<void>;
  close(): Promise<void>;
  /** Startet den Stream (nach open). */
  start(): Promise<void>;
  /** Stoppt den Stream (Gerät bleibt offen). */
  stop(): Promise<void>;
  /** Fähigkeiten eines Geräts abfragen (darf NIE raten). */
  getCapabilities(deviceId: string): Promise<AudioDeviceCapabilities>;
  /** Aktuelle Latenz-Metriken (nach open/start). */
  getLatency(deviceId: string): Promise<AudioLatencyInfo>;
  /** Device-Wechsel beobachten (Hot-Plug). */
  onDeviceChange: (cb: (event: AudioDeviceEvent) => void) => () => void;
}

export class AudioDeviceManager {
  private backends = new Map<AudioDeviceBackendKind, IAudioDeviceBackend>();
  private active: { backend: IAudioDeviceBackend; device: AudioDevice } | null = null;
  private deviceCache = new Map<string, AudioDevice>();
  private listeners = new Set<(event: AudioDeviceEvent) => void>();

  registerBackend(backend: IAudioDeviceBackend): void {
    this.backends.set(backend.kind, backend);
  }

  listBackends(): IAudioDeviceBackend[] {
    return [...this.backends.values()];
  }

  /** Device-Events abonnieren (Manager-Ebene, transportagnostisch). */
  onDeviceEvent(cb: (event: AudioDeviceEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: AudioDeviceEvent): void {
    for (const cb of this.listeners) {
      try { cb(event); } catch { /* Listener darf Manager nicht sprengen */ }
    }
  }

  async listAllDevices(): Promise<AudioDevice[]> {
    const all: AudioDevice[] = [];
    for (const backend of this.backends.values()) {
      if (!backend.available) continue;
      try {
        const devices = await backend.listDevices();
        for (const d of devices) this.deviceCache.set(d.id, d);
        all.push(...devices);
      } catch {
        // Ein defektes Backend/Gerät darf die Enumeration nicht sprengen.
        continue;
      }
    }
    return all;
  }

  async open(backendKind: AudioDeviceBackendKind, deviceId: string): Promise<void> {
    const backend = this.backends.get(backendKind);
    if (!backend) throw new Error(`Backend nicht registriert: ${backendKind}`);
    await backend.open(deviceId);
    const devices = await backend.listDevices();
    const device = devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`Gerät nicht gefunden: ${deviceId}`);
    this.active = { backend, device };
    this.emit({ kind: 'CHANGED', device, at: Date.now() });
  }

  async start(): Promise<void> {
    if (!this.active) throw new Error('Kein Gerät geöffnet.');
    await this.active.backend.start();
    this.active.device.state = 'running';
    this.emit({ kind: 'CHANGED', device: this.active.device, at: Date.now() });
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    await this.active.backend.stop();
    this.active.device.state = 'opened';
    this.emit({ kind: 'CHANGED', device: this.active.device, at: Date.now() });
  }

  get activeDevice(): AudioDevice | null {
    return this.active?.device ?? null;
  }

  async close(): Promise<void> {
    if (this.active) await this.active.backend.close();
    this.active = null;
  }

  /** Fähigkeiten eines Geräts (über sein Backend; NIE geraten). */
  async getCapabilities(backendKind: AudioDeviceBackendKind, deviceId: string): Promise<AudioDeviceCapabilities> {
    const backend = this.backends.get(backendKind);
    if (!backend) throw new Error(`Backend nicht registriert: ${backendKind}`);
    return backend.getCapabilities(deviceId);
  }

  /** Latenz-Metriken eines Geräts. */
  async getLatency(backendKind: AudioDeviceBackendKind, deviceId: string): Promise<AudioLatencyInfo> {
    const backend = this.backends.get(backendKind);
    if (!backend) throw new Error(`Backend nicht registriert: ${backendKind}`);
    return backend.getLatency(deviceId);
  }
}
