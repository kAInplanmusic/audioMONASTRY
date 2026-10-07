import React, { useState, useEffect } from 'react';
import { Music, Piano, Guitar, Layers, Cpu, Radio, Drum, Sparkles } from 'lucide-react';
import { AmCard } from './am/amUi';
import { DropTarget } from './DropTarget';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { SYNTHESIS_INSTRUMENTS } from '../core/instrument/catalog';
import { instrumentBackend } from '../core/instrument/InstrumentBackend';
import { webMIDIAdapter } from '../core/adapters';
import { UniversalKeyboard } from './instrument/UniversalKeyboard';
import { PadGrid } from './instrument/PadGrid';
import { InstrumentCanvas } from './instrument/InstrumentCanvas';
import { GarageBandInstrumentView } from './instrument/GarageBandInstrumentView';
import { webRTCManager } from '../utils/WebRTCManager';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';

// --- WAM2 / Instrument Standards ---
type InstrumentType = 'sampler' | 'synth' | 'soundfont' | 'synth2';

interface Instrument {
  id: number;
  name: string;
  category: string;
  type: InstrumentType;
}

const INSTRUMENT_CATEGORIES = [
  { name: 'Alle', icon: Music },
  { name: 'Tasteninstrumente', icon: Piano },
  { name: 'Streichinstrumente', icon: Music },
  { name: 'Zupfinstrumente', icon: Guitar },
  { name: 'Blasinstrumente', icon: Music },
  { name: 'Weltmusik & Chor', icon: Layers },
  { name: 'Analog-Synth', icon: Cpu },
  { name: 'FM-Synth', icon: Radio },
  { name: 'Drums & Perc', icon: Drum },
  { name: 'FX & Experimental', icon: Sparkles },
];

const PRESET_INSTRUMENTS: Instrument[] = [
  { id: 1, name: 'Grand Piano', category: 'Tasteninstrumente', type: 'soundfont' },
  { id: 2, name: 'Electric Piano (Rhodes)', category: 'Tasteninstrumente', type: 'sampler' },
  { id: 3, name: 'Organ (Hammond B3)', category: 'Tasteninstrumente', type: 'synth' },
  { id: 4, name: 'Harpsichord', category: 'Tasteninstrumente', type: 'soundfont' },
  { id: 5, name: 'Celesta', category: 'Tasteninstrumente', type: 'soundfont' },
  { id: 6, name: 'Accordion', category: 'Tasteninstrumente', type: 'sampler' },
  { id: 7, name: 'Clavinet', category: 'Tasteninstrumente', type: 'sampler' },
  { id: 8, name: 'Marimba', category: 'Tasteninstrumente', type: 'soundfont' },
  { id: 9, name: 'Vibraphone', category: 'Tasteninstrumente', type: 'soundfont' },
  { id: 10, name: 'Glockenspiel', category: 'Tasteninstrumente', type: 'soundfont' },
  { id: 11, name: 'Violin', category: 'Streichinstrumente', type: 'soundfont' },
  { id: 12, name: 'Viola', category: 'Streichinstrumente', type: 'soundfont' },
  { id: 13, name: 'Cello', category: 'Streichinstrumente', type: 'soundfont' },
  { id: 14, name: 'Contrabass', category: 'Streichinstrumente', type: 'soundfont' },
  { id: 15, name: 'String Ensemble', category: 'Streichinstrumente', type: 'soundfont' },
  { id: 16, name: 'Harp', category: 'Streichinstrumente', type: 'soundfont' },
  { id: 17, name: 'Acoustic Guitar (Nylon)', category: 'Zupfinstrumente', type: 'sampler' },
  { id: 18, name: 'Acoustic Guitar (Steel)', category: 'Zupfinstrumente', type: 'sampler' },
  { id: 19, name: 'Electric Guitar (Clean)', category: 'Zupfinstrumente', type: 'sampler' },
  { id: 20, name: 'Electric Guitar (Overdrive)', category: 'Zupfinstrumente', type: 'sampler' },
  { id: 21, name: 'Electric Bass', category: 'Zupfinstrumente', type: 'sampler' },
  { id: 22, name: 'Banjo', category: 'Zupfinstrumente', type: 'sampler' },
  { id: 23, name: 'Ukulele', category: 'Zupfinstrumente', type: 'sampler' },
  { id: 24, name: 'Mandolin', category: 'Zupfinstrumente', type: 'sampler' },
  { id: 25, name: 'Sitar', category: 'Weltmusik & Chor', type: 'sampler' },
  { id: 26, name: 'Trumpet', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 27, name: 'Trombone', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 28, name: 'French Horn', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 29, name: 'Tuba', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 30, name: 'Saxophone (Alto)', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 31, name: 'Saxophone (Tenor)', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 32, name: 'Clarinet', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 33, name: 'Oboe', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 34, name: 'Flute', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 35, name: 'Piccolo', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 36, name: 'Bassoon', category: 'Blasinstrumente', type: 'soundfont' },
  { id: 37, name: 'Harmonica', category: 'Blasinstrumente', type: 'sampler' },
  { id: 38, name: 'Pan Flute', category: 'Weltmusik & Chor', type: 'soundfont' },
  { id: 39, name: 'Shakuhachi', category: 'Weltmusik & Chor', type: 'sampler' },
  { id: 40, name: 'Kalimba', category: 'Weltmusik & Chor', type: 'sampler' },
  { id: 41, name: 'Didgeridoo', category: 'Weltmusik & Chor', type: 'sampler' },
  { id: 42, name: 'Koto', category: 'Weltmusik & Chor', type: 'sampler' },
  { id: 43, name: 'Erhu', category: 'Weltmusik & Chor', type: 'sampler' },
  { id: 44, name: 'Steel Drum', category: 'Weltmusik & Chor', type: 'sampler' },
  { id: 45, name: 'Choir (Aah)', category: 'Weltmusik & Chor', type: 'soundfont' },
  { id: 46, name: 'Choir (Ooh)', category: 'Weltmusik & Chor', type: 'soundfont' },
  { id: 47, name: 'Theremin', category: 'Weltmusik & Chor', type: 'synth' },
  { id: 48, name: 'Bagpipe', category: 'Weltmusik & Chor', type: 'sampler' },
  { id: 49, name: 'Timpani', category: 'Weltmusik & Chor', type: 'soundfont' },
  { id: 50, name: 'Tubular Bells', category: 'Weltmusik & Chor', type: 'soundfont' },
];

