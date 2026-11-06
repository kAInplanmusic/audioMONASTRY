/**
 * audioMONASTRY · instrumentMONK – InstrumentBackend (Plugin #5)
 * ============================================================
 * Konkrete, funktionale Referenzimplementierung von `IInstrumentBackend`.
 * Spricht die bestehende Audio-Engine ausschließlich über deren öffentliche
 * Instrument-Methoden an (load/instrumentNote/release/playSynthesisInstrument)
 * – niemals direkt den Web-Audio-Kontext. Damit bleibt die Audioengine hinter
 * dem Interface austauschbar (Phase-1-Prinzip).
 */
import type { IInstrumentBackend, InstrumentMidiEvent } from './IInstrumentBackend';
import type {
  InstrumentCategory, InstrumentDefinition, InstrumentPreset, InstrumentChannel, NoteInput,
} from './types';
import { catalogStats, getInstrument, INSTRUMENT_CATALOG, listByCategory } from '../instrument/catalog';
import { getInstrumentByProgram } from './midiProgramMap';
import { storageGet, storageSet } from '../../utils/storage';

/** Lazy-Referenz auf die Audio-Engine (Vermeidung eines zirkulären Imports). */
let engineRef: {
  loadInstrument(id: number): Promise<void>;
  instrumentNote(note: string | number): void;
  instrumentRelease(note?: string | number, time?: number): void;
  playSynthesisInstrument(def: InstrumentDefinition, note: NoteInput, velocity?: number): void;
} | null = null;

async function getEngine() {
  if (!engineRef) {
    const { audioEngine } = await import('../../utils/audioEngine');
    engineRef = audioEngine as unknown as typeof engineRef;
  }
  return engineRef!;
}

/** Erlaubte Preset-Bereiche (Werte ausserhalb werden geklemmt, Typfehler abgewiesen). */
const PARAM_RANGES: Record<'gain' | 'pan' | 'transpose' | 'velocity', { min: number; max: number; integer?: boolean }> = {
  gain: { min: 0, max: 1.5 },
  pan: { min: -1, max: 1 },
  velocity: { min: 0, max: 1 },
  // Halbtoene: ganzzahlig, ±4 Oktaven (wie `MAX_TRANSPOSE_SEMITONES` in itSynthVoice).
  transpose: { min: -48, max: 48, integer: true },
};

const MIDI_MIN = 0;
const MIDI_MAX = 127;

function clampMidi(midi: number): number {
  return Math.max(MIDI_MIN, Math.min(MIDI_MAX, Math.round(midi)));
}

export class InstrumentBackend implements IInstrumentBackend {
  readonly instrumentCount = INSTRUMENT_CATALOG.length;

