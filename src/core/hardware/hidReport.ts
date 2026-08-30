/**
 * audioMONASTRY · HID-Report-Parser (plattformneutral)
 * =====================================================
 * Parst HID-Report-Descriptoren (USB HID 1.11, Device Class Definition)
 * und extrahiert Werte aus Input-Reports. Damit werden generische
 * HID-Geräte (Fader, Encoder, Buttons, Wheels) OHNE Vendor-Byte-Raten
 * erkennbar – über Usage Page/Usage, Logical Min/Max und Report-Struktur.
 *
 * Der Browser (WebHID) liefert den Descriptor nicht roh aus, sondern als
 * `device.collections` (bereits geparste Items). Dieser Parser dient:
 *  - nativem HID (hidraw/node-hid/hidapi) als Descriptor-Decoder,
 *  - Tests/Mock-Geräten mit Roh-Descriptor,
 *  - als Referenz für die Collection→Feld-Konvertierung im WebHIDAdapter.
 */

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export type HidReportType = 'input' | 'output' | 'feature';

export interface HidReportField {
  reportId: number;
  reportType: HidReportType;
  /** Usage Page (z. B. 0x09 = Button, 0x01 = Generic Desktop). */
  usagePage: number;
  /** Usage (X/Y/Z/Rx/Ry/Rz/Slider/Dial/Wheel …). */
  usage: number;
  /** Bit-Offset im Report (ohne Report-ID-Byte). */
  bitOffset: number;
  /** Feldbreite in Bits. */
  bitSize: number;
  logicalMin: number;
  logicalMax: number;
  /** true = relativer Encoder/Jog, false = absoluter Fader/Button. */
  isRelative: boolean;
  /** true = Array-Feld (Button-Array), false = Variable. */
  isArray: boolean;
}

export interface HidReportDescriptor {
  fields: HidReportField[];
  /** Usage Pages, die im Descriptor vorkommen (Diagnose). */
  usagePages: number[];
  /** Usages, die im Descriptor vorkommen (Diagnose). */
  usages: number[];
}

export interface HidReportValue {
  field: HidReportField;
  /** Rohwert (Logical-Bereich, vorzeichenrichtig). */
  raw: number;
  /** Auf 0..1 normierter Wert (für Absolutfelder). */
  normalized01: number;
}

// ---------------------------------------------------------------------------
// Descriptor-Parser
// ---------------------------------------------------------------------------

const clampI32 = (v: number): number => Math.max(-2147483648, Math.min(2147483647, Math.round(v)));

/** Liest ein n-Byte-Little-Endian-Item (vorzeichenlos). */
function readItemValue(bytes: Uint8Array, offset: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v |= (bytes[offset + i] ?? 0) << (8 * i);
  return v >>> 0;
}

/** Vorzeichenbehaftete Interpretation (für Logical Min/Max). */
function signed(value: number, size: number): number {
  if (size === 0) return 0;
  const signBit = 1 << (size * 8 - 1);
  return value & signBit ? value - (1 << (size * 8)) : value;
}

/**
 * Parst einen HID-Report-Descriptor in Feld-Definitionen.
 * Unbekannte Items werden übersprungen (robust gegen Vendor-Extensions).
 */
