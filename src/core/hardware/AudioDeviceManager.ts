/**
 * audioMONASTRY · Phase 2/4 – Audio Device Manager
 * =================================================
 * Plugin-Architektur für Audio-Backends (ASIO/CoreAudio/PipeWire).
 * Xonar U7 wird als generisches USB-Audio-Gerät behandelt – KEINE Sonderfälle.
 */

export type AudioDeviceBackendKind = 'asio' | 'coreaudio' | 'pipewire' | 'wasapi';

export interface AudioDevice {
  id: string;
  name: string;
  backend: AudioDeviceBackendKind;
  inputChannels: number;
  outputChannels: number;
  isDefault: boolean;
}

export interface IAudioDeviceBackend {
  readonly kind: AudioDeviceBackendKind;
  readonly available: boolean;
  listDevices(): Promise<AudioDevice[]>;
  open(deviceId: string): Promise<void>;
  close(): Promise<void>;
}

export class AudioDeviceManager {
  private backends = new Map<AudioDeviceBackendKind, IAudioDeviceBackend>();
  private active: { backend: IAudioDeviceBackend; device: AudioDevice } | null = null;

  registerBackend(backend: IAudioDeviceBackend): void {
    this.backends.set(backend.kind, backend);
  }

  listBackends(): IAudioDeviceBackend[] {
    return [...this.backends.values()];
  }

  async listAllDevices(): Promise<AudioDevice[]> {
    const all: AudioDevice[] = [];
    for (const backend of this.backends.values()) {
      if (backend.available) all.push(...(await backend.listDevices()));
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
  }

  get activeDevice(): AudioDevice | null {
    return this.active?.device ?? null;
  }

  async close(): Promise<void> {
    if (this.active) await this.active.backend.close();
    this.active = null;
  }
}
