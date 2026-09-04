import { describe, expect, it } from 'vitest';
import { decodeOscPacket } from '../src/core/hardware/oscCodec';
import { parseHidReportDescriptor, extractHidReportValues } from '../src/core/hardware/hidReport';

describe('Malformed-Chunk-Injection (AM-E5-5)', () => {
  it('OSC: abgeschnittenes Double-Paket wirft kontrollierten Error statt RangeError', () => {
    // Address '/x', Type-Tag ',d', aber nur 2 Payload-Bytes.
    const bytes = new Uint8Array([47, 120, 0, 0, 44, 100, 0, 0, 0, 1]);
    expect(() => decodeOscPacket(bytes)).toThrow(/abgeschnitten/);
  });

  it('OSC: negative Blob-Länge wird abgefangen', () => {
    const bytes = new Uint8Array([47, 120, 0, 0, 44, 98, 0, 0, 255, 255, 255, 255]);
    expect(() => decodeOscPacket(bytes)).toThrow(/Blob-Länge ungültig|abgeschnitten/);
  });

  it('HID: 32-Bit-Feld liefert keinen negativen Rohwert', () => {
    const descriptor = parseHidReportDescriptor(new Uint8Array([
      0x05, 0x01,       // Usage Page (Generic Desktop)
      0x09, 0x30,       // Usage (X)
      0x15, 0x00,       // Logical Min 0
      0x27, 0xff, 0xff, 0xff, 0x7f, // Logical Max 2147483647
      0x75, 0x20,       // Report Size 32
      0x95, 0x01,       // Report Count 1
      0x81, 0x02,       // Input (Data,Var,Abs)
    ]));
    const field = descriptor.fields[0];
    expect(field.bitSize).toBe(32);
    // 0x7FFFFFFF als Rohwert (Little-Endian über 4 Bytes).
    const report = new Uint8Array([0xff, 0xff, 0xff, 0x7f]);
    const values = extractHidReportValues(report, descriptor);
    expect(values[0].raw).toBe(2147483647);
  });
});
