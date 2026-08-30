import { describe, expect, it } from 'vitest';
import {
  parseHidReportDescriptor, extractHidReportValues, normalizeRelative,
  encodeHidOutputReport,
} from '../src/core/hardware/hidReport';

/** Generic-Desktop-Joystick: X/Y (16-Bit, absolut) + 8 Buttons (1-Bit). */
const JOYSTICK_DESCRIPTOR = [
  0x05, 0x01,       // Usage Page: Generic Desktop
  0x09, 0x30,       // Usage: X
  0x09, 0x31,       // Usage: Y
  0x15, 0x00,       // Logical Min: 0
  0x26, 0xff, 0x03, // Logical Max: 1023 (2 Byte)
  0x75, 0x10,       // Report Size: 16
  0x95, 0x02,       // Report Count: 2
  0x81, 0x02,       // Input: Data, Variable, Absolute
  0x05, 0x09,       // Usage Page: Button
  0x19, 0x01,       // Usage Min: 1
  0x29, 0x08,       // Usage Max: 8
  0x15, 0x00,       // Logical Min: 0
  0x25, 0x01,       // Logical Max: 1
  0x75, 0x01,       // Report Size: 1
  0x95, 0x08,       // Report Count: 8
  0x81, 0x02,       // Input: Data, Variable, Absolute
];

/** Relativer Encoder (Dial): -1..+1, 8-Bit, relative. */
const RELATIVE_DIAL_DESCRIPTOR = [
  0x05, 0x01,       // Usage Page: Generic Desktop
  0x09, 0x37,       // Usage: Dial
  0x15, 0x81,       // Logical Min: -127
  0x25, 0x7f,       // Logical Max: 127
  0x75, 0x08,       // Report Size: 8
  0x95, 0x01,       // Report Count: 1
  0x81, 0x06,       // Input: Data, Variable, Relative
];

describe('HID-Report-Descriptor-Parser', () => {
  it('parst Usage Page, Logical Min/Max und Feldstruktur', () => {
    const desc = parseHidReportDescriptor(JOYSTICK_DESCRIPTOR);
    expect(desc.usagePages).toEqual([0x01, 0x09]);
    expect(desc.fields).toHaveLength(10); // X, Y + 8 Buttons

    const x = desc.fields[0];
    expect(x.usage).toBe(0x30);
    expect(x.bitSize).toBe(16);
    expect(x.logicalMin).toBe(0);
    expect(x.logicalMax).toBe(1023);
    expect(x.isRelative).toBe(false);
  });

  it('erkennt relative Felder (Encoder/Jog)', () => {
    const desc = parseHidReportDescriptor(RELATIVE_DIAL_DESCRIPTOR);
    expect(desc.fields).toHaveLength(1);
    expect(desc.fields[0].isRelative).toBe(true);
    expect(desc.fields[0].logicalMin).toBe(-127);
    expect(desc.fields[0].logicalMax).toBe(127);
  });

  it('überspringt unbekannte Items ohne Absturz', () => {
    const desc = parseHidReportDescriptor([0x06, 0x00, 0xff, 0x85, 0x07, 0x09, 0x01, 0x75, 0x08, 0x95, 0x01, 0x81, 0x02]);
    expect(desc.fields).toHaveLength(1);
    expect(desc.fields[0].reportId).toBe(7);
  });
});

describe('HID-Input-Report-Extraktion', () => {
  it('extrahiert X/Y und Buttons korrekt (Little-Endian)', () => {
    const desc = parseHidReportDescriptor(JOYSTICK_DESCRIPTOR);
    const report = [0x00, 0x01, 0xff, 0x03, 0b01010101];
    const values = extractHidReportValues(report, desc);
    expect(values).toHaveLength(10);

    const x = values.find((v) => v.field.usage === 0x30);
    expect(x?.raw).toBe(256);
    expect(x?.normalized01).toBeCloseTo(256 / 1023);

    const y = values.find((v) => v.field.usage === 0x31);
    expect(y?.raw).toBe(1023);
    expect(y?.normalized01).toBe(1);

    const pressed = values.filter((v) => v.field.usagePage === 0x09 && v.raw === 1);
    expect(pressed.map((v) => v.field.usage)).toEqual([1, 3, 5, 7]);
  });

  it('dekodiert negative relative Encoder-Werte', () => {
    const desc = parseHidReportDescriptor(RELATIVE_DIAL_DESCRIPTOR);
    const values = extractHidReportValues([0xff], desc); // -1 (8-Bit signed)
    expect(values[0].raw).toBe(-1);
    expect(normalizeRelative(values[0].raw, values[0].field)).toBe(-1);

    const plus = extractHidReportValues([0x01], desc);
    expect(plus[0].raw).toBe(1);
  });

  it('respektiert Report-IDs', () => {
    const desc = parseHidReportDescriptor([0x85, 0x03, 0x05, 0x01, 0x09, 0x30, 0x15, 0x00, 0x25, 0xff, 0x75, 0x08, 0x95, 0x01, 0x81, 0x02]);
    expect(extractHidReportValues([0x03, 0x7f], desc)).toHaveLength(1);
    expect(extractHidReportValues([0x04, 0x7f], desc)).toHaveLength(0);
  });
});

describe('HID-Output-Report-Encoding (LED-Rückkanal)', () => {
  /** Zwei LEDs: Usage Page 0x08 (LED), Usage 0x01/0x02, 1 Bit. */
  const LED_DESCRIPTOR = [
    0x05, 0x08, 0x09, 0x01, 0x09, 0x02, // Usage Page LED, Usage 1, Usage 2
    0x15, 0x00, 0x25, 0x01,             // Logical 0..1
    0x75, 0x01, 0x95, 0x02,             // 2 × 1 Bit
    0x91, 0x02,                         // Output: Data, Variable, Absolute
  ];

  it('setzt LED-Bits korrekt (Bit-Offset/Report-ID)', () => {
    const desc = parseHidReportDescriptor(LED_DESCRIPTOR);
    const out = encodeHidOutputReport(desc.fields, 'output', 0, [
      { usagePage: 0x08, usage: 0x01, raw: 1 },
    ]);
    expect(Array.from(out)).toEqual([0b00000001]);
    const out2 = encodeHidOutputReport(desc.fields, 'output', 0, [
      { usagePage: 0x08, usage: 0x02, raw: 1 },
    ]);
    expect(Array.from(out2)).toEqual([0b00000010]);
  });

  it('liefert leeres Array ohne passende Felder (kein Fake)', () => {
    const desc = parseHidReportDescriptor(LED_DESCRIPTOR);
    const out = encodeHidOutputReport(desc.fields, 'output', 0, [
      { usagePage: 0x09, usage: 0x01, raw: 1 },
    ]);
    expect(out).toHaveLength(0);
  });

  it('berücksichtigt Report-ID-Byte', () => {
    const desc = parseHidReportDescriptor([
      0x85, 0x07, 0x05, 0x08, 0x09, 0x01, 0x15, 0x00, 0x25, 0xff, 0x75, 0x08, 0x95, 0x01, 0x91, 0x02,
    ]);
    const out = encodeHidOutputReport(desc.fields, 'output', 7, [
      { usagePage: 0x08, usage: 0x01, raw: 0xff },
    ]);
    expect(Array.from(out)).toEqual([0x07, 0xff]);
  });
});
