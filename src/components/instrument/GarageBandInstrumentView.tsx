import React, { useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';

/**
 * instrumentMONK · GarageBand-artige Echtbild-Spielansicht (NEW-MONK-5)
 * ======================================================================
 * Nutzt die in `public/` bereitliegenden Instrumenten-Bilder als
 * skeuomorphe Spielfläche – wie GarageBand:
 *   * Oben: Instrumenten-Kacheln (Bild als Tile)
 *   * Unten: gewähltes Instrument als große Grafik mit Touch-/Click-Zonen
 *     (Klaviertasten, Saiten-Grids, Drum-Pads)
 *
 * Die Zonen triggern hörbare Preview-Noten über die AudioEngine. Alles
 * pointer-basiert (Touch + Maus), Zustände visuell (Pressed-Highlight).
 */

type OscType = 'sine' | 'triangle' | 'sawtooth' | 'square';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
interface PlayZone {
  label: string;
  freq: number;
  osc: OscType;
}

interface GbInstrument {
  id: string;
  name: string;
  image: string;
  mode: 'keys' | 'strings' | 'drums';
  /** keys: Frequenzen der weißen Tasten */
  keys?: number[];
  /** strings: [Saiten × Bünde] Frequenz-Matrix */
  stringTuning?: number[];
  frets?: number;
  /** drums: Pad-Positionen in % (left/top) */
  pads?: Array<{ label: string; left: number; top: number; freq: number; osc: OscType }>;
}

const WHITE_KEYS_C4 = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25];

const GARAGEBAND_INSTRUMENTS: GbInstrument[] = [
  { id: 'schlagzeug', name: 'Schlagzeug', image: '/bspschlagzeug.png', mode: 'drums', pads: [
    { label: 'Kick', left: 50, top: 72, freq: 60, osc: 'sine' },
    { label: 'Snare', left: 24, top: 64, freq: 200, osc: 'triangle' },
    { label: 'HiHat', left: 14, top: 38, freq: 6000, osc: 'square' },
    { label: 'Tom 1', left: 38, top: 34, freq: 220, osc: 'sine' },
    { label: 'Tom 2', left: 62, top: 34, freq: 180, osc: 'sine' },
    { label: 'Floor Tom', left: 76, top: 62, freq: 140, osc: 'sine' },
    { label: 'Crash', left: 84, top: 28, freq: 5200, osc: 'square' },
    { label: 'Ride', left: 30, top: 20, freq: 4800, osc: 'square' },
  ]},
  { id: 'gitarre', name: 'Gitarre', image: '/bspgitarre.jpg', mode: 'strings', stringTuning: [82.41, 110.0, 146.83, 196.0, 246.94, 329.63], frets: 4 },
  { id: 'bass', name: 'Bass', image: '/bspbassgitarre.jpg', mode: 'strings', stringTuning: [41.2, 55.0, 73.42, 98.0], frets: 4 },
  { id: 'klavier', name: 'Klavier', image: '/bspklavier.jpg', mode: 'keys', keys: WHITE_KEYS_C4 },
  { id: 'cello', name: 'Cello', image: '/bspcello.jpg', mode: 'strings', stringTuning: [65.41, 98.0, 146.83, 220.0], frets: 4 },
  { id: 'streicher', name: 'Streicher', image: '/bspstreicher.jpg', mode: 'keys', keys: WHITE_KEYS_C4.map((f) => f / 2) },
  { id: 'pads', name: 'Pads', image: '/bsppads.jpg', mode: 'keys', keys: [130.81, 146.83, 164.81, 174.61, 196.0, 220.0, 246.94, 261.63] },
  { id: 'glocken', name: 'Glocken', image: '/bspchinaglocken.jpg', mode: 'keys', keys: WHITE_KEYS_C4.map((f) => f * 2) },
  { id: 'drummaschine', name: 'Drum-Machine', image: '/bspdrummaschine.jpg', mode: 'drums', pads: [
    { label: 'BD', left: 20, top: 55, freq: 55, osc: 'sine' },
    { label: 'SD', left: 40, top: 55, freq: 190, osc: 'triangle' },
    { label: 'HH', left: 60, top: 55, freq: 7000, osc: 'square' },
    { label: 'OH', left: 80, top: 55, freq: 5000, osc: 'square' },
  ]},
  { id: 'sequenzer', name: 'Pad-Sequenzer', image: '/uipadsequenzer.jpg', mode: 'drums', pads: [
    { label: '1', left: 25, top: 40, freq: 261.63, osc: 'triangle' },
    { label: '2', left: 50, top: 40, freq: 293.66, osc: 'triangle' },
    { label: '3', left: 75, top: 40, freq: 329.63, osc: 'triangle' },
    { label: '4', left: 25, top: 70, freq: 392.0, osc: 'triangle' },
    { label: '5', left: 50, top: 70, freq: 440.0, osc: 'triangle' },
    { label: '6', left: 75, top: 70, freq: 523.25, osc: 'triangle' },
  ]},
];

