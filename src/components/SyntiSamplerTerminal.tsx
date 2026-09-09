import React, { useState } from 'react';
import { Waves, Speaker, Grid3X3 } from 'lucide-react';
import { SynthesizerTerminal } from './SynthesizerTerminal';
import { SamplerTerminal } from './SamplerTerminal';
import { McpTerminal } from './McpTerminal';

/**
 * syntisamplerMONK (ARCH-PLUGIN-002)
 * ===================================
 * Bewusste Zusammenlegung von synthesizerMONK + samplerMONK + den
 * Synth/Sampler-Steuerungsfunktionen des mcpMONK. Kein Funktionsverlust:
 * alle drei Terminals bleiben vollständig erhalten und sind als Sektionen
 * in einem gemeinsamen Terminal erreichbar.
 */
type Tab = 'synth' | 'sampler' | 'mpc';

const TABS: { id: Tab; label: string; icon: typeof Waves; hint: string }[] = [
  { id: 'synth', label: 'SYNTH', icon: Waves, hint: 'Synthesizer' },
  { id: 'sampler', label: 'SAMPLER', icon: Speaker, hint: 'Sample Playback' },
  { id: 'mpc', label: 'MPC', icon: Grid3X3, hint: 'Pads + Sequencer' },
];

export const SyntiSamplerTerminal = React.memo(function SyntiSamplerTerminal() {
  const [tab, setTab] = useState<Tab>('synth');

  return (
    <div className="w-full flex flex-col gap-3">
      <div className="flex items-center gap-2" role="tablist" aria-label="syntisamplerMONK Sektionen">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={t.hint}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-[10px] font-bold tracking-widest transition-all cursor-pointer ${
                active
                  ? 'bg-cyan-500/10 border-cyan-400/60 text-cyan-200'
                  : 'bg-neutral-900/60 border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="w-full">
        {tab === 'synth' && <SynthesizerTerminal />}
        {tab === 'sampler' && <SamplerTerminal />}
        {tab === 'mpc' && <McpTerminal />}
      </div>
    </div>
  );
});
