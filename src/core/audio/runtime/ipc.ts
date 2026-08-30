/**
 * audioMONASTRY · Phase 2 – IPC-Protokoll (React ↔ audioMONASTRY-runtime)
 * ========================================================================
 * Versionsstabiler, serialisierbarer Nachrichtenvertrag. Die Runtime kann
 * als eigener Prozess (Rust) oder als Worker/WASM-Modul laufen.
 */

import { random } from '../../../utils/random';

export const IPC_PROTOCOL_VERSION = 1;

export type IpcChannel =
  | 'graph.sync'
  | 'graph.process'
  | 'device.list'
  | 'device.open'
  | 'render.offline'
  | 'scene.update'
  | 'voice.speak'
  | 'ping';

export interface IpcMessage<T = unknown> {
  protocol: typeof IPC_PROTOCOL_VERSION;
  channel: IpcChannel;
  id: string;
  payload: T;
  timestamp: number;
}

export interface IpcResponse<T = unknown> {
  id: string;
  ok: boolean;
  error?: string;
  payload?: T;
}

export interface IpcTransport {
  send<T>(message: IpcMessage<T>): void;
  onMessage(cb: (message: IpcMessage) => void): void;
  onResponse(cb: (response: IpcResponse) => void): void;
  close(): void;
}

export function createIpcMessage<T>(channel: IpcChannel, payload: T, id?: string): IpcMessage<T> {
  return {
    protocol: IPC_PROTOCOL_VERSION,
    channel,
    id: id ?? `${channel}-${Date.now().toString(36)}-${random().toString(36).slice(2, 8)}`,
    payload,
    timestamp: Date.now(),
  };
}
