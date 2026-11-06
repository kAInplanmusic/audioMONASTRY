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

  setParam(name: keyof InstrumentPreset, value: number): void {
    if (name === 'label' || name === 'instrumentId' || name === 'persisted') return;
    (this.preset as unknown as Record<string, unknown>)[name] = value;
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

  /** Transponiert eine Note um preset.transpose Halbtöne. */
  private transpose(note: NoteInput): NoteInput {
    const off = this.preset.transpose;
    if (!off) return note;
    if (typeof note === 'number') return note + off;
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
    return (Number.parseInt(m[3], 10) + 1) * 12 + semitone;
  }

  private midiToName(midi: number): string {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(midi / 12) - 1;
    return names[((midi % 12) + 12) % 12] + octave.toString();
  }
}

export const instrumentBackend = new InstrumentBackend();
