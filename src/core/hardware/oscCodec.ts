/**
 * audioMONASTRY · OSC-Codec (plattformneutral, OSC 1.0)
 * ======================================================
 * Encode/Decode von OSC-Messages, Bundles und Timetags (Big-Endian,
 * 4-Byte-Alignment) ohne Netz-Abhängigkeit. Transport (UDP/WebSocket)
 * bleibt Aufgabe der Adapter-Schicht.
 */

export type OscArgument =
  | { type: 'i' | 'f' | 'd'; value: number }
  | { type: 't'; value: { seconds: number; fraction: number } }
  | { type: 's'; value: string }
  | { type: 'b'; value: Uint8Array }
  | { type: 'T' | 'F' | 'N' | 'I'; value: null };

export interface OscMessage {
  kind: 'message';
  address: string;
  args: OscArgument[];
}

export interface OscBundle {
  kind: 'bundle';
  /** NTP-Timetag als { seconds, fraction } (seconds seit 1900-01-01). */
  timetag: { seconds: number; fraction: number };
  elements: OscPacket[];
}

export type OscPacket = OscMessage | OscBundle;

/** NTP-Epoche (1900-01-01T00:00:00Z) in Unix-Millisekunden. */
const NTP_EPOCH_MS = 2208988800000;
const PAD = (n: number): number => (4 - (n % 4)) % 4;

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export function oscString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1 + PAD(bytes.length + 1));
  out.set(bytes, 0);
  return out; // Nullterminierung durch 0-Initialisierung
}

function writeOscArg(view: DataView, offset: number, arg: OscArgument): number {
  switch (arg.type) {
    case 'i': view.setInt32(offset, Math.round(arg.value), false); return 4;
    case 'f': view.setFloat32(offset, arg.value, false); return 4;
    case 'd': view.setFloat64(offset, arg.value, false); return 8;
    case 't': {
      view.setUint32(offset, arg.value.seconds >>> 0, false);
      view.setUint32(offset + 4, arg.value.fraction >>> 0, false);
      return 8;
    }
    case 's': {
      const bytes = oscString(arg.value);
      new Uint8Array(view.buffer, view.byteOffset + offset, bytes.length).set(bytes);
      return bytes.length;
    }
    case 'b': {
      const blob = arg.value;
      view.setInt32(offset, blob.length, false);
      new Uint8Array(view.buffer, view.byteOffset + offset + 4, blob.length).set(blob);
      return 4 + blob.length + PAD(blob.length);
    }
    case 'T': case 'F': case 'N': case 'I': return 0;
    default: return 0;
  }
}

/** Codiert eine OSC-Message (Big-Endian, 4-Byte-aligned). */
export function encodeOscMessage(address: string, args: OscArgument[] = []): Uint8Array {
  const addrBytes = oscString(address);
  const typeStr = ',' + args.map((a) => a.type).join('');
  const typeBytes = oscString(typeStr);

  let argsLen = 0;
  for (const a of args) {
    argsLen +=
      a.type === 'i' || a.type === 'f' ? 4
      : a.type === 'd' || a.type === 't' ? 8
      : a.type === 's' ? oscString(a.value).length
      : a.type === 'b' ? 4 + a.value.length + PAD(a.value.length)
      : 0;
  }

  const out = new Uint8Array(addrBytes.length + typeBytes.length + argsLen);
  const view = new DataView(out.buffer);
  out.set(addrBytes, 0);
  out.set(typeBytes, addrBytes.length);

  let offset = addrBytes.length + typeBytes.length;
  for (const a of args) offset += writeOscArg(view, offset, a);
  return out;
}