export function parseHidReportDescriptor(descriptor: ArrayLike<number>): HidReportDescriptor {
  const bytes = descriptor instanceof Uint8Array
    ? descriptor
    : Uint8Array.from(descriptor);

  const fields: HidReportField[] = [];
  const usagePages = new Set<number>();
  const usages = new Set<number>();

  // Globaler Zustand
  let usagePage = 0;
  let logicalMin = 0;
  let logicalMax = 0;
  let reportSize = 0;
  let reportId = 0;
  let reportCount = 0;
  let bitOffset = 0;

  // Lokaler Zustand
  let localUsages: number[] = [];
  let localUsageMin = 0;
  let localUsageMax = 0;
  let hasUsageRange = false;

  const pushFields = (reportType: HidReportType, flags: number): void => {
    const isRelative = (flags & 0x04) !== 0;
    const isVariable = (flags & 0x02) !== 0;
    const count = Math.max(1, reportCount);
    const size = Math.max(1, reportSize);

    if (!isVariable) {
      // Array-Feld: Usage-Bereich (z. B. Button 1..8), ein Feld pro Bit.
      const usageMin = hasUsageRange ? localUsageMin : (localUsages[0] ?? 0);
      const usageMax = hasUsageRange ? localUsageMax : (localUsages[localUsages.length - 1] ?? usageMin);
      for (let i = 0; i < count; i++) {
        const usage = usageMin + i <= usageMax ? usageMin + i : usageMin;
        usages.add(usage);
        fields.push({
          reportId, reportType, usagePage, usage,
          bitOffset: bitOffset + i * size, bitSize: size,
          logicalMin, logicalMax, isRelative, isArray: true,
        });
      }
    } else {
      for (let i = 0; i < count; i++) {
        // Variable Felder: Usage-Liste ODER Usage-Min/Max-Bereich.
        const usage = hasUsageRange
          ? Math.min(localUsageMax, localUsageMin + i)
          : (localUsages[i] ?? localUsages[0] ?? 0);
        usages.add(usage);
        fields.push({
          reportId, reportType, usagePage, usage,
          bitOffset: bitOffset + i * size, bitSize: size,
          logicalMin, logicalMax, isRelative, isArray: false,
        });
      }
    }
    bitOffset += count * size;
  };

  let i = 0;
  while (i < bytes.length) {
    const prefix = bytes[i] ?? 0;
    i++;

    // Long Item: Prefix = 0xFE (Size=2, Type=3, Tag=15)
    if (prefix === 0xfe) {
      const dataSize = bytes[i] ?? 0;
      const longTag = bytes[i + 1] ?? 0;
      i += 2 + dataSize;
      if (longTag === 0) void 0; // Vendor-defined – bewusst ignoriert
      continue;
    }

    const size = prefix & 0x03;
    const itemSize = size === 3 ? 4 : size;
    const type = (prefix >> 2) & 0x03;
    const tag = (prefix >> 4) & 0x0f;

    const raw = readItemValue(bytes, i, itemSize);
    i += itemSize;

    switch (type) {
      case 0: { // Main (Input 0x8, Output 0x9, Feature 0xB, Collection 0xA, End 0xC)
        if (tag === 0x08 || tag === 0x09 || tag === 0x0b) {
          const reportType: HidReportType = tag === 0x08 ? 'input' : tag === 0x09 ? 'output' : 'feature';
          pushFields(reportType, raw);
          // Lokalen Zustand nach Main-Item zurücksetzen.
          localUsages = [];
          hasUsageRange = false;
        }
        // Collection (0x0A) / End Collection (0x0C): kein Feld-Effekt hier.
        break;
      }
      case 1: { // Global
        switch (tag) {
          case 0x00: usagePage = raw & 0xffff; usagePages.add(usagePage); break;
          case 0x01: logicalMin = signed(raw, itemSize); break;
          case 0x02: logicalMax = signed(raw, itemSize); break;
          case 0x07: reportSize = clampI32(raw); break;
          case 0x08: reportId = raw & 0xff; break;
          case 0x09: reportCount = clampI32(raw); break;
          default: break; // Physical/Unit/Push/Pop – für Extraktion nicht nötig
        }
        break;
      }
      case 2: { // Local
        switch (tag) {
          case 0x00: localUsages.push(raw & 0xffff); break;
          case 0x01: localUsageMin = raw & 0xffff; hasUsageRange = true; break;
          case 0x02: localUsageMax = raw & 0xffff; hasUsageRange = true; break;
          default: break;
        }
        break;
      }
      default:
        break;
    }
  }

  return { fields, usagePages: [...usagePages].sort((a, b) => a - b), usages: [...usages].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// Report-Extraktion
// ---------------------------------------------------------------------------

/** Extrahiert alle Feldwerte aus einem Input-Report. */
export function extractHidReportValues(report: ArrayLike<number>, descriptor: HidReportDescriptor): HidReportValue[] {
  const data = report instanceof Uint8Array ? report : Uint8Array.from(report);
  const out: HidReportValue[] = [];

  for (const field of descriptor.fields) {
    if (field.reportType !== 'input') continue;
    if (field.reportId !== 0 && data[0] !== field.reportId) continue;

    const dataOffset = field.reportId !== 0 ? 1 : 0;
    let raw = 0;
    for (let bit = 0; bit < field.bitSize; bit++) {
      const absBit = field.bitOffset + bit;
      const byteIndex = dataOffset + Math.floor(absBit / 8);
      const b = data[byteIndex] ?? 0;
      if ((b >> (absBit % 8)) & 0x01) raw |= 1 << bit;
    }
    // Vorzeichenbehaftete Werte (z. B. relative Encoder: -1/0/+1).
    if (field.logicalMin < 0 && (raw & (1 << (field.bitSize - 1)))) {
      raw -= 1 << field.bitSize;
    }

    const span = field.logicalMax - field.logicalMin;
    const normalized01 = span > 0
      ? Math.max(0, Math.min(1, (raw - field.logicalMin) / span))
      : 0;

    out.push({ field, raw, normalized01 });
  }
  return out;
}

/** Zentriert einen relativen HID-Wert (logicalMin..logicalMax → -1..1). */
export function normalizeRelative(raw: number, field: HidReportField): number {
  if (field.isRelative) return Math.max(-1, Math.min(1, raw));
  const span = field.logicalMax - field.logicalMin;
  if (span <= 0) return 0;
  return Math.max(-1, Math.min(1, ((raw - field.logicalMin) / span) * 2 - 1));
}

// ---------------------------------------------------------------------------
// Output-/Feature-Report-Encoding (LED-/Motor-Fader-Rückkanal)
// ---------------------------------------------------------------------------

export interface HidOutputValue {
  usagePage: number;
  usage: number;
  /** Rohwert im Logical-Bereich des Feldes. */
  raw: number;
}

/**
 * Kodiert Werte in einen Output-/Feature-Report.
 *
 * @param fields     Feld-Definitionen des Descriptors
 * @param reportType 'output' oder 'feature'
 * @param reportId   Report-ID (0 = kein ID-Byte)
 * @param values     Zu setzende Felder (Usage Page + Usage + Rohwert)
 */
export function encodeHidOutputReport(
  fields: HidReportField[],
  reportType: HidReportType,
  reportId: number,
  values: HidOutputValue[],
): Uint8Array {
  const relevant = fields.filter((f) => f.reportType === reportType && f.reportId === reportId);
  if (relevant.length === 0) return new Uint8Array(0);

  // Ohne mindestens einen Wert, der zu einem Feld passt, keinen Report senden.
  const matched = values.some((v) => relevant.some((f) => f.usagePage === v.usagePage && f.usage === v.usage));
  if (!matched) return new Uint8Array(0);

  const dataOffset = reportId !== 0 ? 1 : 0;
  let byteLength = dataOffset;
  for (const f of relevant) {
    byteLength = Math.max(byteLength, dataOffset + Math.ceil((f.bitOffset + f.bitSize) / 8));
  }

  const out = new Uint8Array(byteLength);
  if (reportId !== 0) out[0] = reportId & 0xff;

  for (const value of values) {
    for (const f of relevant) {
      if (f.usagePage !== value.usagePage || f.usage !== value.usage) continue;
      const span = f.logicalMax - f.logicalMin;
      let raw = value.raw;
      if (span > 0) raw = Math.max(f.logicalMin, Math.min(f.logicalMax, raw));

      for (let bit = 0; bit < f.bitSize; bit++) {
        const absBit = f.bitOffset + bit;
        const byteIndex = dataOffset + Math.floor(absBit / 8);
        if (raw & (1 << bit)) out[byteIndex] |= 1 << (absBit % 8);
        else out[byteIndex] &= ~(1 << (absBit % 8));
      }
    }
  }
  return out;
}
