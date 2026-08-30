/**
 * audioMONASTRY · instrumentMONK – Schnittstelle (Plugin #5)
 * =========================================================
 * Transport-agnostisches Interface für den Instrumenten-Backend. Alle
 * Instrumenten-Plugins/UI rufen ausschließlich dieses Interface auf – die
 * konkrete AudioEngine (AudioWorklet/Tone/WebGPU) bleibt dahinter austauschbar.
 */
import type {
  InstrumentCategory,
  InstrumentDefinition,
  InstrumentPreset,
  InstrumentChannel,
  NoteInput,
} from './types';

export interface InstrumentMidiEvent {
  note: NoteInput;
  velocity: number;   // 0..1
  channel?: number;   // MIDI-Kanal 1..16
  /** MIDI-Program-Change (0..127) – wählt das zugeordnete Instrument. */
  program?: number;
}

export interface IInstrumentBackend {
  readonly instrumentCount: number;

  /** Liste aller definierten Instrumente (Kategorien-filtrierbar). */
  list(category?: InstrumentCategory): InstrumentDefinition[];

  /** Lade ein Instrument zur Wiedergabe (wird beim nächsten Note-On genutzt). */
  load(id: number): Promise<void>;
  /** Geladenes Instrument (oder undefined). */
  current(): InstrumentDefinition | undefined;

  /** Ton an (Note-On) mit Velocity. */
  noteOn(note: NoteInput, velocity?: number): void;
  /** Ton aus (Note-Off / Release). */
  noteOff(time?: number): void;

  /** Einstellbare Performance-Parameter des geladenen Instruments. */
  setParam(name: keyof InstrumentPreset, value: number): void;
  /** Liest aktuelle Parameter des geladenen Instruments. */
  getParams(): InstrumentPreset;

  /** Preset persistieren (Async, z.B. OPFS/IndexedDB). */
  savePreset(label: string): Promise<void>;
  /** Setzt ein zuvor gespeichertes Preset. */
  loadPreset(label: string): Promise<InstrumentPreset | null>;

  /** Weist das geladene Instrument einem Sequencer-Kanal zu. */
  assignChannel(channelId: string, routeTo: string): InstrumentChannel;

  /**
   * MIDI-Program-Change: lädt das der Programmnummer zugeordnete Instrument
   * (zentrale Zuordnungstabelle in `midiProgramMap.ts`).
   */
  handleProgramChange(program: number, channel?: number): Promise<void>;

  /** Optional: direkter Midi-Trigger (Program-Change etc.). */
  onMidi?(ev: InstrumentMidiEvent): void;
}
