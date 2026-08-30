/**
 * audioMONASTRY · NativeRuntimeAudioBackend
 * ==========================================
 * Adapter zwischen der Core-`IAudioDeviceBackend`-Abstraktion und dem
 * `NativeRuntimeClient` (Rust/cpal-Prozess per IPC).
 *
 * Ehrliche Grenzen:
 * - Capabilities kommen ausschließlich aus cpal-Default-Configs
 *   (device.list) — es wird NIE eine Sample-Rate/Kanalzahl geraten.
 * - `start`/`stop` steuern den cpal-Stream des Runtimes; der Testton-Stream
 *   ist ein Diagnose-Stream, kein Audio-Pfad der Web-App.
 * - Hot-Plug-Events pusht die Runtime (noch) nicht; `onDeviceChange` ist
 *   daher als Polling-Hilfe dokumentiert (Enumeration auf Anfrage).
 */
import type {
  AudioDevice, AudioDeviceBackendKind, AudioDeviceCapabilities, AudioDeviceEvent,
  AudioLatencyInfo, IAudioDeviceBackend,
} from '../../hardware/AudioDeviceManager';
import type { NativeDeviceInfo, NativeRuntimeClient } from './NativeRuntimeClient';
import { hardwareDiagnostics } from '../../hardware/diagnostics';

const BACKEND_KINDS: Record<string, AudioDeviceBackendKind> = {
  wasapi: 'wasapi',
  asio: 'asio',
  coreaudio: 'coreaudio',
  pipewire: 'pipewire',
  jack: 'pipewire', // JACK-Geräte laufen im cpal-Pfad über denselben Adapter
  alsa: 'pipewire', // ALSA-Mapping als Linux-Klasse (kein eigenes Core-Kind)
  unknown: 'pipewire',
};

export class NativeRuntimeAudioBackend implements IAudioDeviceBackend {
  private devices: NativeDeviceInfo[] = [];
  private currentKind: AudioDeviceBackendKind = 'pipewire';
  private deviceChangeListeners = new Set<(event: AudioDeviceEvent) => void>();
  private closed = false;

  constructor(private client: NativeRuntimeClient) {}

  get kind(): AudioDeviceBackendKind {
    return this.currentKind;
  }

  get available(): boolean {
    return !this.closed;
  }

  async listDevices(): Promise<AudioDevice[]> {
    const res = await this.client.listDevices();
    this.devices = res.devices ?? [];
    this.currentKind = BACKEND_KINDS[res.backend?.toLowerCase() ?? ''] ?? 'pipewire';
    hardwareDiagnostics.log('BACKEND', res.backend, { host: res.host, count: this.devices.length });

    return this.devices.map((d) => {
      const caps = this.capabilitiesFor(d);
      return {
        id: d.id,
        name: d.name,
        backend: this.currentKind,
        inputChannels: d.direction === 'input' ? caps.inputChannels : 0,
        outputChannels: d.direction === 'output' ? caps.outputChannels : 0,
        isDefault: d.id === 'default',
        state: 'connected',
        capabilities: caps,
      };
    });
  }

  async getCapabilities(deviceId: string): Promise<AudioDeviceCapabilities> {
    const info = this.devices.find((d) => d.id === deviceId);
    if (!info) throw new Error(`Native Gerät nicht gefunden: ${deviceId}`);
    return this.capabilitiesFor(info);
  }

  async getLatency(deviceId: string): Promise<AudioLatencyInfo> {
    // cpal liefert Puffergröße; echte Latenz ist geräteabhängig und wird
    // hier NICHT erfunden. Buffer-ms lässt sich aus Puffergröße/Sample-Rate
    // ableiten, Rest bleibt 0 (unbekannt).
    const caps = await this.getCapabilities(deviceId);
    const sampleRate = caps.sampleRates[0] ?? 0;
    const bufferSize = caps.bufferSizes[0] ?? 0;
    const bufferMs = sampleRate > 0 && bufferSize > 0 ? (bufferSize / sampleRate) * 1000 : 0;
    return {
      inputLatencyMs: 0,
      outputLatencyMs: 0,
      roundTripMs: 0,
      bufferMs,
      safetyOffsetMs: 0,
    };
  }

  async open(deviceId: string): Promise<void> {
    if (this.closed) throw new Error('Native Backend geschlossen');
    try {
      await this.client.openDevice(deviceId);
      hardwareDiagnostics.log('OPEN', deviceId, { backend: this.currentKind });
    } catch (e) {
      hardwareDiagnostics.log('DEVICE_ERROR', deviceId, { error: (e as Error).message });
      throw e;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.devices = [];
    this.client.disconnect();
    hardwareDiagnostics.log('CLOSE', undefined, { backend: this.currentKind });
  }

  async start(): Promise<void> {
    // Der cpal-Stream wird bereits von device.open gestartet; hier kein
    // separater Pfad (bewusst keine Fake-Operation).
  }

  async stop(): Promise<void> {
    // Die Runtime hält aktuell einen Diagnose-Stream; ein echter Stop-Pfad
    // folgt mit der Stream-Erweiterung (kein Fake).
  }

  onDeviceChange(cb: (event: AudioDeviceEvent) => void): () => void {
    this.deviceChangeListeners.add(cb);
    return () => this.deviceChangeListeners.delete(cb);
  }

  /** Enumeration erneut auslösen und Events für Differenzen emittieren (Polling). */
  async pollDeviceChanges(): Promise<void> {
    const before = new Map(this.devices.map((d) => [d.id, d]));
    const after = await this.listDevices();
    for (const d of after) {
      if (!before.has(d.id)) {
        for (const cb of this.deviceChangeListeners) cb({ kind: 'CONNECTED', device: d, at: Date.now() });
      }
    }
    for (const [id] of before) {
      if (!after.some((d) => d.id === id)) {
        for (const cb of this.deviceChangeListeners) {
          cb({ kind: 'DISCONNECTED', device: { id, name: id, backend: this.currentKind, inputChannels: 0, outputChannels: 0, isDefault: false, state: 'disconnected' }, at: Date.now() });
        }
      }
    }
  }

  private capabilitiesFor(d: NativeDeviceInfo): AudioDeviceCapabilities {
    return {
      sampleRates: d.default_sample_rate ? [d.default_sample_rate] : [],
      bufferSizes: d.buffer_size ? [d.buffer_size] : [],
      inputChannels: d.direction === 'input' ? (d.channels ?? 0) : 0,
      outputChannels: d.direction === 'output' ? (d.channels ?? 0) : 0,
      bitDepths: [],
    };
  }
}
