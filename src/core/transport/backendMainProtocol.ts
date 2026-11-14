/** Backend Main wire protocol, version 1. All integer fields are little endian. */
export const BACKEND_MAIN_PATH = '/api/main-audio';
export const BACKEND_MAIN_HEADER_BYTES = 16;
export const BACKEND_MAIN_RATES = [48000, 96000, 192000] as const;
export type BackendMainRate = typeof BACKEND_MAIN_RATES[number];
export type BackendMainRole = 'contributor' | 'pa' | 'monitor';
export interface BackendMainReady { type: 'ready'; sampleRate: BackendMainRate; channels: 2; format: 's24le'; frame: number }
export interface BackendMainChunk { type: 'chunk'; sequence: number; startFrame: number; frames: number; sampleRate: BackendMainRate; format: 'flac' | 's24le'; fallbackReason?: 'encoder-slow' | 'encoder-delayed'; encodeMs?: number }

/** Stereo interleaved signed PCM24LE follows a fixed 16-byte header. */
export function encodeBackendMainInput(sequence: number, startFrame: number, pcm: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff || !Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame > 0xffffffff || pcm.length === 0 || pcm.length % 6 !== 0) throw new Error('Invalid Main input');
  const packet = new Uint8Array(BACKEND_MAIN_HEADER_BYTES + pcm.length);
  packet.set([0x42, 0x4d, 0x41, 0x31]);
  const view = new DataView(packet.buffer);
  view.setUint32(4, sequence, true); view.setUint32(8, startFrame, true); view.setUint32(12, pcm.length / 6, true);
  packet.set(pcm, BACKEND_MAIN_HEADER_BYTES);
  return packet;
}