/** Codiert ein OSC-Bundle (Timetag + Elemente). */
export function encodeOscBundle(timetagSeconds: number, timetagFraction: number, elements: OscPacket[]): Uint8Array {
  const parts: Uint8Array[] = [oscString('#bundle')];
  const tag = new Uint8Array(8);
  const tagView = new DataView(tag.buffer);
  tagView.setUint32(0, timetagSeconds >>> 0, false);
  tagView.setUint32(4, timetagFraction >>> 0, false);
  parts.push(tag);

  for (const el of elements) {
    const encoded = encodeOscPacket(el);
    const size = new Uint8Array(4);
    new DataView(size.buffer).setInt32(0, encoded.length, false);
    parts.push(size, encoded);
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function encodeOscPacket(packet: OscPacket): Uint8Array {
  return packet.kind === 'message' ? encodeOscMessage(packet.address, packet.args) : encodeOscBundle(packet.timetag.seconds, packet.timetag.fraction, packet.elements);
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function decodeOscString(bytes: Uint8Array, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  const value = new TextDecoder().decode(bytes.subarray(offset, end));
  return { value, next: end + 1 + PAD(end + 1 - offset) };
}

function decodeOscArg(bytes: Uint8Array, type: string, offset: number, view: DataView): { arg: OscArgument; next: number } {
  switch (type) {
    case 'i': return { arg: { type: 'i', value: view.getInt32(offset, false) }, next: offset + 4 };
    case 'f': return { arg: { type: 'f', value: view.getFloat32(offset, false) }, next: offset + 4 };
    case 'd': return { arg: { type: 'd', value: view.getFloat64(offset, false) }, next: offset + 8 };
    case 't': {
      const seconds = view.getUint32(offset, false);
      const fraction = view.getUint32(offset + 4, false);
      return { arg: { type: 't', value: { seconds, fraction } }, next: offset + 8 };
    }
    case 's': {
      const { value, next } = decodeOscString(bytes, offset);
      return { arg: { type: 's', value }, next };
    }
    case 'b': {
      const len = view.getInt32(offset, false);
      const start = offset + 4;
      return { arg: { type: 'b', value: bytes.slice(start, start + len) }, next: start + len + PAD(len) };
    }
    case 'T': return { arg: { type: 'T', value: null }, next: offset };
    case 'F': return { arg: { type: 'F', value: null }, next: offset };
    case 'N': return { arg: { type: 'N', value: null }, next: offset };
    case 'I': return { arg: { type: 'I', value: null }, next: offset };
    default: return { arg: { type: 's', value: '' }, next: offset };
  }
}

/** Dekodiert eine OSC-Message. */
export function decodeOscMessage(bytes: Uint8Array): OscMessage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const addr = decodeOscString(bytes, 0);
  const typeTag = decodeOscString(bytes, addr.next);
  if (!typeTag.value.startsWith(',')) {
    throw new Error(`Ungültige OSC-Type-Tag: ${typeTag.value}`);
  }

  const args: OscArgument[] = [];
  let offset = typeTag.next;
  for (let i = 1; i < typeTag.value.length; i++) {
    const r = decodeOscArg(bytes, typeTag.value[i], offset, view);
    args.push(r.arg);
    offset = r.next;
  }
  return { kind: 'message', address: addr.value, args };
}

/** Dekodiert ein OSC-Paket (Message oder Bundle). */
export function decodeOscPacket(bytes: ArrayLike<number>): OscPacket {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = decodeOscString(data, 0);

  if (header.value === '#bundle') {
    const timetag = {
      seconds: view.getUint32(header.next, false),
      fraction: view.getUint32(header.next + 4, false),
    };
    const elements: OscPacket[] = [];
    let offset = header.next + 8;
    while (offset < data.length) {
      const size = view.getInt32(offset, false);
      offset += 4;
      elements.push(decodeOscPacket(data.subarray(offset, offset + size)));
      offset += size;
    }
    return { kind: 'bundle', timetag, elements };
  }
  return decodeOscMessage(data);
}

// ---------------------------------------------------------------------------
// Timetags
// ---------------------------------------------------------------------------

/** NTP-Timetag (64-Bit) aus Date.now() [ms] – OSC-konform. */
export function ntpTimetag(dateMs = Date.now()): { seconds: number; fraction: number } {
  const unixSec = Math.floor(dateMs / 1000);
  const ms = dateMs - unixSec * 1000;
  const seconds = unixSec + Math.floor(NTP_EPOCH_MS / 1000);
  const fraction = Math.floor((ms / 1000) * 0xffffffff);
  return { seconds, fraction };
}

/** NTP-Timetag → Unix-Millisekunden. */
export function timetagToMs(seconds: number, fraction: number): number {
  const unixSec = seconds - Math.floor(NTP_EPOCH_MS / 1000);
  return unixSec * 1000 + Math.floor((fraction / 0xffffffff) * 1000);
}

/** Immediat-Timetag (OSC-Konvention: 1). */
export const OSC_IMMEDIATE = { seconds: 0, fraction: 1 };

// ---------------------------------------------------------------------------
// Control-Pfad-Helfer (App-Konvention: /control/<kind>/<id>/<value>/<channel>)
// ---------------------------------------------------------------------------

export function parseControlAddress(address: string): { kind: string; id: number; value: number; channel: number } | null {
  const m = /^\/control\/([a-zA-Z]+)\/(\d+)\/([-0-9.]+)(?:\/(\d+))?$/.exec(address);
  if (!m) return null;
  return {
    kind: m[1].toLowerCase(),
    id: Number(m[2]) || 0,
    value: Number(m[3]) || 0,
    channel: m[4] ? Math.max(1, Math.min(16, Number(m[4]))) : 1,
  };
}
