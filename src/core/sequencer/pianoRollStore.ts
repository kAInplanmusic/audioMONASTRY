/**
 * audioMONASTRY · Piano-Roll-Note-Store (ZUK-001)
 * =============================================
 * Reine Noten-Modell-Schicht für die Piano-Roll-Ansicht: Noten pro Spur
 * (pitch 0–127, startTicks/lengthTicks bei 960 Ticks/Quarter, velocity 1–127,
 * selection). Kein Audio, kein DOM, kein localStorage – reine
 * Geschäftslogik, damit Tests & Komponenten deterministisch bleiben.
 *
 * WICHTIG: Das ist ein NEUER Noten-Store (kein existierender Shared-Store).
 * Der Engine-Sequencer (`src/audio/sequencerState.ts`) speichert NUR boolesche
 * 16/32-Step-Patterns OHNE Pitch/Länge/Velocity. Eine Piano-Roll-Bindung an
 * diesen Store ginge nur verlustbehaftet (Schritte→Noten ohne Tonhöhe). Daher
 * dieser eigene Store, der über den bestehenden Plugin-Settings-Mechanismus
 * (`src/utils/pluginSettings.ts`) persistiert wird.
 */
import { ALL_TRACKS } from '../../types';
import {
  type PianoRollNote,
  MAX_PITCH,
  MIN_VELOCITY,
  MAX_VELOCITY,
  TICKS_PER_QUARTER,
} from './pianoRollModel';

/** Serialisierbares Settings-Objekt für Plugin-Settings. */
export interface PianoRollStoreSettings {
  /** Versions-Marke für zukünftige Migrationen. */
  version: 1;
  /** Noten pro Spur (Kanal-ID → Noten-Array). */
  tracks: Record<string, PianoRollNote[]>;
}

/** Stabiler Snapshot für useSyncExternalStore. */
export interface PianoRollStoreSnapshot {
  /** Monoton steigende Revisionszahl – ändert sich nur bei echter Änderung. */
  readonly revision: number;
  /** Unveränderliche Map Spur → Noten (readonly, Referenz stabil solange Revision gleich). */
  readonly tracks: Readonly<Record<string, readonly PianoRollNote[]>>;
}

/** Validiert & normiert eine rohe Noten-Liste (auch aus gespeicherten Ständen). */
function sanitizeNotes(raw: unknown): PianoRollNote[] {
  if (!Array.isArray(raw)) return [];
  const out: PianoRollNote[] = [];
  for (const n of raw) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    const id = typeof o.id === 'string' && o.id ? o.id : crypto.randomUUID();
    const pitch = typeof o.pitch === 'number' ? Math.min(MAX_PITCH, Math.max(0, Math.round(o.pitch))) : 60;
    const startTicks = typeof o.startTicks === 'number' ? Math.max(0, Math.round(o.startTicks)) : 0;
    const lengthTicks = typeof o.lengthTicks === 'number' ? Math.max(TICKS_PER_QUARTER / 16, Math.round(o.lengthTicks)) : TICKS_PER_QUARTER / 4;
    const velocity = typeof o.velocity === 'number' ? Math.min(MAX_VELOCITY, Math.max(MIN_VELOCITY, Math.round(o.velocity))) : 100;
    const selected = typeof o.selected === 'boolean' ? o.selected : false;
    out.push({ id, pitch, startTicks, lengthTicks, velocity, selected });
  }
  return out;
}

/** Prüft, ob ein Settings-Objekt plausibel ist. */
function isValidSettings(raw: unknown): raw is PianoRollStoreSettings {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return o.version === 1 && !!o.tracks && typeof o.tracks === 'object';
}

/** Erzeugt einen leeren Snapshot (Revision 0). */
function emptySnapshot(): PianoRollStoreSnapshot {
  const tracks = {} as Record<string, readonly PianoRollNote[]>;
  for (const t of ALL_TRACKS) tracks[t] = [];
  return { revision: 0, tracks };
}

