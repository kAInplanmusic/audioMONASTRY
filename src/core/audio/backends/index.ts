import type { IAudioGraphBackend } from './types';
import { NativeBackend } from './NativeBackend';
import { WasmBackend } from './WasmBackend';
import { WebAudioBackend } from './WebAudioBackend';

export type { IAudioGraphBackend } from './types';
export { WebAudioBackend } from './WebAudioBackend';
export { WasmBackend } from './WasmBackend';
export { NativeBackend } from './NativeBackend';

const registry = new Map<string, IAudioGraphBackend>();

export function registerBackend(backend: IAudioGraphBackend): void {
  registry.set(backend.id, backend);
}

export function getBackend(id: string): IAudioGraphBackend | undefined {
  return registry.get(id);
}

export function listBackends(): IAudioGraphBackend[] {
  return [...registry.values()];
}

/** Standard-Backends registrieren (WebAudio, WASM, Native).
 *  @deprecated Prototyp-Pfad: Der Live-Audiopfad der App läuft über
 *  `audioEngine` (Tone/WebAudio). Diese Backends sind ausschließlich für
 *  Offline-/Migrationstests vorgesehen und werden aktuell nirgends live
 *  registriert oder gerendert. */
export function registerDefaultBackends(): void {
  registerBackend(new WebAudioBackend());
  registerBackend(new WasmBackend());
  registerBackend(new NativeBackend());
}
