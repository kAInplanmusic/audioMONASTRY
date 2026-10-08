/**
 * audioMONASTRY · Steuer-Ringpuffer UI → Audio-Thread (RT-AUDIT-P1-010, Schritt 2)
 * ================================================================================
 * Lock-freier SPSC-Ringpuffer (ein Produzent = Main-Thread, ein Konsument =
 * AudioWorklet) im SharedArrayBuffer, Muster `ringbuf.js`: Lese-/Schreibindex
 * als Int32 mit `Atomics`, Nutzdaten in festen Datensätzen. Für häufige, kleine
 * Steuerdaten (Gain, Pan, Mute, Master-Gain, Synth-/Sample-Trigger). Vorher lief
 * jede dieser Nachrichten über `MessagePort.postMessage` – strukturiertes
 * Klonen und ein neues Objekt im Audio-Thread pro Nachricht, abhängig von der
 * Event-Loop des Worklets. Große, seltene Ladevorgänge bleiben bei postMessage.
 *
 * Speicher-Layout:
 *   state : Int32Array(STATE_LENGTH) – READ, WRITE (Datensatz-Index 0..cap-1),
 *           OVERFLOW (Zähler, Produzent), CAPACITY.
 *   data  : ein ArrayBuffer, zwei Sichten je Datensatz (RECORD_WORDS × 4 Byte):
 *           Int32 [op, channel, portSeq] + Float32 [a, b, c].
 * Ein Platz bleibt immer frei (voll ⇔ (write + 1) % cap === read).
 *
 * Reihenfolge: Produzent schreibt erst die Nutzdaten, dann `Atomics.store`
 * WRITE; Konsument liest WRITE per `Atomics.load`, dann die Nutzdaten, zuletzt
 * `Atomics.store` READ. Atomics sind sequenziell konsistent – die Nutzdaten
 * eines sichtbaren Datensatzes sind damit vollständig.
 *
 * `portSeq` ordnet Ring-Nachrichten hinter Port-Nachrichten ein: ein Datensatz
 * wird erst angewendet, wenn der Prozessor mindestens `portSeq` Port-
 * Nachrichten verarbeitet hat (z. B. Trigger erst nach dem zugehörigen
 * `sample-assign`).
 *
 * Konsum (`peek`/`advance`) ist allokationsfrei: kein Objekt, keine Closure,
 * nur Index-Arithmetik und Atomics.
 */

/** Opcodes der festen Nachrichtenformate. */
export const CONTROL_OP = {
  /** a = dB */
  GAIN_DB: 1,
  /** a = Pan −1..1 */
  PAN: 2,
  /** a = 1 stumm, 0 laut */
  MUTE: 3,
  /** a = linearer Master-Gain (channel ignoriert) */
  MASTER_GAIN: 4,
  /** a = Velocity */
  SYNTH_TRIGGER: 5,
  /** a = Rate, b = Offset (s), c = 1 Loop / 0 */
  SAMPLE_TRIGGER: 6,
} as const;

export type ControlOp = (typeof CONTROL_OP)[keyof typeof CONTROL_OP];

/** Felder im Int32-Zustand. */
export const CONTROL_STATE = { READ: 0, WRITE: 1, OVERFLOW: 2, CAPACITY: 3 } as const;
export const CONTROL_STATE_LENGTH = 4;

/** Wörter (je 4 Byte) pro Datensatz: 3 × Int32 + 3 × Float32. */
export const CONTROL_RECORD_WORDS = 6;
const W_OP = 0;
const W_CHANNEL = 1;
const W_SEQ = 2;
const W_A = 3;
const W_B = 4;
const W_C = 5;

/** Default-Kapazität (Datensätze). 4096 × 24 B = 96 KiB. */
export const CONTROL_RING_DEFAULT_CAPACITY = 4096;

/** Übertragbare Beschreibung des Rings (SharedArrayBuffer werden geteilt, nicht kopiert). */
export interface ControlRingBuffers {
  state: SharedArrayBuffer;
  data: SharedArrayBuffer;
}

/** Steht ein SharedArrayBuffer zur Verfügung? (Ohne → postMessage-Weg.) */
export function sharedMemoryAvailable(): boolean {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') return false;
  // Im Browser nur mit COOP/COEP (crossOriginIsolated) – sonst ist SAB nicht
  // an ein Worklet übertragbar.
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  return isolated === true;
}

export class ControlRing {
  readonly capacity: number;
  private readonly state: Int32Array;
  private readonly ints: Int32Array;
  private readonly floats: Float32Array;

