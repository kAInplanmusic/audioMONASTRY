import React, { useState, useEffect } from 'react';
import { Music, Piano, Guitar, Layers, Loader2, Cpu, Radio, Drum, Sparkles } from 'lucide-react';
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
  const { state, lockStatus, updateState } = usePluginState('instrument', 'PRO');
  const [activeCategory, setActiveCategory] = useState('Alle');
  const [search, setSearch] = useState('');
  const [instruments] = useState<Instrument[]>([...PRESET_INSTRUMENTS, ...SYNTH_PRESET_INSTRUMENTS]);
  const [activeInstrument, setActiveInstrument] = useState<Instrument | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [droppedSample, setDroppedSample] = useState<AudioSample | null>(null);
  // Task 2: MIDI-Program-Change – zuletzt empfangene Programmnummer (UI-Spiegelung).
  const [midiProgram, setMidiProgram] = useState<number | null>(null);
  // Spielansichten: Pad-/Klavier-Eingabe als Standard (NEW-MONK-5).
  const [playView, setPlayView] = useState<'preview' | 'keys' | 'pads' | 'canvas' | 'garageband'>('keys');

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

  return (
    <div className={`w-full h-full flex flex-col bg-[#161616] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} text-neutral-300 font-sans shadow-2xl ${lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId ? 'opacity-50 grayscale' : ''}`}>
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="instrument" placeholder="MOA: z. B. 'Program 25 laden'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-purple-900/20 to-[#161616] border-b border-purple-900/30">
        <h2 className="text-xl font-black uppercase flex items-center gap-2">
          <Music className="w-5 h-5 text-purple-400" />
          Instruments <span className="text-[10px] font-mono text-purple-400 border border-purple-500/30 px-2 rounded">WAM 2.0</span>
          <span className={`text-[10px] font-mono px-2 rounded border ${midiProgram !== null ? 'text-emerald-400 border-emerald-500/40 bg-emerald-950/30' : 'text-neutral-600 border-neutral-800'}`}>
            MIDI PGM {midiProgram ?? '—'}
          </span>
        </h2>
        <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
        </select>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-1/3 border-r border-neutral-800 bg-[#111] p-4 flex flex-col">
            <input
                placeholder="Search..."
                className="w-full bg-[#1a1a1a] border border-neutral-800 rounded p-2 text-sm mb-4"
                onChange={(e) => setSearch(e.target.value)}
            />
            <div className="grid grid-cols-3 gap-2 mb-4">
                {INSTRUMENT_CATEGORIES.map(cat => (
                    <button type="button" key={cat.name} onClick={() => setActiveCategory(cat.name)} className={`p-2 rounded border text-xs ${activeCategory === cat.name ? 'bg-purple-900/40 border-purple-500' : 'bg-[#1a1a1a] border-neutral-800'}`}>
                        {cat.name}
                    </button>
                ))}
            </div>
            <div className="text-[10px] font-mono text-neutral-500 mb-2">{filtered.length} / {instruments.length} Instrumente</div>
            <div className="flex-1 overflow-y-auto">
                {filtered.map(inst => (
                    <button type="button" key={inst.id} onClick={() => loadInstrument(inst)} className={`w-full p-2 text-left text-sm ${activeInstrument?.id === inst.id ? 'text-purple-300 bg-purple-900/20' : ''}`}>
                        {inst.name}
                    </button>
                ))}
            </div>
        </div>

        <div className="flex-1 p-8 flex flex-col items-center justify-center gap-4">
            <DropTarget
                label="Drop Sample to Slot"
                onDrop={handleSampleDrop}
                className="w-full h-40 short-landscape:h-24 flex flex-col items-center justify-center"
            >
                {isLoading ? <Loader2 className="w-12 h-12 animate-spin text-purple-500" /> :
                <div className="text-center font-black">
                    {droppedSample ? `${droppedSample.name} LOADED` : 'DROP SAMPLE HERE'}
                </div>}
            </DropTarget>

            {/* Spielansichten (View 1/2/3) */}
            <div className="w-full bg-black/40 rounded-lg border border-neutral-800 p-3">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-mono text-purple-400 uppercase tracking-widest">Spielansicht</span>
                    <span className="text-[10px] text-neutral-500 truncate max-w-[50%]">
                        {activeInstrument ? activeInstrument.name : 'kein Instrument'}
                    </span>
                </div>
                <div className="flex gap-1 mb-3" role="tablist" aria-label="Spielansicht">
                    {([['preview', 'PREVIEW'], ['keys', 'KEYS'], ['pads', 'PADS'], ['canvas', 'CANVAS'], ['garageband', 'ECHTBILD']] as const).map(([v, label]) => (
                        <button type="button" key={v} role="tab" aria-selected={playView === v}
                            onClick={() => setPlayView(v)}
                            className={`px-2 py-1 rounded text-[8px] font-bold tracking-widest border ${
                                playView === v ? 'bg-purple-900/40 border-purple-400 text-purple-200' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {playView === 'preview' && (
                    <div className="flex gap-1 overflow-x-auto pb-1">
                        {['C4','D4','E4','F4','G4','A4','B4','C5'].map(note => (
                            <button type="button"
                                key={note}
                                onMouseDown={(e) => { e.preventDefault(); previewNote(note); }}
                                onMouseUp={releaseNote}
                                onMouseLeave={releaseNote}
                                className="flex-1 min-w-[28px] h-16 rounded shadow-inner bg-linear-to-b from-neutral-300 to-neutral-400 text-neutral-900 text-xs font-bold hover:from-neutral-200 active:from-purple-300"
                            >
                                {note}
                            </button>
                        ))}
                    </div>
                )}
                {playView === 'keys' && <UniversalKeyboard baseNote={48} octaves={2} />}
                {playView === 'pads' && <PadGrid rows={4} cols={4} baseNote={48} />}
                {playView === 'canvas' && (
                    <InstrumentCanvas instrumentName={activeInstrument?.name ?? 'Guitar'} />
                )}
                {playView === 'garageband' && <GarageBandInstrumentView />}
            </div>
        </div>
      </div>
    </div>
  );
});
