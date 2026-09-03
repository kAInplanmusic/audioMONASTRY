/**
 * dropMONK – Terminal Component
 * ============================
 * Main UI container for Drop Generation & DJ Control
 */

import React, { useState } from 'react';
import { Power, Sparkles } from 'lucide-react';
import { useDropContext, DropProvider } from '../context/DropContext';
import { DropGeneratorPanel } from './drop/DropGeneratorPanel';
import { DJTransitionPanel } from './drop/DJTransitionPanel';
import { SamplerTopPanel } from './drop/SamplerTopPanel';
import { AiChatPanel } from './drop/AiChatPanel';
import { DropPresetBrowser } from './drop/DropPresetBrowser';
import type { DropMode } from '../context/DropContext';

const DropTerminalContent = React.memo(function DropTerminalContent() {
  const { mode, setMode } = useDropContext();
  const [showPresets, setShowPresets] = useState(false);

  const modes: Array<{ id: DropMode; label: string; description: string }> = [
    { id: 'generator', label: 'Generator', description: 'Generate drops from presets or AI' },
    { id: 'dj_transition', label: 'DJ Transition', description: 'Smooth channel crossfades' },
    { id: 'sampler_top', label: 'Sampler Top', description: 'Create punchy tops on demand' },
  ];

  return (
    <div className="w-full h-full flex flex-col bg-gradient-to-br from-neutral-950 via-neutral-900 to-black border border-neutral-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-neutral-900/80 to-black border-b border-neutral-800 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 bg-rose-500 rounded-full animate-pulse" />
            <h2 className="text-xl font-black tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-rose-400 to-pink-400">
              dropMONK
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowPresets(!showPresets)}
              className="px-3 py-1 text-[10px] font-bold text-neutral-400 hover:text-neutral-200 transition-all"
            >
              {showPresets ? 'Generator' : 'Presets'}
            </button>
          </div>
        </div>

        {/* Mode Selector */}
        <div className="flex gap-2">
          {modes.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              title={m.description}
              className={`px-4 py-2 rounded-lg font-mono text-[10px] font-bold tracking-wide transition-all ${
                mode === m.id
                  ? 'bg-rose-500/30 text-rose-200 border border-rose-500/60'
                  : 'bg-neutral-900/50 text-neutral-400 border border-neutral-800 hover:bg-neutral-800'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {showPresets ? (
          <DropPresetBrowser />
        ) : (
          <div className="space-y-6">
            {/* Mode Content */}
            {mode === 'generator' && <DropGeneratorPanel />}
            {mode === 'dj_transition' && <DJTransitionPanel />}
            {mode === 'sampler_top' && <SamplerTopPanel />}

            {/* AI Chat (Always visible, collapsible) */}
            <div className="border-t border-neutral-800 pt-6">
              <p className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-4">
                <Sparkles className="w-3 h-3 inline mr-2" />
                AI Assistant
              </p>
              <AiChatPanel />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * Main DropTerminal Component
 * Wrapped with DropProvider
 */
export const DropTerminal = React.memo(function DropTerminal() {
  return (
    <DropProvider>
      <DropTerminalContent />
    </DropProvider>
  );
});