/** Wert-gleichheit für Noten-Arrays (JSON-Stringify, klein genug für Piano-Roll). */
function notesEqual(a: readonly PianoRollNote[], b: readonly PianoRollNote[]): boolean {
  if (a.length !== b.length) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export class PianoRollStore {
  private snapshot: PianoRollStoreSnapshot = emptySnapshot();
  private listeners = new Set<() => void>();
  private hydrated = false;
  /** Falls true, ist der Store noch nie durch load()/hydrate() befüllt worden. */
  private pristine = true;

  /** Gibt den aktuellen stabilen Snapshot zurück (für useSyncExternalStore). */
  getSnapshot = (): PianoRollStoreSnapshot => {
    return this.snapshot;
  }

  /** Registriert einen Change-Listener; liefert Deregistrierung. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Erhöht Revision, ersetzt Snapshot, benachrichtigt Listener. */
  private emitChange(): void {
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
    this.listeners.forEach((l) => {
      try { l(); } catch { /* listener-Fehler dürfen Store nicht stören */ }
    });
  }

  /** Gibt die Noten einer Spur zurück (readonly Array, stabiler Referenz). */
  getNotes(track: string): readonly PianoRollNote[] {
    return this.snapshot.tracks[track] ?? [];
  }

  /** Setzt die Noten einer Spur (sanitisiert). Liefert true, wenn sich was geändert hat. */
  setNotes(track: string, notes: readonly PianoRollNote[]): boolean {
    const sanitized = sanitizeNotes(notes);
    const current = this.snapshot.tracks[track] ?? [];
    // Wertgleichheit prüfen (nicht Referenzgleichheit – sanitize erzeugt neue Objekte)
    if (notesEqual(current, sanitized)) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      tracks: { ...this.snapshot.tracks, [track]: sanitized },
    };
    this.pristine = false;
    this.emitChange();
    return true;
  }

  /** Setzt alle Spuren auf einmal (für Hydration). */
  setAllNotes(tracks: Record<string, PianoRollNote[]>): void {
    let changed = false;
    const nextTracks = { ...this.snapshot.tracks };
    for (const [track, notes] of Object.entries(tracks)) {
      const sanitized = sanitizeNotes(notes);
      const current = this.snapshot.tracks[track] ?? [];
      if (!notesEqual(current, sanitized)) {
        nextTracks[track] = sanitized;
        changed = true;
      }
    }
    if (changed) {
      this.snapshot = { ...this.snapshot, tracks: nextTracks };
      this.pristine = false;
      this.emitChange();
    }
  }

  /** Pristine-Status: true, solange noch nie extern Noten geladen wurden. */
  isPristine(): boolean {
    return this.pristine;
  }

  /** Lädt gespeicherte Settings (idempotent – nur beim ersten Mal). */
  load(settings: unknown): boolean {
    if (!isValidSettings(settings)) return false;
    if (!this.pristine) return false; // nur einmal, erste Initialisierung gewinnt
    // Setzt pristine auch dann, wenn SetAllNotes keinen Change meldet (leerer Stand)
    this.setAllNotes(settings.tracks);
    this.pristine = false;
    this.hydrated = true;
    return true;
  }

  /** Serialisiert den aktuellen Stand für Plugin-Settings. */
  serialize(): PianoRollStoreSettings {
    const tracks: Record<string, PianoRollNote[]> = {};
    for (const [track, notes] of Object.entries(this.snapshot.tracks)) {
      tracks[track] = [...notes];
    }
    return { version: 1, tracks };
  }

  /** Prüft, ob der Store leer ist (keine Noten in keiner Spur). */
  isEmpty(): boolean {
    return Object.values(this.snapshot.tracks).every((arr) => arr.length === 0);
  }

  /** Setzt den Store auf Werkseinstellung (für Tests) – ohne Revisionserhöhung. */
  reset(): void {
    this.snapshot = emptySnapshot();
    this.hydrated = false;
    this.pristine = true;
    // Keine emitChange() – Revision bleibt 0 (Test-Erwartung)
  }
}

/** Globaler Singleton – EIN Store pro Prozess (gleiche Identität wie in Tests). */
export const pianoRollStore = new PianoRollStore();

/** Plugin-Settings-ID für Persistenz. */
export const PIANO_ROLL_STORE_ID = 'pianoroll';

/** Erzeugt einen frischen Store (für Tests / Storybook-Isolation). */
export function createPianoRollStore(): PianoRollStore {
  return new PianoRollStore();
}