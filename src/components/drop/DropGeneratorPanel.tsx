/**
 * dropMONK – Generator Panel Component
 * ===================================
 * Main interface für Drop-Generierung
 */

import React, { useEffect, useState } from 'react';
import { Zap, RefreshCw, Play } from 'lucide-react';
import { useDropContext } from '../../context/DropContext';
import type { DropProfile } from '../../core/drop';
import { DROP_PROFILES } from '../../core/drop';

export const DropGeneratorPanel: React.FC = () => {
  const {
    selectedProfile,
    selectProfile,
    suggestedProfiles,
    isExecuting,
    executionProgress,
    executeDrop,
  } = useDropContext();

  const [suggestions, setSuggestions] = useState<DropProfile[]>([]);

  // Load initial suggestions
  useEffect(() => {
    setSuggestions(DROP_PROFILES.slice(0, 4));
  }, []);

  return (
    <div className="space-y-6">
      {/* Main DROP Button */}
      <div className="bg-gradient-to-br from-rose-900/30 to-black border border-rose-500/30 rounded-xl p-8 text-center">
        <button
          onClick={() => selectedProfile && executeDrop(selectedProfile, false)}
          disabled={!selectedProfile || isExecuting}
          className={`w-full py-8 px-6 rounded-lg font-black text-2xl tracking-widest transition-all flex items-center justify-center gap-3 ${
            isExecuting
              ? 'bg-rose-500/30 text-rose-300 border-2 border-rose-500 animate-pulse'
              : selectedProfile
                ? 'bg-rose-500/20 text-rose-200 border-2 border-rose-500/60 hover:bg-rose-500/30 active:scale-95'
                : 'bg-neutral-900/50 text-neutral-500 border-2 border-neutral-700 cursor-not-allowed'
          }`}
        >
          <Play className="w-6 h-6" />
          {isExecuting ? `DROPPING... ${(executionProgress * 100).toFixed(0)}%` : '▼ DROP GENERATE ▼'}
        </button>
      </div>

      {/* Progress Bar */}
      {isExecuting && (
        <div className="space-y-2">
          <div className="w-full h-2 bg-neutral-900 rounded-full overflow-hidden">
            <div
              className="h-full bg-rose-500 transition-all duration-100"
              style={{ width: `${executionProgress * 100}%` }}
            />
          </div>
          <p className="text-xs text-neutral-400 text-center font-mono">
            {(executionProgress * 100).toFixed(1)}% • {(executionProgress * 4).toFixed(1)}s
          </p>
        </div>
      )}

      {/* Current Selection */}
      {selectedProfile && (
        <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-4">
          <p className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-2">
            Selected Profile
          </p>
          <p className="text-lg font-bold text-rose-300 mb-1">{selectedProfile.name}</p>
          <p className="text-[11px] text-neutral-400">{selectedProfile.description}</p>
          <div className="mt-3 flex gap-2 flex-wrap">
            {selectedProfile.tags?.map((tag) => (
              <span
                key={tag}
                className="px-2 py-1 bg-neutral-800 text-neutral-300 rounded text-[9px] font-mono"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Preset Suggestions */}
      <div>
        <p className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-3">
          Presets
        </p>
        <div className="grid grid-cols-2 gap-2">
          {suggestions.map((profile) => (
            <button
              key={profile.id}
              onClick={() => selectProfile(profile)}
              className={`p-3 rounded-lg border transition-all text-left ${
                selectedProfile?.id === profile.id
                  ? 'bg-rose-500/20 border-rose-500/60 ring-1 ring-rose-500/30'
                  : 'bg-neutral-900/50 border-neutral-800 hover:bg-neutral-800 hover:border-neutral-700'
              }`}
            >
              <p className="text-[12px] font-bold text-neutral-100">{profile.name}</p>
              <p className="text-[9px] text-neutral-500 mt-1">{profile.category}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Quantized Option */}
      <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="w-4 h-4 rounded border-neutral-700"
            onChange={(e) => {
              // TODO: Handle quantized mode toggle
            }}
          />
          <div>
            <p className="text-sm font-bold text-neutral-100">Quantized Recall</p>
            <p className="text-[10px] text-neutral-500">Wait for next 4-bar boundary</p>
          </div>
        </label>
      </div>
    </div>
  );
};
