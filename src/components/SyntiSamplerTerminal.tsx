import React, { useState } from 'react';
import { SynthesizerTerminal } from './SynthesizerTerminal';
import { SamplerTerminal } from './SamplerTerminal';
import { McpTerminal } from './McpTerminal';
import { AmCard } from './am/amUi';

/**
 * syntisamplerMONK (ARCH-PLUGIN-002)
 * ===================================
 * Bewusste Zusammenlegung von synthesizerMONK + samplerMONK + den
 * Synth/Sampler-Steuerungsfunktionen des mcpMONK. Kein Funktionsverlust:
 * alle drei Terminals bleiben vollständig erhalten und sind als Sektionen
 * in einem gemeinsamen Terminal erreichbar.
 *
 * Rack-Modul (Vorlage uiübersichtapp, Zeile 05): links die Sektionswahl,
 * daneben die Karten der gewählten Sektion als eine kompakte Zeile.
 */
type Tab = 'synth' | 'sampler' | 'mpc';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'synth', label: 'SYNTH', hint: 'Synthesizer' },
  { id: 'sampler', label: 'SAMPLE', hint: 'Sample Playback' },
  { id: 'mpc', label: 'MPC', hint: 'Pads + Sequencer' },
];

export const SyntiSamplerTerminal = React.memo(function SyntiSamplerTerminal() {
  const [tab, setTab] = useState<Tab>('synth');

  return (
    <div className="am-c-wrap am-c-ui">
      <AmCard title="Sektion" style={{ width: 104, flex: 'none' }}>
        <div className="am-c-vseg" role="tablist" aria-label="syntisamplerMONK Sektionen">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={t.hint}
                className={active ? 'am-on' : ''}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </AmCard>
      {tab === 'synth' && <SynthesizerTerminal />}
      {tab === 'sampler' && <SamplerTerminal />}
      {tab === 'mpc' && <McpTerminal />}
    </div>
  );
});