// --- Synthese-Instrumente (Analog/FM/Drum/FX) aus dem instrumentMONK-Katalog ---
// Kategorie-Values des Kern-Katalogs auf die UI-Kategorien mappen.
const UI_CAT_MAP: Record<string, string> = {
  'analog-synth': 'Analog-Synth',
  'fm-synth': 'FM-Synth',
  'drums-percussion': 'Drums & Perc',
  'fx-experimental': 'FX & Experimental',
  acoustic: 'Tasteninstrumente',
};

const SYNTH_PRESET_INSTRUMENTS: Instrument[] = SYNTHESIS_INSTRUMENTS.map(d => ({
  id: d.id,
  name: d.name,
  category: UI_CAT_MAP[d.category] ?? 'Analog-Synth',
  type: 'synth2',
}));

export const InstrumentsTerminal = React.memo(function InstrumentsTerminal() {
  const { state, lockStatus, updateState } = usePluginState('instru', 'PRO');
  // Beständige Plugins: Einstiegsstand = zuletzt gewähltes Instrument + Ansicht.
  const [saved] = useState(() => mergeKnown({ instrumentId: -1, activeCategory: 'Alle', playView: 'keys' }, readPluginSettings('instru')));
  const [activeCategory, setActiveCategory] = useState(saved.activeCategory);
  const [search, setSearch] = useState('');
  const [instruments] = useState<Instrument[]>([...PRESET_INSTRUMENTS, ...SYNTH_PRESET_INSTRUMENTS]);
  const [activeInstrument, setActiveInstrument] = useState<Instrument | null>(
    () => [...PRESET_INSTRUMENTS, ...SYNTH_PRESET_INSTRUMENTS].find((i) => i.id === saved.instrumentId) ?? null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [droppedSample, setDroppedSample] = useState<AudioSample | null>(null);
  // Task 2: MIDI-Program-Change – zuletzt empfangene Programmnummer (UI-Spiegelung).
  const [midiProgram, setMidiProgram] = useState<number | null>(null);
  // Spielansichten: Pad-/Klavier-Eingabe als Standard (NEW-MONK-5).
  const [playView, setPlayView] = useState<'preview' | 'keys' | 'pads' | 'canvas' | 'garageband'>(
    ['preview', 'keys', 'pads', 'canvas', 'garageband'].includes(saved.playView) ? (saved.playView as 'keys') : 'keys',
  );
  // Übernahme: das gespeicherte Instrument einmal laden (Klang wie beim Vorgänger).
  useEffect(() => {
    if (saved.instrumentId >= 0) void instrumentBackend.load(saved.instrumentId).catch(() => { /* Instrument nicht verfügbar */ });
  }, [saved]);
  useEffect(() => {
    writePluginSettings('instru', { instrumentId: activeInstrument?.id ?? -1, activeCategory, playView });
  }, [activeInstrument, activeCategory, playView]);

  // MIDI-Program-Change via WebMIDIAdapter (controllerMONK) → instrumentBackend.
  useEffect(() => {
    webMIDIAdapter.onControl((msg) => {
      if (msg.kind !== 'program') return;
      if (lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId) return;
      const program = msg.idNum;
      void instrumentBackend.handleProgramChange(program, msg.channel).then(() => {
        const def = instrumentBackend.current();
        if (def) {
          setActiveInstrument({ id: def.id, name: def.name, category: def.category, type: 'synth2' });
          setMidiProgram(program);
        }
      });
    });
    // Best-effort: Adapter verbinden (ohne Fehler zu werfen, falls kein MIDI).
    void webMIDIAdapter.connect().catch(() => { /* kein Web-MIDI verfügbar */ });
    return () => webMIDIAdapter.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSampleDrop = (sample: AudioSample) => {
    if (lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId) return;
    setDroppedSample(sample);
    // Tell audioEngine to map this sample to the active instrument slot
    if (sample.url) {
        audioEngine.loadTrackSample('channel1', sample.url);
    }
  };

  const loadInstrument = async (inst: Instrument) => {
    setIsLoading(true);
    setActiveInstrument(inst);

    try {
      // Instruktionen über den instrumentMONK-Backend (Interface) laden –
      // akustische Patches (1..50) und Synthese-Presets (Analog/FM/Drum/FX).
      await instrumentBackend.load(inst.id);
    } catch (error) {
      console.error(`Failed to load instrument: ${inst.name}`, error);
    } finally {
      setIsLoading(false);
    }
  };

  /** Spielt eine Note am geladenen Instrument (akustisch oder Synthese). */
  const previewNote = (note: string) => {
    instrumentBackend.noteOn(note, 0.9);
  };
  const releaseNote = () => {
    instrumentBackend.noteOff();
  };

  const filtered = instruments.filter(inst => {
    if (activeCategory !== 'Alle' && inst.category !== activeCategory) return false;
    if (search && !inst.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  return (
    <div className="am-rackrow" style={locked ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="instrument" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      <AmCard title="Instrument" right={<span className="am-vb">MIDI PGM {midiProgram ?? '—'}</span>} style={{ width: 300 }}>
        <select className="am-sel" aria-label="Kategorie" value={activeCategory} onChange={(e) => setActiveCategory(e.target.value)}>
          {INSTRUMENT_CATEGORIES.map((cat) => <option key={cat.name} value={cat.name}>{cat.name}</option>)}
        </select>
        <input className="am-libq" placeholder="Instrument suchen …" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Instrument suchen" />
        <select className="am-sel" aria-label="Instrument wählen" value={activeInstrument?.id ?? ''}
          onChange={(e) => { const inst = instruments.find((x) => x.id === Number(e.target.value)); if (inst) void loadInstrument(inst); }}>
          <option value="">{filtered.length} Instrumente – wählen …</option>
          {filtered.map((inst) => <option key={inst.id} value={inst.id}>{inst.name}</option>)}
        </select>
        <div className="am-hint" aria-live="polite">
          {isLoading ? 'lädt …' : activeInstrument ? `${activeInstrument.name} · ${activeInstrument.category}` : 'kein Instrument geladen'}
        </div>
        <DropTarget label="Sample auf den Slot ziehen" onDrop={handleSampleDrop} className="am-drop">
          <span>{droppedSample ? `${droppedSample.name} geladen` : 'Sample hierher ziehen'}</span>
        </DropTarget>
      </AmCard>
      <AmCard title="Spielen" style={{ flex: 1, minWidth: 520 }}
        right={(
          <div className="am-seg" role="tablist" aria-label="Spielansicht">
            {([['keys', 'TASTEN'], ['pads', 'PADS'], ['canvas', 'INSTRUMENT'], ['garageband', 'ECHTBILD'], ['preview', 'NOTEN']] as const).map(([v, label]) => (
              <button type="button" key={v} role="tab" aria-selected={playView === v} className={playView === v ? 'am-on' : ''} onClick={() => setPlayView(v)}>{label}</button>
            ))}
          </div>
        )}>
        {playView === 'preview' && (
          <div style={{ display: 'flex', gap: 4 }}>
            {['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'].map((note) => (
              <button type="button" key={note} className="am-btn" style={{ flex: 1, height: 60 }}
                onMouseDown={(e) => { e.preventDefault(); previewNote(note); }} onMouseUp={releaseNote} onMouseLeave={releaseNote}>{note}</button>
            ))}
          </div>
        )}
        {playView === 'keys' && <UniversalKeyboard baseNote={48} octaves={2} />}
        {playView === 'pads' && <PadGrid rows={4} cols={4} baseNote={48} />}
        {playView === 'canvas' && <InstrumentCanvas instrumentName={activeInstrument?.name ?? 'Guitar'} />}
        {playView === 'garageband' && <GarageBandInstrumentView />}
      </AmCard>
    </div>
  );
});
