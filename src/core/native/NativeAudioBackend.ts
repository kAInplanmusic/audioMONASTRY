/**
 * audioMONASTRY · 8.1.1 – Native-Audio-Abstraktion (ASIO/CoreAudio/PipeWire)
 * ==========================================================================
 * Interface + Stub-Adapter für native Audio-Backends außerhalb des Browsers.
 * Gleiche Engine-Schnittstelle, native Performance (Sub-ms-Buffer).
 */
export interface NativeAudioDevice {
  id: string;
  name: string;
  sampleRate: number;
  bufferSize: number;
  inputChannels: number;
  outputChannels: number;
}

export interface NativeAudioBackend {
  readonly id: string;
  listDevices(): Promise<NativeAudioDevice[]>;
  open(deviceId: string, sampleRate: number, bufferSize: number): Promise<void>;
  close(): void;
  /** Callback mit Float32-Interleaved-Buffer (Audio-Thread). */
  onAudio: (cb: (input: Float32Array, output: Float32Array) => void) => void;
}

/**
 * Referenz-Stub für native Builds (Electron/Tauri). Im Browser nicht aktiv;
 * dient als Vertrag für ASIO/CoreAudio/PipeWire-Implementierungen.
 */
export class StubNativeAudioBackend implements NativeAudioBackend {
  readonly id = 'native-stub';
  private devices: NativeAudioDevice[] = [
    { id: 'pipewire-default', name: 'PipeWire Default', sampleRate: 48000, bufferSize: 64, inputChannels: 2, outputChannels: 10 },
  ];

  async listDevices(): Promise<NativeAudioDevice[]> {
    return this.devices;
  }

  async open(_deviceId: string, _sampleRate: number, _bufferSize: number): Promise<void> {
    // Native-Implementierung (ASIO/CoreAudio/PipeWire) hier einhängen.
  }

  close(): void { /* no-op im Browser */ }

  onAudio(_cb: (input: Float32Array, output: Float32Array) => void): void { /* no-op */ }
}

export const nativeAudioBackend = new StubNativeAudioBackend();
