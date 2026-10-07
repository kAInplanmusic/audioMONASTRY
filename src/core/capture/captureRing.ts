/**
 * audioMONASTRY · Capture – Audio-Ringpuffer (IDEA-2026-10-07-A)
 * ==============================================================
 * Gemeinsame Logik für den Audio-Abgriff (`captureTapProcessor`, Audio-Thread)
 * und das Auslesen beim Capture-Klick (Main-Thread). Ohne Worklet-Globals und
 * ohne Plattform-APIs, damit beides direkt testbar ist.
 *
 * Speicher-Layout (SharedArrayBuffer):
 *   data   : Float32 planar – [0, cap) = links, [cap, 2·cap) = rechts
 *   header : Int32Array der Länge CAPTURE_HEADER_LENGTH, Felder siehe
 *            `CAPTURE_HEADER` (alle Zugriffe über `Atomics`).
 *
 * Schreibreihenfolge im Audio-Thread: erst Samples, dann Gesamtzähler, zuletzt
 * Schreibindex (`Atomics.store`). Der Leser lädt den Schreibindex zuerst.
 */

/** Feld-Indizes im Int32-Header. */
export const CAPTURE_HEADER = {
  /** Nächster Schreibplatz (Frames, 0..cap-1). */
  WRITE_FRAME: 0,
  /** Gesamt geschriebene Frames, untere 32 Bit (vorzeichenlos gelesen). */
  TOTAL_LOW: 1,
  /** Gesamt geschriebene Frames, obere Bits. */
  TOTAL_HIGH: 2,
  /** Abtastrate des AudioContext. */
  SAMPLE_RATE: 3,
  /** Kanäle im Ring (immer 2). */
  CHANNELS: 4,
  /** Kapazität in Frames je Kanal. */
  CAPACITY: 5,
} as const;

export const CAPTURE_HEADER_LENGTH = 8;
export const CAPTURE_CHANNELS = 2;

const TWO_POW_32 = 4294967296;

/** Header initialisieren (Main-Thread, einmalig). */
export function initCaptureHeader(header: Int32Array, capacityFrames: number, sampleRate: number): void {
  Atomics.store(header, CAPTURE_HEADER.WRITE_FRAME, 0);
  Atomics.store(header, CAPTURE_HEADER.TOTAL_LOW, 0);
  Atomics.store(header, CAPTURE_HEADER.TOTAL_HIGH, 0);
  Atomics.store(header, CAPTURE_HEADER.SAMPLE_RATE, Math.round(sampleRate));
  Atomics.store(header, CAPTURE_HEADER.CHANNELS, CAPTURE_CHANNELS);
  Atomics.store(header, CAPTURE_HEADER.CAPACITY, capacityFrames);
}

/** Gesamt geschriebene Frames (bis 2^53 exakt). */
export function captureTotalFrames(header: Int32Array): number {
  const low = Atomics.load(header, CAPTURE_HEADER.TOTAL_LOW) >>> 0;
  const high = Atomics.load(header, CAPTURE_HEADER.TOTAL_HIGH) >>> 0;
  return high * TWO_POW_32 + low;
}

/**
 * Schreibt einen Block in den Ring (Audio-Thread, pro Render-Quantum).
 * KEINE Allokation: nur Index-Schleifen und `Atomics`.
 * `inL === null` → Stille (Zeitachse läuft weiter); `inR === null` → Mono, L auf beide.
 */
export function writeCaptureBlock(
  ringL: Float32Array,
  ringR: Float32Array,
  header: Int32Array,
  inL: Float32Array | null,
  inR: Float32Array | null,
  frames: number,
): void {
  const cap = ringL.length;
  if (cap === 0 || frames <= 0) return;
  const src = inR ?? inL;
  let w = Atomics.load(header, CAPTURE_HEADER.WRITE_FRAME);
  if (w < 0 || w >= cap) w = 0;
  for (let i = 0; i < frames; i++) {
    ringL[w] = inL ? inL[i] : 0;
    ringR[w] = src ? src[i] : 0;
    w++;
    if (w === cap) w = 0;
  }
  let low = (Atomics.load(header, CAPTURE_HEADER.TOTAL_LOW) >>> 0) + frames;
  if (low >= TWO_POW_32) {
    low -= TWO_POW_32;
    Atomics.add(header, CAPTURE_HEADER.TOTAL_HIGH, 1);
  }
  Atomics.store(header, CAPTURE_HEADER.TOTAL_LOW, low | 0);
  Atomics.store(header, CAPTURE_HEADER.WRITE_FRAME, w);
}

/**
 * Liest die letzten `seconds` chronologisch geordnet aus (Main-Thread).
 * Wurde weniger geschrieben, kommen nur die geschriebenen Frames zurück.
 */
export function readCaptureRing(
  ringL: Float32Array,
  ringR: Float32Array,
  header: Int32Array,
  seconds: number,
  sampleRate: number,
): [Float32Array, Float32Array] {
  const cap = ringL.length;
  const w = Atomics.load(header, CAPTURE_HEADER.WRITE_FRAME);
  const total = captureTotalFrames(header);
  const wanted = Math.max(0, Math.floor(seconds * sampleRate));
  const n = Math.min(wanted, total, cap);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  if (n === 0) return [left, right];
  const start = (((w - n) % cap) + cap) % cap;
  const first = Math.min(n, cap - start);
  left.set(ringL.subarray(start, start + first), 0);
  right.set(ringR.subarray(start, start + first), 0);
  if (first < n) {
    left.set(ringL.subarray(0, n - first), first);
    right.set(ringR.subarray(0, n - first), first);
  }
  return [left, right];
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Erster Frame, in dem ein Kanal die Schwelle erreicht (sonst Länge). */
function firstAudibleFrame(channels: readonly Float32Array[], threshold: number): number {
  const len = channels.reduce((m, c) => Math.max(m, c.length), 0);
  for (let i = 0; i < len; i++) {
    for (const c of channels) if (i < c.length && Math.abs(c[i]) >= threshold) return i;
  }
  return len;
}

/** Schneidet führende Stille (alle Kanäle unter `thresholdDb` dBFS) ab. */
export function trimLeadingSilence(channels: readonly Float32Array[], thresholdDb = -60): Float32Array[] {
  const idx = firstAudibleFrame(channels, dbToLinear(thresholdDb));
  return channels.map((c) => c.slice(Math.min(idx, c.length)));
}

/** Schneidet nachlaufende Stille ab (z. B. nach Transport-Stopp). */
export function trimTrailingSilence(channels: readonly Float32Array[], thresholdDb = -60): Float32Array[] {
  const threshold = dbToLinear(thresholdDb);
  const len = channels.reduce((m, c) => Math.max(m, c.length), 0);
  let end = 0;
  for (let i = len - 1; i >= 0 && end === 0; i--) {
    for (const c of channels) if (i < c.length && Math.abs(c[i]) >= threshold) { end = i + 1; break; }
  }
  return channels.map((c) => c.slice(0, Math.min(end, c.length)));
}
