import React, { useState, useEffect } from 'react';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { MASTERING_PRESETS } from '../data/masteringPresets';
import { Cpu, Sparkles, SlidersHorizontal, Activity, Layers, Power } from 'lucide-react';
import { DropTarget } from './DropTarget';
import { AudioSample } from '../data/samples';

type PresetKey = keyof typeof MASTERING_PRESETS;
type MasteringTab = 'master_me' | 'tone_shift_eq';

interface MasteringOverlayProps {
  isOpen?: boolean;
  onClose?: () => void;
  plugin?: MasteringTab;
}

export function MasteringOverlay({
  isOpen = true,
  onClose = () => {},
  plugin = 'master_me',
}: MasteringOverlayProps) {
  const initialPresetKey = Object.keys(MASTERING_PRESETS)[0] as PresetKey;
  const [activeTab, setActiveTab] = useState<'master_me' | 'tone_shift_eq'>(plugin);
  // Aktiven Tab an externe plugin-Auswahl angleichen (React-Muster: state during render
  // statt setState im Effect, vgl. react-hooks/set-state-in-effect).
  const [lastPlugin, setLastPlugin] = useState(plugin);
  if (lastPlugin !== plugin) {
    setLastPlugin(plugin);
    setActiveTab(plugin);
  }
  const [lufs, setLufs] = useState(-23);
  const [autoMode, setAutoMode] = useState(false);
  const [targetSample, setTargetSample] = useState<AudioSample | null>(null);
  const [activePreset, setActivePreset] = useState<PresetKey>(initialPresetKey);
  const [masterMeParams, setMasterMeParams] = useState(MASTERING_PRESETS[initialPresetKey].master_me);
  const [toneShiftParams, setToneShiftParams] = useState(MASTERING_PRESETS[initialPresetKey].tone_shift);

  useEffect(() => {
    // Event-driven LUFS: register callback on audioEngine, fall back to polling
    let interval: ReturnType<typeof setInterval> | undefined;

    if (typeof audioEngine.onLufsChange === 'function') {
      audioEngine.onLufsChange = (value: number) => setLufs(value);
    } else {
      // Fallback: poll at reduced rate (4Hz instead of 10Hz)
      interval = setInterval(() => {
        const currentLufs = audioEngine.getLufsValue();
        if (currentLufs !== 0) setLufs(currentLufs);
      }, 250);
    }

    return () => {
      if (interval) clearInterval(interval);
      if (typeof audioEngine.onLufsChange === 'function') {
        audioEngine.onLufsChange = () => {};
      }
    };
  }, []);

  const handleSampleDrop = (sample: AudioSample) => {
    setTargetSample(sample);
    // console.log('Sample set for targeted mastering:', sample.name);
  };

  // Load initial preset (bewusst nur einmal beim Mount).
  useEffect(() => {
    applyPreset(activePreset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isOpen) return null;

  const handleMasterMeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const numValue = Number.parseFloat(value);
    setMasterMeParams(prev => {
      const next = { ...prev, [name]: numValue };
      audioEngine.updateMasterMe({ [name]: numValue });
      return next;
    });
  };

  const handleEqBandChange = (idx: number, field: 'gain' | 'q' | 'freq', value: number) => {
    setToneShiftParams(prev => {
      const newBands = [...prev.bands];
      newBands[idx] = { ...newBands[idx], [field]: value };
      const next = { ...prev, bands: newBands };
      audioEngine.updateToneShiftEQ({ bands: next.bands as any });
      return next;
    });
  };

  function applyPreset(presetKey: PresetKey) {
    const preset = MASTERING_PRESETS[presetKey];
    if (!preset) return;
    setActivePreset(presetKey);
    setMasterMeParams(preset.master_me);
    setToneShiftParams(preset.tone_shift);
    audioEngine.updateMasterMe(preset.master_me);
    audioEngine.updateToneShiftEQ(preset.tone_shift as any);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 sm:p-8">
      {/* Container - Command Center Style */}
      <div className="relative w-full max-w-6xl h-full max-h-[800px] short-landscape:max-h-[92vh] bg-[#050508] border border-sky-500/30 rounded-2xl shadow-[0_0_50px_rgba(14,165,233,0.15)] flex flex-col overflow-hidden">
        <div className="px-6 py-2 border-b border-sky-500/20 bg-black/20">
          <MoaAssistant pluginId="mastering" placeholder="MOA: z. B. 'Preset anwenden'" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-sky-900/20 to-indigo-900/20 border-b border-sky-500/20">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 shadow-[0_0_15px_rgba(14,165,233,0.3)]">
              <Cpu className="w-5 h-5 text-sky-400" />
            </div>
            <div>
              <h2 className="font-mono text-xl text-sky-100 font-bold tracking-tight flex items-center gap-2">
                NEXUS KONTROL <span className="px-2 py-0.5 rounded text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/30 uppercase">V. 1|001|420 ANUNNAKIDNA</span>
              </h2>
              <p className="text-xs font-mono text-sky-400/60 uppercase tracking-widest mt-0.5">Quantum Audio Processor</p>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 px-4 py-2 bg-black rounded border border-neutral-800">
              <Activity className="w-4 h-4 text-emerald-500" />
              <span className="font-mono text-xs text-neutral-400">LUFS:</span>
              <span className="font-mono text-sm font-bold text-emerald-400">{lufs.toFixed(1)}</span>
            </div>

            {/* Auto Mode Toggle */}
            <button type="button"
              onClick={() => setAutoMode(!autoMode)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-xs font-bold transition-all ${autoMode ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.3)]' : 'bg-neutral-900 text-neutral-500 border border-neutral-800'}`}
            >
              <Activity className="w-4 h-4" />
              AUTO SYNC
            </button>

            {/* Close Button */}
            <button type="button" onClick={onClose} className="w-10 h-10 flex items-center justify-center rounded-xl bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 hover:text-red-300 transition-all">
              <Power className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Main Interface */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar / Presets */}
          <div className="w-64 border-r border-sky-500/20 bg-[#0a0a0e] flex flex-col">
            <div className="p-4 border-b border-sky-500/10">
              <div className="flex gap-2 p-1 bg-black/40 rounded-lg border border-sky-500/10">
                <button type="button"
                  onClick={() => setActiveTab('master_me')}
                  className={`flex-1 py-2 text-xs font-mono font-bold rounded flex items-center justify-center gap-1.5 transition ${activeTab === 'master_me' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 shadow-[0_0_10px_rgba(99,102,241,0.2)]' : 'text-neutral-500 hover:text-neutral-300'}`}
                >
                  <Layers className="w-3.5 h-3.5" /> MST
                </button>
                <button type="button"
                  onClick={() => setActiveTab('tone_shift_eq')}
                  className={`flex-1 py-2 text-xs font-mono font-bold rounded flex items-center justify-center gap-1.5 transition ${activeTab === 'tone_shift_eq' ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30 shadow-[0_0_10px_rgba(217,70,239,0.2)]' : 'text-neutral-500 hover:text-neutral-300'}`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" /> EQ
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              <h3 className="text-[10px] font-mono text-sky-500/50 uppercase tracking-widest mb-3 flex items-center gap-2">
                <Sparkles className="w-3 h-3" /> Core Algorithms
              </h3>
              <div className="space-y-2">
                {Object.entries(MASTERING_PRESETS).map(([key, preset]) => (
                  <button type="button"
                    key={key}
                    onClick={() => applyPreset(key as PresetKey)}
                    className={`w-full text-left px-4 py-3 rounded-lg font-mono text-xs transition-all border ${activePreset === key ? 'bg-sky-500/10 border-sky-500/50 text-sky-300 shadow-[inset_0_0_15px_rgba(14,165,233,0.1)]' : 'bg-black/20 border-neutral-800/50 text-neutral-400 hover:bg-white/5 hover:border-neutral-700'}`}
                  >
                    <div className="font-bold tracking-tight">{preset.name}</div>
                  </button>
                ))}
              </div>

              <DropTarget
                label="Target Sample"
                onDrop={handleSampleDrop}
                className="mt-4 bg-black/20 border-sky-500/10 p-4"
              >
                <div className="text-xs font-mono text-neutral-400">
                  {targetSample ? targetSample.name : 'Drop a sample for targeted mastering'}
                </div>
              </DropTarget>
            </div>
          </div>

          {/* Editor Area */}
          <div className="flex-1 p-6 overflow-y-auto bg-linear-to-b from-[#050508] to-[#020204]">
            {activeTab === 'master_me' ? (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-6">
                  {/* Cards for Mastering */}
                  <KnobCard label="Input Gain" name="input_gain" min={-24} max={24} val={masterMeParams.input_gain} unit="dB" color="indigo" onChange={handleMasterMeChange} />
                  <KnobCard label="Highpass" name="highpass_freq" min={10} max={200} val={masterMeParams.highpass_freq} unit="Hz" color="sky" onChange={handleMasterMeChange} />
                  <KnobCard label="Target Loudness" name="target_loudness" min={-24} max={0} val={masterMeParams.target_loudness} unit="LUFS" color="fuchsia" onChange={handleMasterMeChange} />
                  <KnobCard label="Strength" name="strength" min={0} max={100} val={masterMeParams.strength} unit="%" color="indigo" onChange={handleMasterMeChange} />
                  <KnobCard label="Attack" name="attack" min={1} max={50} val={masterMeParams.attack} unit="ms" color="emerald" onChange={handleMasterMeChange} />
                  <KnobCard label="Release" name="release" min={10} max={300} val={masterMeParams.release} unit="ms" color="emerald" onChange={handleMasterMeChange} />
                  <KnobCard label="Ceiling" name="limiter_threshold" min={-6} max={0} val={masterMeParams.limiter_threshold} unit="dB" color="red" onChange={handleMasterMeChange} />
                </div>
              </div>
            ) : (
              <div className="flex flex-col h-full animate-in fade-in slide-in-from-bottom-4 duration-500">
                {/* 12-Band EQ Command Center */}
                <div className="relative w-full h-64 bg-[#0a0a0e] border border-fuchsia-500/20 rounded-xl mb-6 overflow-hidden shadow-[inset_0_0_30px_rgba(217,70,239,0.05)]">
                  {/* Grid Lines */}
                  <div className="absolute inset-0 flex flex-col justify-between opacity-10 pointer-events-none">
                    {[...Array(9)].map((_, i) => <div key={i} className="w-full h-px bg-fuchsia-400"></div>)}
                  </div>
                  <div className="absolute inset-0 flex justify-between opacity-10 pointer-events-none">
                    {[...Array(12)].map((_, i) => <div key={i} className="h-full w-px bg-fuchsia-400"></div>)}
                  </div>

                  {/* Visualizer Mock / Curved line */}
                  <svg className="absolute inset-0 w-full h-full pointer-events-none drop-shadow-[0_0_10px_rgba(217,70,239,0.5)]" preserveAspectRatio="none">
                    <path
                      d={`M 0,128 ${toneShiftParams.bands.map((b, i) => `C ${(i+0.5) * (100/12)}%,${128 - (b.gain * 5)} ${(i+1) * (100/12)}%,${128 - (b.gain * 5)}`).join(' ')}`}
                      fill="none"
                      stroke="url(#eqGradient)"
                      strokeWidth="3"
                    />
                    <defs>
                      <linearGradient id="eqGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#0ea5e9" />
                        <stop offset="50%" stopColor="#d946ef" />
                        <stop offset="100%" stopColor="#ec4899" />
                      </linearGradient>
                    </defs>
                  </svg>

                  {/* Band Nodes */}
                  <div className="absolute inset-0 flex items-center justify-around px-4">
                    {toneShiftParams.bands.map((b, i) => (
                      <div
                        key={i}
                        className="w-4 h-4 rounded-full bg-[#050508] border-2 border-fuchsia-400 shadow-[0_0_10px_rgba(217,70,239,0.8)] relative"
                        style={{ transform: `translateY(${-b.gain * 5}px)` }}
                      >
                        <div className="absolute top-6 left-1/2 -translate-x-1/2 text-[9px] font-mono text-fuchsia-200/50">
                          {b.freq >= 1000 ? `${(b.freq/1000).toFixed(1)}k` : Math.round(b.freq)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Band Controls Grid */}
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 overflow-y-auto pr-2 pb-10">
                  {toneShiftParams.bands.map((b, i) => (
                    <div key={i} className="bg-[#08080a] border border-fuchsia-500/10 rounded-lg p-3 flex flex-col gap-3">
                      <div className="text-center font-mono text-[10px] font-bold text-fuchsia-400">BAND {i + 1}</div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[9px] text-neutral-500 font-mono">GAIN ({b.gain.toFixed(1)} dB)</label>
                        <input
                          type="range" min={-24} max={24} step={0.1} value={b.gain}
                          onChange={(e) => handleEqBandChange(i, 'gain', Number.parseFloat(e.target.value))}
                          className="w-full accent-fuchsia-500 h-1 bg-neutral-800 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-fuchsia-400 [&::-webkit-slider-thumb]:rounded-full"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[9px] text-neutral-500 font-mono">FREQ ({Math.round(b.freq)} Hz)</label>
                        <input
                          type="range" min={20} max={20000} step={10} value={b.freq}
                          onChange={(e) => handleEqBandChange(i, 'freq', Number.parseFloat(e.target.value))}
                          className="w-full accent-fuchsia-500 h-1 bg-neutral-800 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-fuchsia-400 [&::-webkit-slider-thumb]:rounded-full"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[9px] text-neutral-500 font-mono">Q ({b.q.toFixed(2)})</label>
                        <input
                          type="range" min={0.1} max={10} step={0.1} value={b.q}
                          onChange={(e) => handleEqBandChange(i, 'q', Number.parseFloat(e.target.value))}
                          className="w-full accent-fuchsia-500 h-1 bg-neutral-800 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-fuchsia-400 [&::-webkit-slider-thumb]:rounded-full"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function KnobCard({ label, name, min, max, val, unit, color, onChange }: any) {
  const percent = ((val - min) / (max - min)) * 100;

  const colors: Record<string, string> = {
    sky: 'text-sky-400 border-sky-500/30 bg-sky-500/5',
    indigo: 'text-indigo-400 border-indigo-500/30 bg-indigo-500/5',
    fuchsia: 'text-fuchsia-400 border-fuchsia-500/30 bg-fuchsia-500/5',
    emerald: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5',
    red: 'text-red-400 border-red-500/30 bg-red-500/5',
  };

  const bgClasses = colors[color] || colors.sky;

  return (
    <div className={`p-4 rounded-xl border ${bgClasses} flex flex-col justify-between h-32 relative overflow-hidden group`}>
      <div className="absolute top-0 left-0 w-1 h-full bg-black/40">
        <div className={`absolute bottom-0 left-0 w-full bg-${color}-500 shadow-[0_0_10px_currentColor] transition-all duration-300`} style={{ height: `${percent}%` }}></div>
      </div>

      <div className="pl-3">
        <h4 className="text-[10px] font-mono uppercase tracking-wider text-neutral-400 mb-1">{label}</h4>
        <div className="text-2xl font-mono font-bold">
          {val > 0 ? '+' : ''}{val.toFixed(1)} <span className="text-xs text-neutral-500 font-normal">{unit}</span>
        </div>
      </div>

      <div className="pl-3 mt-4">
        <input
          type="range"
          name={name}
          min={min}
          max={max}
          step={(max - min) / 100}
          value={val}
          onChange={onChange}
          className={`w-full h-1.5 bg-black/40 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-${color}-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_0_10px_currentColor]`}
        />
      </div>
    </div>
  );
}
