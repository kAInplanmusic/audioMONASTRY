/**
 * audioMONASTRY · OSC-Bridge-Logik (plattformneutral)
 * =====================================================
 * Gemeinsame Übersetzungsregeln zwischen OSC, MIDI und ControlEvents.
 * Genutzt von:
 * - `OSCAdapter` (Browser, WebSocket)
 * - `services/midi-bridge` (Node-Sidecar, UDP/WS/MIDI)
 *
 * Bewusst ohne Netz-/Prozess-Abhängigkeiten → vollständig testbar.
 */
import type { ControlEvent } from '../interfaces';
import { controlMessageToEvent, nowMs } from './controlEvent';
import { parseControlAddress } from './oscCodec';
import type { OscArgument, OscMessage, OscPacket } from './oscCodec';

export interface BridgeOscMessage {
  type: 'osc';
  address: string;
  args: { type: string; value: unknown }[];
}

export interface BridgeMidiMessage {
  type: 'midi';
  bytes: number[];
}

export type BridgeMessage = BridgeOscMessage | BridgeMidiMessage;

const clamp7 = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));

/**
 * Übersetzt einen OSC-Pfad `/control/...` oder `/midi/...` in ein
 * transportagnostisches ControlEvent (für die Mapping-Engine).
 */
export function oscPacketToControlEvents(packet: OscPacket, sourceDevice: string): ControlEvent[] {
  const messages: OscMessage[] = packet.kind === 'bundle'
    ? packet.elements.filter((p): p is OscMessage => p.kind === 'message')
    : [packet];
  const out: ControlEvent[] = [];
  for (const m of messages) out.push(...oscMessageToControlEvents(m, sourceDevice));
  return out;
}

export function oscMessageToControlEvents(m: OscMessage, sourceDevice: string): ControlEvent[] {
  // 1) App-Konvention /control/<kind>/<id>[/<value>[/<channel>]]
  const parsed = parseControlAddress(m.address);
  if (!parsed) {
    const short = /^\/control\/([a-zA-Z]+)\/(\d+)$/.exec(m.address);
    if (short) {
      const value = firstNumber(m.args) ?? 0;
      const channel = secondNumber(m.args) ?? 1;
      const rawKind = short[1].toLowerCase();
      const kind = rawKind === 'noteon' ? 'noteOn'
        : rawKind === 'noteoff' ? 'noteOff'
        : rawKind === 'cc' ? 'cc'
        : rawKind === 'pitch' ? 'pitch'
        : rawKind === 'program' ? 'program'
        : 'osc';
      const msg = {
        kind: kind as ControlEvent['messageType'],
        idNum: Math.max(0, Math.min(127, Number(short[2]) || 0)),
        value: Math.max(0, Math.min(127, Number(value) || 0)),
        channel: Math.max(1, Math.min(16, channel || 1)),
      };
      const ev = controlMessageToEvent(msg, sourceDevice, 'osc');
      ev.address = m.address;
      return [ev];
    }
    return fallbackMidiPath(m, sourceDevice);
  }

  const value = firstNumber(m.args) ?? parsed.value;
  const channel = secondNumber(m.args) ?? parsed.channel;
  const kind = parsed.kind === 'noteon' ? 'noteOn'
    : parsed.kind === 'noteoff' ? 'noteOff'
    : parsed.kind === 'cc' ? 'cc'
    : parsed.kind === 'pitch' ? 'pitch'
    : parsed.kind === 'program' ? 'program'
    : 'osc';
  const msg = {
    kind: kind as ControlEvent['messageType'],
    idNum: Math.max(0, Math.min(127, parsed.id)),
    value: Math.max(0, Math.min(127, Number(value) || 0)),
    channel: Math.max(1, Math.min(16, channel || 1)),
  };
  const ev = controlMessageToEvent(msg, sourceDevice, 'osc');
  ev.address = m.address;
  return [ev];
}

/** midi-bridge-Konvention /midi/cc/<channel>/<cc> bzw. /midi/note/<channel>. */
function fallbackMidiPath(m: OscMessage, sourceDevice: string): ControlEvent[] {
  const cc = /^\/midi\/cc\/(\d+)\/(\d+)$/.exec(m.address);
  if (cc) {
    const value = firstNumber(m.args) ?? 0;
    const msg = {
      kind: 'cc' as const,
      idNum: Number(cc[2]) || 0,
      value: clamp7(value * 127),
      channel: (Number(cc[1]) || 0) + 1,
    };
    const ev = controlMessageToEvent(msg, sourceDevice, 'osc');
    ev.address = m.address;
    return [ev];
  }
  const note = /^\/midi\/note\/(\d+)$/.exec(m.address);
  if (note) {
    const midiNote = clamp7(firstNumber(m.args) ?? 60);
    const velocity = clamp7((secondNumber(m.args) ?? 1) * 127);
    const msg = { kind: velocity > 0 ? 'noteOn' as const : 'noteOff' as const, idNum: midiNote, value: velocity, channel: (Number(note[1]) || 0) + 1 };
    const ev = controlMessageToEvent(msg, sourceDevice, 'osc');
    ev.address = m.address;
    return [ev];
  }
  return [];
}

/** ControlEvent → OSC-Message (für Rückkanal/OSC-Out). */
export function controlEventToOsc(ev: ControlEvent): OscMessage {
  const address = `/control/${ev.messageType}/${ev.parameter}`;
  const args: OscArgument[] = [
    { type: 'f', value: ev.value },
    { type: 'i', value: ev.channel },
  ];
  return { kind: 'message', address, args };
}

/** MIDI-Bytes → OSC-Bridge-Konvention (wie services/midi-bridge). */
export function midiBytesToBridgeOsc(bytes: ArrayLike<number>): OscMessage[] {
  const out: OscMessage[] = [];
  if (bytes.length >= 3) {
    const status = bytes[0] & 0xff;
    const channel = status & 0x0f;
    const kind = status & 0xf0;
    if (kind === 0xb0) {
      out.push({ kind: 'message', address: `/midi/cc/${channel}/${bytes[1] & 0x7f}`, args: [{ type: 'f', value: (bytes[2] & 0x7f) / 127 }] });
    }
    if (kind === 0x90 && (bytes[2] & 0x7f) > 0) {
      out.push({ kind: 'message', address: `/midi/note/${channel}`, args: [{ type: 'i', value: bytes[1] & 0x7f }, { type: 'f', value: (bytes[2] & 0x7f) / 127 }] });
    }
    if (kind === 0xe0) {
      const value14 = ((bytes[2] & 0x7f) << 7) | (bytes[1] & 0x7f);
      out.push({ kind: 'message', address: `/midi/pitchbend/${channel}`, args: [{ type: 'f', value: value14 / 16383 }] });
    }
  }
  return out;
}

function firstNumber(args: OscArgument[]): number | undefined {
  const a = args[0];
  return a && (a.type === 'f' || a.type === 'i' || a.type === 'd') ? (a as { value: number }).value : undefined;
}

function secondNumber(args: OscArgument[]): number | undefined {
  const a = args[1];
  return a && (a.type === 'f' || a.type === 'i' || a.type === 'd') ? (a as { value: number }).value : undefined;
}

export { nowMs };
