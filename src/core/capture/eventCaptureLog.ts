/**
 * audioMONASTRY · Capture – Eingabe-Ringpuffer (IDEA-2026-10-07-A)
 * ================================================================
 * Hält die zuletzt gespielten Eingaben (Pad-Trigger, Instrument-Noten) bereit,
 * damit „Capture“ nachträglich ein Sequencer-Pattern vorschlagen kann.
 *
 * - Feste Kapazität (Standard 4096) mit VORALLOKIERTEN Slots: `record()` legt
 *   nichts neu an, sondern überschreibt die Felder des ältesten Slots. Damit ist
 *   der Aufruf aus Hot-Paths (Pad-Trigger, MIDI-Noten) GC-frei.
 * - Zeiten sind AudioContext-Sekunden (`ctx.currentTime`), also dieselbe Uhr wie
 *   der Audio-Abgriff.
 * - `snapshot()` (nur beim Capture-Klick) kopiert die Events der letzten
 *   `bars` Takte (4/4) chronologisch heraus; Allokation ist dort erlaubt.
 *
 * Reine Klasse, keine Plattform-APIs.
 */
import type { TrackType } from '../../types';

export type CaptureEventKind = 'trigger' | 'note-on';

export interface CaptureEvent {
  /** AudioContext-Zeit in Sekunden. */
  time: number;
  kind: CaptureEventKind;
  track: TrackType;
  /** MIDI-Notennummer; `-1` bei Pad-Triggern ohne Tonhöhe. */
  note: number;
  /** Anschlagstärke normiert auf 0..1. */
  velocity: number;
}

export const CAPTURE_LOG_CAPACITY = 4096;
/** Standard-Fenster für den Pattern-Vorschlag. */
export const CAPTURE_BARS = 16;
/** Kein Ton (Pad-Trigger). */
export const CAPTURE_NO_NOTE = -1;

/** Länge eines 4/4-Takts in Sekunden. */
export function barSeconds(bpm: number): number {
  const b = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  return (60 / b) * 4;
}

/** Frequenz (Hz) → nächste MIDI-Note (A4 = 440 Hz = 69). Ohne Allokation. */
export function freqToMidi(freq: number): number {
  if (!Number.isFinite(freq) || freq <= 0) return CAPTURE_NO_NOTE;
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

export class EventCaptureLog {
  private readonly slots: CaptureEvent[];
  private head = 0; // nächster Schreibplatz
  private count = 0;

  constructor(readonly capacity = CAPTURE_LOG_CAPACITY) {
    const cap = Math.max(1, Math.floor(capacity));
    this.slots = new Array<CaptureEvent>(cap);
    for (let i = 0; i < cap; i++) {
      this.slots[i] = { time: 0, kind: 'trigger', track: 'channel1', note: CAPTURE_NO_NOTE, velocity: 0 };
    }
  }

  /** Anzahl der aktuell gehaltenen Events (≤ Kapazität). */
  get size(): number {
    return this.count;
  }

  /** Schreibt ein Event; bei voller Kapazität wird das älteste überschrieben. */
  record(time: number, kind: CaptureEventKind, track: TrackType, note: number, velocity: number): void {
    if (!Number.isFinite(time)) return;
    const slot = this.slots[this.head];
    slot.time = time;
    slot.kind = kind;
    slot.track = track;
    slot.note = Number.isFinite(note) ? note : CAPTURE_NO_NOTE;
    slot.velocity = Number.isFinite(velocity) ? (velocity < 0 ? 0 : velocity > 1 ? 1 : velocity) : 0;
    this.head = (this.head + 1) % this.slots.length;
    if (this.count < this.slots.length) this.count++;
  }

  /** Note-On aus einer Frequenz (Instrument-Bridges arbeiten mit Hz). */
  recordNoteFreq(time: number, track: TrackType, freq: number, velocity: number): void {
    this.record(time, 'note-on', track, freqToMidi(freq), velocity);
  }

  /** Leert den Puffer (Slots bleiben vorallokiert). */
  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /**
   * Events der letzten `bars` Takte bis `nowSec` (einschließlich), chronologisch.
   * Liefert Kopien – der Aufrufer darf sie behalten.
   */
  snapshot(nowSec: number, bpm: number, bars = CAPTURE_BARS): CaptureEvent[] {
    const from = nowSec - barSeconds(bpm) * Math.max(1, bars);
    const out: CaptureEvent[] = [];
    const cap = this.slots.length;
    const oldest = (this.head - this.count + cap) % cap;
    for (let i = 0; i < this.count; i++) {
      const e = this.slots[(oldest + i) % cap];
      if (e.time >= from && e.time <= nowSec) out.push({ ...e });
    }
    // Aufzeichnungsreihenfolge ist fast immer chronologisch; stabil nachsortieren.
    out.sort((a, b) => a.time - b.time);
    return out;
  }
}
