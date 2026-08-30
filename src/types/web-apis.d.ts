// Globale Web-API-Deklarationen für das audioMONASTRY-Projekt (AudioWorklet, HID, GPU).
// Alles unter `declare global` → für alle Module implizit sichtbar.

declare global {
  /** Audio-Puffergröße in Frames, im AudioWorkletGlobalScope gültig. */
  const sampleRate: number;
  /** Aktuelle Frame-Position innerhalb des Audio-Puffers. */
  const currentFrame: number;
  /** Aktuelle Zeit in Sekunden seit Start des AudioContext. */
  const currentTime: number;

  abstract class AudioWorkletProcessor {
    readonly port: MessagePort;
    abstract process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>
    ): boolean;
  }

  function registerProcessor(
    name: string,
    processorCtor: new (...args: any[]) => AudioWorkletProcessor
  ): void;

  interface HIDDevice {
    readonly vendorId?: number;
    readonly productId?: number;
    readonly productName?: string;
  }

  interface HIDDeviceFilter {
    vendorId?: number;
    productId?: number;
    usagePage?: number;
    usage?: number;
  }

  interface HID extends EventTarget {
    getDevices(): Promise<HIDDevice[]>;
    requestDevice(options: { filters: HIDDeviceFilter[] }): Promise<HIDDevice[]>;
  }

  interface GPUDevice {}

  interface GPUAdapter {
    requestDevice(): Promise<GPUDevice>;
  }

  interface GPU {
    requestAdapter(): Promise<GPUAdapter | null>;
  }

  interface Navigator {
    hid?: HID;
    gpu?: GPU;
  }
}

// Markiert die Datei als ES-Modul, damit `declare global` wirksam wird.
export {};
