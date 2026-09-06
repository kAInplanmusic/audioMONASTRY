/**
 * dropMONK – DJ Transition Panel Component
 * ========================================
 * Channel crossfader with style selection
 */

import React, { useState } from 'react';
import { ChevronRight, Play } from 'lucide-react';
import { useDropContext } from '../../context/DropContext';
import type { DropProfile } from '../../core/drop';
import { DROP_PROFILES } from '../../core/drop';

const TRANSITION_STYLES: DropProfile[] = DROP_PROFILES.filter((p) =>
  ['dj_transition', 'transition'].includes(p.category)
);

const CHANNELS = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5 (Master)'];

export const DJTransitionPanel: React.FC = () => {
  const {
    selectedStartChannel,
    selectedEndChannel,
    setSelectedChannels,
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
    selectedProfile,
    selectProfile,
    triggerDjTransition,
    transitionInProgress,
  } = useDropContext();

  const [selectedStyle, setSelectedStyle] = useState<DropProfile>(TRANSITION_STYLES[0]);

  return (
    <div className="space-y-6">
      {/* Channel Selector */}
      <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-5">
        <p className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-4">
          Channel Selection
        </p>

        <div className="grid grid-cols-2 gap-4">
          {/* Start Channel */}
          <div>
            <p className="text-[9px] text-neutral-400 font-mono mb-2">FROM</p>
            <select
              value={selectedStartChannel || ''}
              onChange={(e) => setSelectedChannels(e.target.value, selectedEndChannel)}
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm font-mono text-neutral-200 focus:border-rose-500/50 focus:outline-none"
            >
              <option value="">Select start...</option>
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>
          </div>

          {/* End Channel */}
          <div>
            <p className="text-[9px] text-neutral-400 font-mono mb-2">TO</p>
            <select
              value={selectedEndChannel || ''}
              onChange={(e) => setSelectedChannels(selectedStartChannel, e.target.value)}
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm font-mono text-neutral-200 focus:border-rose-500/50 focus:outline-none"
            >
              <option value="">Select end...</option>
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Transition Style Selection */}
      <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-5">
        <p className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-3">
          Transition Style
        </p>

        <div className="grid grid-cols-1 gap-2">
          {TRANSITION_STYLES.map((style) => (
            <button
              key={style.id}
              onClick={() => {
                setSelectedStyle(style);
                selectProfile(style);
              }}
              className={`p-3 rounded-lg border text-left transition-all ${
                selectedStyle.id === style.id
                  ? 'bg-rose-500/20 border-rose-500/60 ring-1 ring-rose-500/30'
                  : 'bg-neutral-900/50 border-neutral-800 hover:bg-neutral-800'
              }`}
            >
              <p className="text-[12px] font-bold text-neutral-100">{style.name}</p>
              <p className="text-[9px] text-neutral-500 mt-1">{style.description}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Transition Info */}
      {selectedStartChannel && selectedEndChannel && (
        <div className="bg-gradient-to-br from-rose-900/20 to-black border border-rose-500/30 rounded-lg p-4">
          <p className="text-[9px] text-neutral-400 font-mono mb-2">TRANSITION PREVIEW</p>
          <div className="flex items-center justify-between gap-2">
            <div className="text-center">
              <p className="text-lg font-bold text-rose-300">{selectedStartChannel}</p>
              <p className="text-[9px] text-neutral-500">Fade Out</p>
            </div>
            <ChevronRight className="w-5 h-5 text-rose-500/60" />
            <div className="text-center">
              <p className="text-lg font-bold text-rose-300">{selectedEndChannel}</p>
              <p className="text-[9px] text-neutral-500">Fade In</p>
            </div>
          </div>
          <div className="mt-3 bg-neutral-900/50 rounded px-2 py-1">
            <p className="text-[10px] text-neutral-400">
              <span className="text-rose-300 font-bold">Style:</span> {selectedStyle.name}
            </p>
          </div>
        </div>
      )}

      {/* Execute Button */}
      <button
        onClick={() =>
          selectedStartChannel &&
          selectedEndChannel &&
          triggerDjTransition(selectedStartChannel, selectedEndChannel, selectedStyle)
        }
        disabled={!selectedStartChannel || !selectedEndChannel || transitionInProgress}
        className={`w-full py-4 px-4 rounded-lg font-bold tracking-widest flex items-center justify-center gap-2 transition-all ${
          transitionInProgress
            ? 'bg-rose-500/30 text-rose-300 border-2 border-rose-500 animate-pulse'
            : selectedStartChannel && selectedEndChannel
              ? 'bg-rose-500/20 text-rose-200 border-2 border-rose-500/60 hover:bg-rose-500/30 active:scale-95'
              : 'bg-neutral-900/50 text-neutral-500 border-2 border-neutral-700 cursor-not-allowed'
        }`}
      >
        <Play className="w-4 h-4" />
        {transitionInProgress ? 'TRANSITIONING...' : '▶ EXECUTE TRANSITION'}
      </button>
    </div>
  );
};
