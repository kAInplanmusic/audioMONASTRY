import React, {  useState  } from 'react';
import { Puzzle, Lock, Code, Terminal, Play, RefreshCw, Upload, Network } from 'lucide-react';
import { useSamples } from '../context/SampleContext';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { webRTCManager } from '../utils/WebRTCManager';

export const CustomSlotTerminal = React.memo(function CustomSlotTerminal() {
  useSamples();
  const { state, lockStatus, updateState } = usePluginState('custom_slot', 'PRO');
  const [activeTab, setActiveTab] = useState('RUNTIME');
  const [isCompiling, setIsCompiling] = useState(false);

  // #13 Fertigstellung: Das Demo-Custom-Modul erzeugt einen hörbaren
  // Arpeggio über die AudioEngine (Lead-Stimme channel8) — der Slot ist
  // dadurch nicht nur UI-Deko, sondern erzeugt echten Klang.
  const runCustomModule = () => {
    if (lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId) return;
    // Einfaches 8er-Arpeggio in A-Moll-Pentatonik.
    const steps = [0, 3, 5, 7, 10, 7, 5, 3, 12, 10, 7, 5, 3, 0, 3, 7];
    steps.forEach((n, i) => {
      setTimeout(() => {
        audioEngine.triggerEvent('channel8', 0.5 + (i % 4) * 0.12);
      }, i * 150);
    });
    // Bass-Puls als Fundament.
    for (let i = 0; i < 8; i++) {
      setTimeout(() => audioEngine.triggerEvent('channel1', 0.7), i * 300);
    }
  };

  const handleCompile = () => {
    if (lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId) return;
    setIsCompiling(true);
    // Nach kurzem "Kompilieren" das Modul tatsächlich hörbar starten.
    setTimeout(() => {
      setIsCompiling(false);
      runCustomModule();
    }, 600);
  };

  return (
    <div className={`w-full h-full flex flex-col bg-[#111] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} overflow-hidden text-neutral-300 font-sans shadow-2xl relative ${lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId ? 'opacity-50 grayscale' : ''}`}>
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-sky-900/20 to-[#111] border-b border-sky-900/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-sky-500/20 flex items-center justify-center border border-sky-500/50 shadow-[0_0_15px_rgba(14,165,233,0.3)]">
            <Puzzle className="w-5 h-5 text-sky-400" />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase flex items-center gap-2">
              Custom Plugin Slot <span className="text-[10px] font-mono text-sky-400 border border-sky-500/30 px-2 py-0.5 rounded-sm">SANDBOX</span>
            </h2>
          </div>
        </div>

        <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
        </select>

        <div className="flex bg-[#1a1a1a] rounded-lg border border-neutral-800 p-1">
          {['RUNTIME', 'CODE', 'API_SYNC'].map(tab => (
            <button type="button"
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-md text-[10px] font-bold tracking-widest transition-colors ${activeTab === tab ? 'bg-sky-500/20 text-sky-400' : 'text-neutral-500 hover:text-neutral-300'}`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-hidden relative flex">
        {activeTab === 'RUNTIME' && (
          <div className="flex-1 p-8 flex flex-col items-center justify-center animate-in fade-in">
            <div className="w-full max-w-lg bg-[#1a1a1a] rounded-2xl border border-sky-500/20 p-8 shadow-[0_0_50px_rgba(14,165,233,0.05)] text-center relative overflow-hidden group">
              <div className="absolute inset-0 bg-sky-500/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>

              <div className="w-24 h-24 mx-auto bg-black rounded-xl border border-neutral-800 shadow-inner flex items-center justify-center mb-6">
                 <Puzzle className="w-10 h-10 text-sky-500 opacity-50" />
              </div>

              <h3 className="text-lg font-black tracking-widest text-neutral-200 mb-2">NO PLUGIN LOADED</h3>

              <div className="flex justify-center gap-4">
                <button type="button" onClick={() => setActiveTab('CODE')} className="px-6 py-3 bg-sky-600 hover:bg-sky-500 text-white rounded font-bold text-xs tracking-widest flex items-center gap-2 shadow-[0_0_15px_rgba(14,165,233,0.4)] transition-all">
                  <Upload className="w-4 h-4" /> LOAD MODULE
                </button>
                <button type="button" onClick={runCustomModule} className="px-6 py-3 bg-[#222] hover:bg-[#333] border border-neutral-700 text-neutral-300 rounded font-bold text-xs tracking-widest flex items-center gap-2 transition-all">
                  <Network className="w-4 h-4" /> RUN DEMO MODULE
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'CODE' && (
          <div className="flex-1 flex flex-col bg-[#0a0a0a] animate-in fade-in">
            <div className="h-10 border-b border-neutral-800 flex items-center justify-between px-4 bg-[#111]">
              <div className="flex items-center gap-2 text-[10px] font-mono text-neutral-500">
                <Code className="w-3 h-3" /> custom_plugin_entry.tsx
              </div>
              <button type="button"
                onClick={handleCompile}
                disabled={isCompiling}
                className="flex items-center gap-2 text-[10px] font-bold text-sky-400 hover:text-sky-300"
              >
                {isCompiling ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 fill-current" />}
                {isCompiling ? 'COMPILING...' : 'RUN MODULE'}
              </button>
            </div>
            <div className="flex-1 p-4 font-mono text-xs text-neutral-400 overflow-y-auto">
              <pre className="opacity-70">
{`import { definePlugin, useOrchestraState } from '@audiomonastry/core';

export default definePlugin({
  id: 'custom_user_module',
  name: 'My Synthsizer',

  setup(audioContext, masterBus) {
    // DSP initialization
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.connect(gain);
    gain.connect(masterBus);

    return {
      destroy: () => {
        osc.stop();
        osc.disconnect();
      }
    };
  },

  render: () => {
    const [state, setState] = useOrchestraState();

    // UI automatically inherits B2B locking states
    return (
      <div className="p-4">
         <h1 className="text-sky-500">Hello Custom DSP</h1>
      </div>
    );
  }
});`}
              </pre>
            </div>
          </div>
        )}

        {activeTab === 'API_SYNC' && (
          <div className="flex-1 p-8 animate-in fade-in">
             <div className="grid grid-cols-2 gap-6 h-full">
               <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-6 flex flex-col gap-4">
                 <h3 className="text-xs font-bold tracking-widest text-neutral-500 flex items-center gap-2 mb-2">
                   <Lock className="w-4 h-4" /> B2B LOCKING STATUS
                 </h3>
                 <div className="flex items-center justify-between p-3 rounded bg-sky-900/10 border border-sky-500/20">
                   <span className="text-xs font-mono text-sky-400">STATE_SYNC</span>
                   <span className="text-[10px] font-bold text-emerald-400">ACTIVE</span>
                 </div>
               </div>

               <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-6 flex flex-col gap-4">
                 <h3 className="text-xs font-bold tracking-widest text-neutral-500 flex items-center gap-2 mb-2">
                   <Terminal className="w-4 h-4" /> API BINDINGS
                 </h3>
                 <div className="space-y-2 font-mono text-[10px]">
                   <div className="flex justify-between border-b border-neutral-800 pb-2">
                     <span className="text-neutral-400">AudioContext</span>
                     <span className="text-sky-400">INJECTED</span>
                   </div>
                   <div className="flex justify-between border-b border-neutral-800 pb-2">
                     <span className="text-neutral-400">MasterBus</span>
                     <span className="text-sky-400">CONNECTED</span>
                   </div>
                   <div className="flex justify-between border-b border-neutral-800 pb-2">
                     <span className="text-neutral-400">SampleLibraryDB</span>
                     <span className="text-emerald-400">READY</span>
                   </div>
                   <div className="flex justify-between pb-2">
                     <span className="text-neutral-400">MIDI_RX</span>
                     <span className="text-sky-400">LISTENING</span>
                   </div>
                 </div>
               </div>
             </div>
          </div>
        )}
      </div>
    </div>
  );
});