  private loaded: InstrumentDefinition | undefined;
  /**
   * Serialisiert Engine-Aufrufe (load/noteOn/noteOff). Ohne diese Kette konnte
   * ein `await getEngine()` eine Note NACH einem späteren Instrument-Wechsel
   * ausführen und so mit fremdem Zustand klingen.
   */
  private pending: Promise<void> = Promise.resolve();

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.pending.catch(() => {}).then(action);
    this.pending = next;
    return next;
  }

  private preset: InstrumentPreset = {
    instrumentId: 1, gain: 1, pan: 0, transpose: 0, velocity: 1, label: 'Default',
    persisted: false,
  };

  list(category?: InstrumentCategory): InstrumentDefinition[] {
    return listByCategory(category);
  }

  current(): InstrumentDefinition | undefined {
    return this.loaded;
  }

  async load(id: number): Promise<void> {
    const def = getInstrument(id);
    if (!def) throw new Error(`Instrument nicht gefunden: ${id}`);
    this.loaded = def;
    this.preset = { ...this.preset, instrumentId: id };

    await this.enqueue(async () => {
      const eng = await getEngine();
      if (def.kind === 'acoustic') {
        // Akustische Patches laufen über die vorhandene additive Instrument-Engine.
        await eng.loadInstrument(id);
      }
      // synth/fm/drum/fx werden bei Note-On über playSynthesisInstrument erzeugt.
    });
  }

  noteOn(note: NoteInput, velocity?: number): void {
    // Ereigniszeitpunkt: der Zustand wird HIER eingefroren, nicht erst im
    // `await getEngine()` – sonst spielte eine Note nach einem Instrument-/
    // Preset-Wechsel mit dem neuen Zustand.
    const def = this.loaded;
    if (!def) return;
    // Unbrauchbare Noten (NaN/Infinity) duerfen die Audio-Kette nicht erreichen:
    // eine NaN-Frequenz vergiftet die Stimme und liefert dauerhaft Stille.
    if (typeof note === 'number' && !Number.isFinite(note)) return;
    const v = Math.max(0, Math.min(1, velocity ?? this.preset.velocity));
    const gain = this.preset.gain;
    const transposed = this.transpose(note);
    void this.enqueue(async () => {
      const eng = await getEngine();
      if (def.kind === 'acoustic' && def.id <= 50) {
        // Bestehende additive Engine (getPatch-engine) unterstützt ids 1..50.
        eng.instrumentNote(transposed);
      } else {
        eng.playSynthesisInstrument(def, transposed, v * gain);
      }
    });
  }

  /**
   * Note-Off mit Notenidentität: `note` benennt die zu lösende Note, damit
   * mehrstimmig gehaltene Noten sich einzeln freigeben lassen. Ohne `note`
   * bleibt das alte Verhalten (alle Stimmen frei).
   */
  noteOff(note?: NoteInput, time?: number): void {
    void this.enqueue(async () => { (await getEngine()).instrumentRelease(note, time); });
  }

  /**
   * Setzt einen Preset-Parameter. Nur endliche Zahlen werden uebernommen;
   * Werte ausserhalb des erlaubten Bereichs werden geklemmt, Nicht-Integer bei
   * `transpose` abgewiesen (ein 1.5-Halbton ergaebe "undefined4"). Ein
   * abgewiesener Wert laesst den letzten gueltigen stehen.
   */
  setParam(name: keyof InstrumentPreset, value: number): void {
    if (name === 'label' || name === 'instrumentId' || name === 'persisted') return;
    const range = PARAM_RANGES[name as keyof typeof PARAM_RANGES];
    if (!range) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    if (range.integer && !Number.isInteger(value)) return;
    this.preset[name as keyof typeof PARAM_RANGES] = Math.max(range.min, Math.min(range.max, value));
  }

  getParams(): InstrumentPreset {
    return { ...this.preset };
  }

  async savePreset(label: string): Promise<void> {
    const rec = { ...this.preset, label, persisted: true, instrumentId: this.loaded?.id ?? 1 };
    const key = `monk_instrument_${label}`;
    try {
      storageSet(key, JSON.stringify(rec));
      this.preset = rec;
    } catch (e) {
      console.warn('Instrument-Preset nicht speicherbar:', e);
    }
  }

  async loadPreset(label: string): Promise<InstrumentPreset | null> {
    try {
      const raw = storageGet(`monk_instrument_${label}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as InstrumentPreset;
      this.preset = { ...this.preset, ...parsed };
      await this.load(parsed.instrumentId ?? 1);
      return this.preset;
    } catch {
      return null;
    }
  }

  assignChannel(channelId: string, routeTo: string): InstrumentChannel {
    return { channelId, preset: { ...this.preset }, routeTo };
  }

  async handleProgramChange(program: number, _channel?: number): Promise<void> {
    const def = getInstrumentByProgram(program);
    if (!def) {
      console.warn(`MIDI-Program-Change: keine Zuordnung für Programm ${program}`);
      return;
    }
    await this.load(def.id);
  }

  onMidi(ev: InstrumentMidiEvent): void {
    if (typeof ev.program === 'number') {
      void this.handleProgramChange(ev.program, ev.channel);
      return;
    }
    this.noteOn(ev.note, ev.velocity);
  }

  /** Katalog-Summary (für UI/Statistik). */
  summary() {
    return { stats: catalogStats(), loaded: this.loaded?.name ?? null };
  }

  /**
   * Transponiert eine Note um preset.transpose Halbtöne.
   * Nur ganze, endliche Offsets sind sinnvoll: ein halber Halbton ergaebe einen
   * gebrochenen MIDI-Wert und damit einen Namen wie "undefined4", Infinity
   * "undefinedNaN". Ergebnis wird auf 0..127 geklemmt.
   */
  private transpose(note: NoteInput): NoteInput {
    const off = this.preset.transpose;
    if (!Number.isInteger(off) || off === 0) return note;
    if (typeof note === 'number') {
      if (!Number.isFinite(note)) return note;
      return clampMidi(note + off);
    }
    // Name → MIDI, verschieben, zurück zum Namen.
    const midi = this.nameToMidi(note);
    if (midi == null) return note;
    return this.midiToName(midi + off);
  }

  private nameToMidi(name: string): number | null {
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
    if (!m) return null;
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const letter = names.indexOf(m[1].toUpperCase());
    if (letter < 0) return null;
    // Vorzeichen als Versatz (Cb4 = 59), Oktave wie MIDI: C4 = 60.
    const semitone = letter + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    const midi = (Number.parseInt(m[3], 10) + 1) * 12 + semitone;
    // Namen ausserhalb des MIDI-Bereichs (C-2, C10) sind keine Noten.
    if (!Number.isFinite(midi) || midi < MIDI_MIN || midi > MIDI_MAX) return null;
    return midi;
  }

  private midiToName(midi: number): string {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const clamped = clampMidi(midi);
    const octave = Math.floor(clamped / 12) - 1;
    // Doppeltes Modulo: bei negativem MIDI waere names[-1] undefined.
    return names[((clamped % 12) + 12) % 12] + octave.toString();
  }
}

export const instrumentBackend = new InstrumentBackend();
