// src/core/hardware/midiClockOut.ts
// ============================================================================
// NEW-MONK-1 · MIDI-Out/Clock-Ausgabe (Hardware)
// ----------------------------------------------------------------------------
// Reine, plattformfreie Steuerlogik für die MIDI-Ausgabe des drumMONK-
// Sequencers an externe Hardware (TR-8S, Beatstep Pro, Dirtywave M8 …):
//   * 24-PPQN-Clock (0xF8) exakt am Step-Raster der MONASTRYmasterclock
//   * Transport Start/Stop/Continue + Song Position Pointer (16th-Notes)
//   * Note-Out je Step (GM-Percussion-Mapping der DrumKit-Sound-Typen)
//
// Alle Nachrichten werden mit einem absoluten Zeitstempel (ms, gleiche
// Zeitbasis wie der Sink) an eine injizierte Senke gegeben. Dadurch übernimmt
// die Plattform-Warteschlange (Web MIDI `send(data, timestamp)`) das
// jitterarme Ausgeben – es entsteht keine zusätzliche Audio-Latenz und der
// Hot-Path bleibt frei von Timern.
//
// Bewusst OHNE direkte Plattform-APIs (Interface-Boundary-Regel): die
// MIDIOutput-Anbindung passiert im Hook `src/hooks/useMidiClockOut.ts`.
// ============================================================================

import {
  midiClock, midiStart, midiStop, midiContinue, midiSongPosition,
} from './midiCodec';

/** Ausgabe-Senke (z. B. Web-MIDI-`MIDIOutput`). */
export interface MidiOutSink {
  /** Sendet MIDI-Bytes; `timestampMs` ist absolut (gleiche Basis wie Sink). */
  send(data: number[], timestampMs?: number): void;
}

/** 7-Bit-Clamp (NaN-sicher). */
const clamp7 = (v: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(127, n));
};

/** MIDI-Clock-Auflösung: 24 Pulse pro Viertelnote (MIDI-1.0-Standard). */
export const PPQN = 24;
/** Ein 16th-Step entspricht 6 Clock-Pulsen (24 / 4). */
export const PULSES_PER_STEP = PPQN / 4;

/** GM-Percussion-Noten je DrumKit-Sound-Typ (General MIDI Kanal 10). */
export const GM_DRUM_NOTES: Record<string, number> = {
  kick: 36,   // Bass Drum 1
  snare: 38,  // Acoustic Snare
  clap: 39,   // Hand Clap
  hat: 42,    // Closed Hi-Hat
  tom: 45,    // Low Tom
  perc: 56,   // Cowbell
};

/** Sound-spezifische Abweichungen vom Typ-Mapping (klassische Kit-IDs). */
const GM_DRUM_NOTES_BY_ID: Record<string, number> = {
  ohh: 46,   // Open Hi-Hat
  chh: 42,   // Closed Hi-Hat
  ltom: 45,
  mtom: 47,
  htom: 50,
  rim: 37,   // Side Stick
  cow: 56,
  clv: 75,   // Claves
  mar: 70,   // Maracas
  cng: 64,   // Low Conga
  ride: 51,
  crash: 49,
};

/** Löst einen DrumKit-Sound (ID + Typ) auf eine GM-Percussion-Note auf. */
export function drumNoteFor(soundId: string, type?: string): number {
  const byId = GM_DRUM_NOTES_BY_ID[soundId?.toLowerCase?.() ?? ''];
  if (byId !== undefined) return byId;
  const byType = type ? GM_DRUM_NOTES[type.toLowerCase()] : undefined;
  return byType ?? GM_DRUM_NOTES.perc;
}

/** Dauer eines 16th-Steps in Millisekunden. */
export function stepDurationMs(bpm: number): number {
  const safe = Number.isFinite(bpm) ? Math.max(20, Math.min(300, bpm)) : 128;
  return 60_000 / safe / 4;
}

export interface MidiClockOutOptions {
  /** MIDI-Kanal für Note-Out (1–16, Default 10 = GM-Percussion). */
  drumChannel?: number;
  /** Note-Länge in Millisekunden (Default 20 ms). */
  noteLengthMs?: number;
}

/**
 * Sequencer-MIDI-Ausgabe: Clock + Transport + Noten.
 *
 * Ablauf im drumMONK: `setSink()` → `setEnabled(true)` → beim Transport-Start
 * `start(step, nowMs)`, an jeder Step-Kante `emitStep({...})`, beim Stop
 * `stop(nowMs)`.
 */
