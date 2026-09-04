/**
 * dropMONK – Sampler Top Panel Component
 * ====================================
 * Generate drops for sampler tops
 */

import React, { useState } from 'react';
import { Play } from 'lucide-react';
import { useDropContext } from '../../context/DropContext';
import type { DropProfile } from '../../core/drop';
import { DROP_PROFILES } from '../../core/drop';

const OUTPUT_CHANNELS = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5 (Master)'];

export const SamplerTopPanel: React.FC = () => {
  const { selectedProfile, selectProfile, executeDrop, isExecuting } = useDropContext();
  const [outputChannel, setOutputChannel] = useState('CH1');

  const topProfiles = DROP_PROFILES.filter((p) => p.tags?.includes('percussive'));

  return (
    <div className="space-y-6">
      {/* Sample Selection */}
      <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-5">
        <p className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-3">
          Top Style
        </p>
        <div className="grid grid-cols-1 gap-2">
          {topProfiles.map((profile) => (
            <button
              key={profile.id}
              onClick={() => selectProfile(profile)}
              className={`p-3 rounded-lg border text-left transition-all ${
                selectedProfile?.id === profile.id
                  ? 'bg-rose-500/20 border-rose-500/60'
                  : 'bg-neutral-900/50 border-neutral-800 hover:bg-neutral-800'
              }`}
            >
              <p className="text-[12px] font-bold text-neutral-100">{profile.name}</p>
              <p className="text-[9px] text-neutral-500 mt-1">{profile.description}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Output Channel */}
      <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-4">
        <label className="block mb-2">
          <p className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-2">
            Output Channel
          </p>
          <select
            value={outputChannel}
            onChange={(e) => setOutputChannel(e.target.value)}
            className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm font-mono text-neutral-200 focus:border-rose-500/50 focus:outline-none"
          >
            {OUTPUT_CHANNELS.map((ch) => (
              <option key={ch} value={ch}>
                {ch}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Parameters Preview */}
      {selectedProfile && (
        <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-4">
          <p className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-2">
            Top Info
          </p>
          <p className="text-[11px] text-neutral-300">
            <span className="text-rose-300 font-bold">Duration:</span> {selectedProfile.dropDuration}ms
          </p>
          <p className="text-[11px] text-neutral-300 mt-1">
            <span className="text-rose-300 font-bold">Target Plugins:</span>{' '}
            {selectedProfile.parameterSequence.length}
          </p>
        </div>
      )}

      {/* Generate Button */}
      <button
        onClick={() => selectedProfile && executeDrop(selectedProfile, false)}
        disabled={!selectedProfile || isExecuting}
        className={`w-full py-4 px-4 rounded-lg font-bold tracking-widest flex items-center justify-center gap-2 transition-all ${
          isExecuting
            ? 'bg-rose-500/30 text-rose-300 border-2 border-rose-500 animate-pulse'
            : selectedProfile
              ? 'bg-rose-500/20 text-rose-200 border-2 border-rose-500/60 hover:bg-rose-500/30 active:scale-95'
              : 'bg-neutral-900/50 text-neutral-500 border-2 border-neutral-700 cursor-not-allowed'
        }`}
      >
        <Play className="w-4 h-4" />
        {isExecuting ? 'GENERATING...' : '▶ GENERATE TOP'}
      </button>
    </div>
  );
};