  private constructor(readonly buffers: ControlRingBuffers) {
    this.state = new Int32Array(buffers.state);
    this.ints = new Int32Array(buffers.data);
    this.floats = new Float32Array(buffers.data);
    this.capacity = Atomics.load(this.state, CONTROL_STATE.CAPACITY);
    if (this.capacity < 2 || this.ints.length < this.capacity * CONTROL_RECORD_WORDS) {
      throw new RangeError('ControlRing: ungültige Kapazität');
    }
  }

  /** Neuen Ring anlegen (Produzent/Main-Thread). */
  static create(capacity = CONTROL_RING_DEFAULT_CAPACITY): ControlRing {
    const cap = Math.max(2, Math.floor(capacity));
    const state = new SharedArrayBuffer(CONTROL_STATE_LENGTH * 4);
    const data = new SharedArrayBuffer(cap * CONTROL_RECORD_WORDS * 4);
    const view = new Int32Array(state);
    Atomics.store(view, CONTROL_STATE.READ, 0);
    Atomics.store(view, CONTROL_STATE.WRITE, 0);
    Atomics.store(view, CONTROL_STATE.OVERFLOW, 0);
    Atomics.store(view, CONTROL_STATE.CAPACITY, cap);
    return new ControlRing({ state, data });
  }

  /** Bestehenden Ring anbinden (Konsument/Audio-Thread, einmalig im Message-Handler). */
  static attach(buffers: ControlRingBuffers): ControlRing {
    return new ControlRing(buffers);
  }

  // ------------------------------------------------------------- Produzent
  /**
   * Schreibt einen Datensatz. `false` = Ring voll; der Überlauf wird gezählt
   * und der Aufrufer muss die Nachricht anders zustellen (postMessage).
   */
  push(op: ControlOp, channel: number, portSeq: number, a = 0, b = 0, c = 0): boolean {
    const write = Atomics.load(this.state, CONTROL_STATE.WRITE);
    const read = Atomics.load(this.state, CONTROL_STATE.READ);
    const next = write + 1 === this.capacity ? 0 : write + 1;
    if (next === read) {
      Atomics.add(this.state, CONTROL_STATE.OVERFLOW, 1);
      return false;
    }
    const base = write * CONTROL_RECORD_WORDS;
    this.ints[base + W_OP] = op;
    this.ints[base + W_CHANNEL] = channel | 0;
    this.ints[base + W_SEQ] = portSeq | 0;
    this.floats[base + W_A] = a;
    this.floats[base + W_B] = b;
    this.floats[base + W_C] = c;
    Atomics.store(this.state, CONTROL_STATE.WRITE, next);
    return true;
  }

  /** Anzahl der Überläufe (Ring voll beim Schreiben) seit Anlage. */
  get overflowCount(): number {
    return Atomics.load(this.state, CONTROL_STATE.OVERFLOW);
  }

  /** Belegte Datensätze (Momentaufnahme). */
  get size(): number {
    const write = Atomics.load(this.state, CONTROL_STATE.WRITE);
    const read = Atomics.load(this.state, CONTROL_STATE.READ);
    return write >= read ? write - read : write + this.capacity - read;
  }

  // ------------------------------------------------------------- Konsument
  /**
   * Liest den ältesten Datensatz nach `out` (Länge ≥ CONTROL_RECORD_WORDS,
   * Felder als Zahlen: op, channel, portSeq, a, b, c), OHNE ihn zu entfernen.
   * `false` = leer. Allokationsfrei.
   */
  peek(out: Float64Array): boolean {
    const read = Atomics.load(this.state, CONTROL_STATE.READ);
    const write = Atomics.load(this.state, CONTROL_STATE.WRITE);
    if (read === write) return false;
    const base = read * CONTROL_RECORD_WORDS;
    out[W_OP] = this.ints[base + W_OP];
    out[W_CHANNEL] = this.ints[base + W_CHANNEL];
    out[W_SEQ] = this.ints[base + W_SEQ];
    out[W_A] = this.floats[base + W_A];
    out[W_B] = this.floats[base + W_B];
    out[W_C] = this.floats[base + W_C];
    return true;
  }

  /** Entfernt den mit `peek` gelesenen Datensatz. */
  advance(): void {
    const read = Atomics.load(this.state, CONTROL_STATE.READ);
    if (read === Atomics.load(this.state, CONTROL_STATE.WRITE)) return;
    Atomics.store(this.state, CONTROL_STATE.READ, read + 1 === this.capacity ? 0 : read + 1);
  }
}

/** Feld-Indizes im `peek`-Ausgabe-Array. */
export const CONTROL_FIELD = { OP: W_OP, CHANNEL: W_CHANNEL, SEQ: W_SEQ, A: W_A, B: W_B, C: W_C } as const;

/** Wrap-sicherer Vergleich von Port-Sequenznummern (Int32): ist `seq` schon gesehen? */
export function portSeqReached(seen: number, seq: number): boolean {
  return ((seq - seen) | 0) <= 0;
}
