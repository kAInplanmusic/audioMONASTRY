/**
 * audioMONASTRY · 5.1.4 – Ambisonics (1st/2nd Order Encoder/Decoder)
 * ==================================================================
 * Objekt-basiert → Ambisonics (ACN/SN3D) und zurück. Produktionsreifer
 * Encoder für bis zu 2nd-Order (9 Kanäle) plus einfacher Decoder.
 */
export interface AmbisonicFrame {
  order: 1 | 2;
  channels: Float32Array[]; // ACN-Reihenfolge
}

const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);
const SQRT15 = Math.sqrt(15);
const SQRT5 = Math.sqrt(5);

/** Encodiert eine Mono-Quelle (x,y im -1..1 Ring) nach Ambisonics. */
export function encodeAmbisonics(
  mono: Float32Array,
  x: number,
  y: number,
  order: 1 | 2 = 1,
): AmbisonicFrame {
  const az = Math.atan2(x, y); // azimuth
  const el = 0;
  const cosA = Math.cos(az);
  const sinA = Math.sin(az);

  const ch0 = new Float32Array(mono.length); // W
  const ch1 = new Float32Array(mono.length); // Y
  const ch2 = new Float32Array(mono.length); // Z
  const ch3 = new Float32Array(mono.length); // X
  for (let i = 0; i < mono.length; i++) {
    ch0[i] = mono[i] / SQRT2;
    ch1[i] = mono[i] * sinA;
    ch2[i] = mono[i] * Math.sin(el);
    ch3[i] = mono[i] * cosA;
  }

  if (order === 1) return { order: 1, channels: [ch0, ch1, ch2, ch3] };

  // 2nd Order (ACN 4..8, SN3D)
  const ch4 = new Float32Array(mono.length); // V
  const ch5 = new Float32Array(mono.length); // T
  const ch6 = new Float32Array(mono.length); // R
  const ch7 = new Float32Array(mono.length); // S
  const ch8 = new Float32Array(mono.length); // U
  const cos2A = Math.cos(2 * az);
  const sin2A = Math.sin(2 * az);
  for (let i = 0; i < mono.length; i++) {
    const m = mono[i];
    ch4[i] = m * SQRT3 * Math.sin(el) * Math.cos(el) * sinA;      // V
    ch5[i] = m * SQRT3 * Math.sin(el) * Math.cos(el) * cosA;      // T
    ch6[i] = m * 0.5 * SQRT15 * Math.cos(el) ** 2 * sin2A;        // R
    ch7[i] = m * 0.5 * SQRT15 * Math.cos(el) ** 2 * cos2A;        // S
    ch8[i] = m * 0.5 * SQRT5 * (3 * Math.sin(el) ** 2 - 1);       // U
  }
  return { order: 2, channels: [ch0, ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8] };
}

/** Einfacher 2nd-Order-Decoder auf ein N-Kanal-Lautsprecher-Ring. */
export function decodeAmbisonicsToRing(
  frame: AmbisonicFrame,
  speakerAnglesRad: number[],
): Float32Array[] {
  const len = frame.channels[0]?.length ?? 0;
  const out = speakerAnglesRad.map(() => new Float32Array(len));
  for (let s = 0; s < speakerAnglesRad.length; s++) {
    const a = speakerAnglesRad[s];
    const w = frame.channels[0];
    const y = frame.channels[1];
    const x = frame.channels[3];
    for (let i = 0; i < len; i++) {
      let v = (w[i] / SQRT2) + y[i] * Math.sin(a) + x[i] * Math.cos(a);
      if (frame.order === 2 && frame.channels.length >= 9) {
        v += frame.channels[6][i] * Math.sin(2 * a) + frame.channels[7][i] * Math.cos(2 * a);
      }
      out[s][i] = v;
    }
  }
  return out;
}