export class MidiClockOut {
  private sink: MidiOutSink | null = null;
  private enabled = false;
  private running = false;
  private bpm = 128;
  private readonly drumChannel: number;
  private readonly noteLengthMs: number;
  /** Zähler der gesendeten Clock-Pulse (Diagnose/Tests). */
  private pulses = 0;

  constructor(options: MidiClockOutOptions = {}) {
    this.drumChannel = Math.max(1, Math.min(16, Math.round(options.drumChannel ?? 10)));
    this.noteLengthMs = Math.max(1, Math.min(500, options.noteLengthMs ?? 20));
  }

  /** Ausgabe-Port setzen (null = kein Port; laufender Transport wird beendet). */
  public setSink(sink: MidiOutSink | null): void {
    if (this.running && this.sink && sink !== this.sink) this.stop();
    this.sink = sink;
  }

  public hasSink(): boolean {
    return this.sink !== null;
  }

  /** Master-Schalter im UI („MIDI OUT"); beim Ausschalten wird gestoppt. */
  public setEnabled(enabled: boolean): void {
    if (!enabled && this.running) this.stop();
    this.enabled = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getPulseCount(): number {
    return this.pulses;
  }

  public setBpm(bpm: number): void {
    this.bpm = Number.isFinite(bpm) ? Math.max(20, Math.min(300, bpm)) : 128;
  }

  /**
   * Transport-Start: Song Position Pointer + Start (Step 0) bzw. Continue
   * (Wiederaufnahme mitten im Pattern).
   */
  public start(step = 0, timestampMs?: number): void {
    if (!this.canSend() || this.running) return;
    const position = Math.max(0, Math.round(step));
    this.send(midiSongPosition(position), timestampMs);
    this.send(position === 0 ? midiStart() : midiContinue(), timestampMs);
    this.running = true;
  }

  /** Transport-Stop (idempotent). */
  public stop(timestampMs?: number): void {
    if (!this.sink || !this.running) {
      this.running = false;
      return;
    }
    this.send(midiStop(), timestampMs);
    this.running = false;
  }

  /**
   * Step-Kante: 6 Clock-Pulse für die Dauer dieses Steps vorplanen und die
   * aktiven Noten des Steps ausgeben.
   *
   * @returns Anzahl der gesendeten Clock-Pulse (0, wenn deaktiviert).
   */
  public emitStep(params: {
    /** Notennummern, die auf diesem Step klingen sollen. */
    notes?: Array<{ note: number; velocity?: number }>;
    /** Absoluter Zeitstempel der Step-Kante (ms, Sink-Zeitbasis). */
    timestampMs?: number;
    /** BPM des laufenden Transports (optional, sonst letzter Wert). */
    bpm?: number;
  } = {}): number {
    if (!this.canSend() || !this.running) return 0;
    if (params.bpm !== undefined) this.setBpm(params.bpm);

    const stepMs = stepDurationMs(this.bpm);
    const pulseMs = stepMs / PULSES_PER_STEP;
    const base = params.timestampMs;
    for (let p = 0; p < PULSES_PER_STEP; p++) {
      this.send(midiClock(), base === undefined ? undefined : base + p * pulseMs);
      this.pulses++;
    }

    for (const n of params.notes ?? []) {
      this.sendNote(n.note, n.velocity ?? 1, base);
    }
    return PULSES_PER_STEP;
  }

  /** Einzelne Drum-Note (Note-On + Note-Off nach `noteLengthMs`). */
  public sendNote(note: number, velocity01 = 1, timestampMs?: number): void {
    if (!this.canSend()) return;
    const ch = (this.drumChannel - 1) & 0x0f;
    const n = clamp7(note);
    const v = Math.max(1, clamp7(velocity01 * 127));
    this.send([0x90 | ch, n, v], timestampMs);
    this.send([0x80 | ch, n, 0], timestampMs === undefined ? undefined : timestampMs + this.noteLengthMs);
  }

  /** All-Notes-Off/All-Sound-Off auf dem Drum-Kanal (Panik-Taste). */
  public allNotesOff(timestampMs?: number): void {
    if (!this.sink) return;
    const ch = (this.drumChannel - 1) & 0x0f;
    this.send([0xb0 | ch, 123, 0], timestampMs); // All Notes Off
    this.send([0xb0 | ch, 120, 0], timestampMs); // All Sound Off
  }

  private canSend(): boolean {
    return this.enabled && this.sink !== null;
  }

  private send(data: number[], timestampMs?: number): void {
    if (!this.sink) return;
    try {
      this.sink.send(data, timestampMs);
    } catch {
      /* Port kann jederzeit verschwinden (Hotplug) – nie den Sequencer stören. */
    }
  }
}
