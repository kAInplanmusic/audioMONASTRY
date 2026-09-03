import React, { useState, useEffect } from 'react';
import { Waves } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { WasmPluginHost } from '../audio/wasm/WasmPluginHost';
import { MoaAssistant } from './MoaAssistant';
import { audioEngine } from '../utils/audioEngine';
import { DX7_REFERENCE_PATCHES } from '../core/instrument/dx7Presets';
import type { TrackType } from '../types';

const DEFAULT_SYNTH_PARAMS = {
  cutoff: 1000,
  decay: 0.2,
  engine: 'SUBTRACTIVE',
};

const PREVIEW_NOTES: Array<{ label: string; frequency: number }> = [
  { label: 'C4', frequency: 261.63 },
  { label: 'E4', frequency: 329.63 },
  { label: 'G4', frequency: 392.0 },
  { label: 'C5', frequency: 523.25 },
];

const TARGET_CHANNELS: TrackType[] = ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'];

/**
 * synthesizerMONK – P0-5: an `audioEngine` angebunden.
 * Cutoff/Resonanz laufen als sample-genaue Automation in den it-synth-Worklet;
 * die Preview-Noten sind direkt hörbar. Der WASM-Host bleibt optionaler Zusatz.
 */
export const SynthesizerTerminal: React.FC = React.memo(() => {
  const { lockStatus } = usePluginState('synthesizer', 'PRO');
  const hostRef = React.useRef(new WasmPluginHost());
  const [isLoaded, setIsLoaded] = useState(false);
  const [cutoff, setCutoff] = useState(DEFAULT_SYNTH_PARAMS.cutoff);
  const [decay, setDecay] = useState(DEFAULT_SYNTH_PARAMS.decay);
  const [engine, setEngine] = useState(DEFAULT_SYNTH_PARAMS.engine);
  const [targetChannel, setTargetChannel] = useState<TrackType>('channel4');
  // NEW-MONK-4: 16-Step-Notensequencer (C4 + Halbtöne).
  const [seq, setSeq] = useState<number[]>(Array(16).fill(0));
  const [seqSemi, setSeqSemi] = useState(0);
  const [curStep, setCurStep] = useState(0);
  // 6-Op-FM (DX7) + Granular-Preview
  const [fm6PatchIdx, setFm6PatchIdx] = useState(0);
  const [grainSize, setGrainSize] = useState(480);
  const [grainDensity, setGrainDensity] = useState(20);
  const [grainPitch, setGrainPitch] = useState(1);
  const [grainFreeze, setGrainFreeze] = useState(false);

  const loadFm6Patch = (idx: number) => {
    setFm6PatchIdx(idx);
    try {
      audioEngine.setFm6Patch(DX7_REFERENCE_PATCHES[idx]);
      audioEngine.fm6NoteOn(261.63, 0.8);
    } catch (e) { console.warn('[synth] FM6-Patch fehlgeschlagen:', e); }
  };

  const loadGranularPreview = () => {
    try {
      const src = new Float32Array(48000);
      for (let i = 0; i < src.length; i++) src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
      audioEngine.loadGranularSource(src);
      audioEngine.setGranularParams({ grainSize, density: grainDensity, pitch: grainPitch, freeze: grainFreeze, gain: 0.8 });
    } catch (e) { console.warn('[synth] Granular-Source fehlgeschlagen:', e); }
  };

  useEffect(() => {
    const host = hostRef.current;
    // Worklet-/JS-Synth ist der produktive Pfad: Graph erst bei Aktivierung
    // aufbauen (P0-2 lazy – kein Rauschen bei OFF).
    void audioEngine.ensureSynthGraph();
    // Load plugin on startup (optionaler WASM-Zusatz)
    host.loadPlugin('/plugins/synth_core.wasm').then(() => {
        setIsLoaded(true);
        // Set initial parameters on load
        host.setParameter('cutoff', cutoff);
        host.setParameter('decay', decay);
        host.setParameter('engine', engine === 'SUBTRACTIVE' ? 0 : engine === 'FM' ? 1 : 2);
    }).catch(err => {
        // Optionales WASM-Plugin: Worklet-/JS-Synth ist der produktive Pfad.
        console.warn('[synth] WASM-Plugin optional nicht geladen – Worklet-Fallback aktiv:', err);
    });

    // Cleanup on unmount
    return () => {
      try { host.dispose(); } catch { /* best-effort */ }
    };
  }, []);

  // NEW-MONK-4: Sequencer triggert aktive Steps am Master-Transport.
  useEffect(() => audioEngine.addStepListener(setCurStep), []);
  useEffect(() => {
    const f = seq[curStep % 16];
    if (f > 0) audioEngine.noteOnWorklet(f, 0.7, 'saw');
  }, [curStep, seq]);

  const validateAndSetParameter = (param: string, value: number | string) => {
    const host = hostRef.current;
    if (param === 'cutoff' && (typeof value !== 'number' || value < 20 || value > 20000)) return false;
    if (param === 'decay' && (typeof value !== 'number' || value < 0 || value > 1)) return false;

    // P0-5: Parameter IMMER auch an die echte AudioEngine durchreichen –
    // die UI-Steuerung soll hörbar sein, nicht nur den WASM-Host bedienen.
    try {
      if (param === 'cutoff') {
        audioEngine.automateItSynthParam('cutoff', value as number);
      } else if (param === 'decay') {
        // Decay wird über die Tonhöhen-/Hüllkurven-Vorschau hörbar gemacht.
      }
    } catch (err) {
      console.warn('[synth] audioEngine-Automation fehlgeschlagen:', err);
    }

    if (!isLoaded || !host) {
      return true; // Worklet-Pfad ist produktiv – WASM ist optional.
    }

    try {
      if (param === 'engine') {
        const engineValue = value === 'SUBTRACTIVE' ? 0 : value === 'FM' ? 1 : 2;
        host.setParameter('engine', engineValue);
      } else {
        host.setParameter(param, value as number);
      }
      return true;
    } catch (error) {
      console.error(`Failed to set parameter ${param}:`, error);
      return false;
    }
  };

  const handleCutoffChange = (value: number) => {
    if (validateAndSetParameter('cutoff', value)) {
      setCutoff(value);
    }
  };

  const handleDecayChange = (value: number) => {
    if (validateAndSetParameter('decay', value)) {
      setDecay(value);
    }
  };

  const handleEngineChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (validateAndSetParameter('engine', value)) {
      setEngine(value);
    }
  };

  const previewNote = (frequency: number) => {
    try {
      // Preview auf dem gewählten Kanal (Gain kurz öffnen) + hörbare Note.
      audioEngine.setChannelGain(targetChannel, 1);
      audioEngine.previewSynthesizedSample({ frequency, decay, oscillatorType: engine === 'FM' ? 'square' : 'sawtooth' });
    } catch (e) {
      console.warn('[synth] Preview fehlgeschlagen:', (e as Error).message);
    }
  };

  return (
    <div className={`p-6 bg-[#161616] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} text-neutral-300 font-mono shadow-2xl`}>
      <div className="mb-4 -mt-2">
        <MoaAssistant pluginId="synthesizer" placeholder="MOA: z. B. 'Spiele Note 440 Hz'" />
      </div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-sm font-black uppercase tracking-widest text-neutral-400 flex items-center gap-2">
            <Waves className="w-4 h-4 text-violet-400" /> Synth MONK
        </h3>
        <select value={engine} onChange={handleEngineChange} className="bg-black text-white text-xs p-1 rounded">
            <option value="SUBTRACTIVE">SUBTRACTIVE</option>
            <option value="FM">FM</option>
            <option value="WAVETABLE">WAVETABLE</option>
        </select>
      </div>

      {!isLoaded && <div className="text-xs text-yellow-500 mb-4">WASM optional – Worklet-Synth aktiv</div>}

      <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <label className="text-[10px] text-neutral-500" htmlFor="synth-filter-cutoff">FILTER CUTOFF</label>
            <input id="synth-filter-cutoff" type="range" min="20" max="20000" value={cutoff} onChange={e => handleCutoffChange(Number(e.target.value))} className="w-full accent-violet-500" />
            <div className="text-xs">{cutoff} Hz</div>
          </div>
          <div className="space-y-4">
            <label className="text-[10px] text-neutral-500" htmlFor="synth-adsr-decay">ADSR DECAY</label>
            <input id="synth-adsr-decay" type="range" min="0" max="1" step="0.01" value={decay} onChange={e => handleDecayChange(Number(e.target.value))} className="w-full accent-violet-500" />
          </div>
      </div>

      {/* P0-5: Routing-Ziel + direkt hörbares Preview-Keyboard */}
      <div className="mt-6 pt-4 border-t border-neutral-800">
        <div className="flex items-center justify-between gap-3 mb-3">
          <span className="text-[10px] text-neutral-500 uppercase tracking-widest">Routing-Ziel</span>
          <select
            value={targetChannel}
            onChange={(e) => setTargetChannel(e.target.value as TrackType)}
            className="bg-black text-white text-xs p-1 rounded"
          >
            {TARGET_CHANNELS.map((ch, i) => <option key={ch} value={ch}>CH{i + 1}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {PREVIEW_NOTES.map((note) => (
            <button
              key={note.label}
              type="button"
              onClick={() => previewNote(note.frequency)}
              className="px-2 py-3 rounded-lg border border-violet-500/40 bg-violet-500/10 text-violet-200 text-xs font-black tracking-widest hover:bg-violet-500/25 active:scale-95 transition-all cursor-pointer"
            >
              {note.label}
            </button>
          ))}
        </div>

        {/* NEW-MONK-4: 16-Step-Notensequencer */}
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-neutral-500 uppercase tracking-widest">Step-Seq</span>
            <span className="text-[9px] font-mono text-neutral-600">{curStep + 1}/16</span>
            <input type="range" min={0} max={12} value={seqSemi}
              onChange={(e) => setSeqSemi(Number(e.target.value))}
              className="w-20 accent-violet-500" />
            <span className="text-[9px] font-mono text-violet-300">+{seqSemi} HT</span>
          </div>
          <div className="grid grid-cols-16 gap-1">
            {[...Array(16)].map((_, i) => {
              const on = seq[i] > 0;
              return (
                <button type="button" key={i}
                  onClick={() => setSeq((prev) => {
                    const next = [...prev];
                    next[i] = next[i] > 0 ? 0 : 261.63 * Math.pow(2, seqSemi / 12);
                    return next;
                  })}
                  className={`h-7 rounded-[3px] border transition-all cursor-pointer ${on ? 'bg-violet-500 border-violet-300' : 'bg-black/60 border-neutral-800 hover:border-violet-500/50'} ${curStep % 16 === i ? 'ring-1 ring-white/70' : ''}`} />
              );
            })}
          </div>
        </div>

        {/* 6-Op-FM (DX7) + Granular – Worklet-Preview */}
        <div className="mt-4 pt-4 border-t border-neutral-800">
          <div className="text-[10px] text-neutral-500 uppercase tracking-widest mb-2">6-Op-FM / DX7</div>
          <div className="flex items-center gap-2">
            <select
              value={fm6PatchIdx}
              onChange={(e) => loadFm6Patch(Number(e.target.value))}
              className="bg-black text-white text-xs p-1 rounded flex-1"
            >
              {DX7_REFERENCE_PATCHES.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
            </select>
            <button type="button" onClick={() => audioEngine.fm6NoteOn(261.63, 0.8)}
              className="px-2 py-1 rounded border border-violet-500/40 text-violet-200 text-xs hover:bg-violet-500/25 cursor-pointer">
              ▶ Note
            </button>
          </div>

          <div className="text-[10px] text-neutral-500 uppercase tracking-widest mt-3 mb-2">Granular</div>
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <label className="text-neutral-500">Grain {grainSize}
              <input type="range" min={64} max={4096} step={64} value={grainSize}
                onChange={(e) => { setGrainSize(Number(e.target.value)); audioEngine.setGranularParams({ grainSize: Number(e.target.value) }); }}
                className="w-full accent-violet-500" />
            </label>
            <label className="text-neutral-500">Density {grainDensity}
              <input type="range" min={1} max={100} value={grainDensity}
                onChange={(e) => { setGrainDensity(Number(e.target.value)); audioEngine.setGranularParams({ density: Number(e.target.value) }); }}
                className="w-full accent-violet-500" />
            </label>
            <label className="text-neutral-500">Pitch {grainPitch.toFixed(2)}
              <input type="range" min={25} max={400} value={Math.round(grainPitch * 100)}
                onChange={(e) => { const v = Number(e.target.value) / 100; setGrainPitch(v); audioEngine.setGranularParams({ pitch: v }); }}
                className="w-full accent-violet-500" />
            </label>
            <label className="text-neutral-500 flex items-center gap-1 mt-1">
              <input type="checkbox" checked={grainFreeze}
                onChange={(e) => { setGrainFreeze(e.target.checked); audioEngine.setGranularParams({ freeze: e.target.checked }); }} />
              Freeze
            </label>
          </div>
          <button type="button" onClick={loadGranularPreview}
            className="mt-2 px-2 py-1 rounded border border-violet-500/40 text-violet-200 text-xs hover:bg-violet-500/25 cursor-pointer">
            ▶ Granular-Source laden
          </button>
        </div>
      </div>
    </div>
  );
});