function play(freq: number, osc: OscType): void {
  try {
    audioEngine.previewSynthesizedSample({ frequency: freq, decay: 0.35, oscillatorType: osc === 'sine' ? 'sine' : osc === 'triangle' ? 'triangle' : osc === 'square' ? 'square' : 'sawtooth' });
  } catch { /* Audio nicht initialisiert */ }
}

export const GarageBandInstrumentView: React.FC = React.memo(() => {
  const [selectedId, setSelectedId] = useState(GARAGEBAND_INSTRUMENTS[0].id);
  const [pressed, setPressed] = useState<string | null>(null);
  const selected = GARAGEBAND_INSTRUMENTS.find((i) => i.id === selectedId) ?? GARAGEBAND_INSTRUMENTS[0];

  const trigger = (label: string, freq: number, osc: OscType) => {
    setPressed(label);
    play(freq, osc);
    window.setTimeout(() => setPressed((p) => (p === label ? null : p)), 160);
  };

  return (
    <div className="space-y-4">
      {/* Instrumenten-Kacheln (GarageBand-Picker) */}
      <div className="grid grid-cols-5 gap-2">
        {GARAGEBAND_INSTRUMENTS.map((inst) => (
          <button
            key={inst.id}
            type="button"
            onClick={() => setSelectedId(inst.id)}
            className={`relative h-16 rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${selectedId === inst.id ? 'border-violet-400 ring-2 ring-violet-400/40' : 'border-neutral-800 hover:border-violet-500/50'}`}
          >
            <img src={inst.image} alt={inst.name} className="absolute inset-0 w-full h-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 bg-black/70 text-[9px] font-bold text-white uppercase tracking-wider py-0.5">{inst.name}</span>
          </button>
        ))}
      </div>

      {/* Spielfläche */}
      <div className="relative rounded-xl overflow-hidden border border-neutral-800 bg-black/60">
        <img src={selected.image} alt={selected.name} className="w-full h-56 object-cover opacity-90" />

        {selected.mode === 'keys' && (
          <div className="absolute inset-x-2 bottom-2 flex gap-1">
            {selected.keys!.map((freq, i) => (
              <button
                key={i}
                type="button"
                onPointerDown={() => trigger(`key-${i}`, freq, i % 2 === 0 ? 'sine' : 'triangle')}
                className={`flex-1 h-14 rounded-b-md border border-white/30 bg-gradient-to-b from-white/95 to-neutral-200 text-[8px] text-neutral-700 transition-transform ${pressed === `key-${i}` ? 'bg-violet-300 scale-95' : ''} cursor-pointer`}
              >
                C{i + 4}
              </button>
            ))}
          </div>
        )}

        {selected.mode === 'strings' && (
          <div className="absolute inset-x-4 bottom-3 grid gap-1" style={{ gridTemplateRows: `repeat(${selected.stringTuning!.length}, 1fr)` }}>
            {selected.stringTuning!.map((base, s) => (
              <div key={s} className="flex gap-1">
                {Array.from({ length: selected.frets ?? 4 }).map((_, f) => {
                  const freq = base * Math.pow(2, f / 12);
                  const label = `s${s}f${f}`;
                  return (
                    <button
                      key={label}
                      type="button"
                      onPointerDown={() => trigger(label, freq, 'sine')}
                      className={`flex-1 h-7 rounded border border-white/25 bg-black/45 text-[8px] text-white/80 transition-all ${pressed === label ? 'bg-violet-500/70 scale-95' : 'hover:bg-white/10'} cursor-pointer`}
                    >
                      {f === 0 ? `S${s + 1}` : ''}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {selected.mode === 'drums' && (
          <div className="absolute inset-0">
            {selected.pads!.map((pad) => {
              const label = `${selected.id}-${pad.label}`;
              return (
                <button
                  key={label}
                  type="button"
                  onPointerDown={() => trigger(label, pad.freq, pad.osc)}
                  style={{ left: `${pad.left}%`, top: `${pad.top}%` }}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 w-14 h-14 rounded-full border border-white/30 bg-white/10 backdrop-blur-[2px] text-[8px] font-bold text-white uppercase transition-all ${pressed === label ? 'bg-violet-500/60 scale-90' : 'hover:bg-white/20'} cursor-pointer`}
                >
                  {pad.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
