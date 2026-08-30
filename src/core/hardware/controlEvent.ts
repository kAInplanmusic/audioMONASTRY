/**
 * audioMONASTRY · ControlEvent-Konvertierung
 * ===========================================
 * Wandelt zwischen dem Legacy-`ControlMessage` (7-Bit-MIDI-Zentrik) und dem
 * transportagnostischen `ControlEvent` (MIDI/HID/OSC) um. Die Mapping-Engine
 * konsumiert ausschließlich `ControlEvent`; Adapter dürfen beide liefern.
 */
import type { ControlEvent, ControlMessage, ControlSourceProtocol } from '../interfaces';

/** Liefert einen monotonen Zeitstempel (performance.now-Basis, ms). */
export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Standard-Auflösung je Message-Typ (für ControlMessage → ControlEvent). */
export function defaultResolution(kind: ControlMessage['kind']): number {
  switch (kind) {
    case 'pitch':
    case 'nrpn':
    case 'rpn':
    case 'songPosition':
      return 16383;
    case 'sysex':
      return 1;
    default:
      return 127;
  }
}

/**
 * Legacy-ControlMessage → ControlEvent (MIDI-Konvention, 7/14-Bit).
 * @param msg       ControlMessage
 * @param deviceId  Geräte-ID (Port-ID/Endpoint)
 * @param protocol  Protokoll (Standard: 'midi')
 */
export function controlMessageToEvent(
  msg: ControlMessage,
  deviceId: string,
  protocol: ControlSourceProtocol = 'midi',
): ControlEvent {
  const resolution = defaultResolution(msg.kind);
  return {
    sourceDevice: deviceId,
    sourceProtocol: protocol,
    channel: msg.channel,
    parameter: msg.idNum,
    value: msg.value,
    resolution,
    messageType: msg.kind,
    timestamp: nowMs(),
  };
}

/**
 * ControlEvent → ControlMessage (best effort, 7-Bit-Verlust ist dokumentiert).
 * 14-Bit-Werte werden auf 0..127 skaliert, SysEx-Payload wird übernommen.
 */
export function eventToControlMessage(ev: ControlEvent): ControlMessage {
  const value = ev.resolution > 127
    ? Math.max(0, Math.min(127, Math.round((ev.value / ev.resolution) * 127)))
    : Math.max(0, Math.min(127, Math.round(ev.value)));
  const msg: ControlMessage = {
    kind: ev.messageType,
    idNum: ev.parameter,
    value,
    channel: ev.channel,
  };
  if (ev.messageType === 'songPosition' && ev.position !== undefined) {
    msg.position = ev.position;
  }
  return msg;
}

/** Normiert einen Rohwert auf 0..1 (für Mapping/UI). */
export function normalizeControlValue(value: number, resolution: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(resolution) || resolution <= 0) return 0;
  return Math.max(0, Math.min(1, value / resolution));
}

/** Prüft, ob ein ControlMessage als "Note On" zu werten ist (Velocity > 0). */
export function isNoteOn(msg: ControlMessage): boolean {
  return msg.kind === 'noteOn' && msg.value > 0;
}
