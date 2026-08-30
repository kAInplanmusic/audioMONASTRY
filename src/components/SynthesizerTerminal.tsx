import React, { useState, useEffect } from 'react';
import { Waves } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { WasmPluginHost } from '../audio/wasm/WasmPluginHost';
import { MoaAssistant } from './MoaAssistant';

const DEFAULT_SYNTH_PARAMS = {
  cutoff: 1000,
  decay: 0.2,
  engine: 'SUBTRACTIVE'
};

export const SynthesizerTerminal: React.FC = React.memo(() => {
  const { lockStatus } = usePluginState('synth', 'PRO');
  const hostRef = React.useRef(new WasmPluginHost());
  const [isLoaded, setIsLoaded] = useState(false);
  const [cutoff, setCutoff] = useState(DEFAULT_SYNTH_PARAMS.cutoff);
  const [decay, setDecay] = useState(DEFAULT_SYNTH_PARAMS.decay);
  const [engine, setEngine] = useState(DEFAULT_SYNTH_PARAMS.engine);

  useEffect(() => {
    const host = hostRef.current;
    // Load plugin on startup
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

  const validateAndSetParameter = (param: string, value: number | string) => {
    const host = hostRef.current;
    if (!isLoaded || !host) {
      console.warn(`Attempted to set ${param} before synth is loaded`);
      return false;
    }

    // Basic validation based on known parameter ranges
    if (param === 'cutoff' && (typeof value !== 'number' || value < 20 || value > 20000)) return false;
    if (param === 'decay' && (typeof value !== 'number' || value < 0 || value > 1)) return false;

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

  return (
    <div className={`p-6 bg-[#161616] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} text-neutral-300 font-mono shadow-2xl`}>
      <div className="mb-4 -mt-2">
        <MoaAssistant pluginId="synth" placeholder="MOA: z. B. 'Spiele Note 440 Hz'" />
      </div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-sm font-black uppercase tracking-widest text-neutral-400 flex items-center gap-2">
            <Waves className="w-4 h-4 text-violet-400" /> Synth MONK
        </h3>
        <select value={engine} onChange={handleEngineChange} className="bg-black text-white text-xs p-1 rounded" disabled={!isLoaded}>
            <option value="SUBTRACTIVE">SUBTRACTIVE</option>
            <option value="FM">FM</option>
            <option value="WAVETABLE">WAVETABLE</option>
        </select>
      </div>

      {!isLoaded && <div className="text-xs text-yellow-500 mb-4">Loading Synthesizer...</div>}

      <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <label className="text-[10px] text-neutral-500" htmlFor="synth-filter-cutoff">FILTER CUTOFF</label>
            <input id="synth-filter-cutoff" type="range" min="20" max="20000" value={cutoff} onChange={e => handleCutoffChange(Number(e.target.value))} className="w-full accent-violet-500" disabled={!isLoaded} />
            <div className="text-xs">{cutoff} Hz</div>
          </div>
          <div className="space-y-4">
            <label className="text-[10px] text-neutral-500" htmlFor="synth-adsr-decay">ADSR DECAY</label>
            <input id="synth-adsr-decay" type="range" min="0" max="1" step="0.01" value={decay} onChange={e => handleDecayChange(Number(e.target.value))} className="w-full accent-violet-500" disabled={!isLoaded} />
          </div>
      </div>
    </div>
  );
});
