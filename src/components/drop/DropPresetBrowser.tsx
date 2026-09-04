/**
 * dropMONK – Preset Browser Component
 * ==================================
 * Browse, save, and manage presets
 */

import React, { useState } from 'react';
import { Star, Trash2, Download, Upload } from 'lucide-react';
import { useDropContext } from '../../context/DropContext';

export const DropPresetBrowser: React.FC = () => {
  const { presets, favorites, toggleFavorite, loadPreset, selectProfile, savePreset } =
    useDropContext();
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');

  const filteredPresets = presets.filter((p) => {
    if (showFavoritesOnly && !p.favorite) return false;
    if (filterCategory && p.profile.category !== filterCategory) return false;
    return true;
  });

  const handleSaveNew = async () => {
    if (!newPresetName.trim()) return;
    // Will use selectedProfile from context
    setShowSaveDialog(false);
    setNewPresetName('');
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-3 space-y-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
            className={`flex-1 px-2 py-1 rounded text-[10px] font-bold transition-all ${
              showFavoritesOnly
                ? 'bg-rose-500/30 text-rose-200 border border-rose-500/60'
                : 'bg-neutral-800 text-neutral-300 border border-neutral-700'
            }`}
          >
            <Star className="w-3 h-3 inline mr-1" />
            Favorites
          </button>

          <select
            value={filterCategory || ''}
            onChange={(e) => setFilterCategory(e.target.value || null)}
            className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[10px] text-neutral-300 focus:outline-none"
          >
            <option value="">All Categories</option>
            <option value="buildup">Buildup</option>
            <option value="breakdown">Breakdown</option>
            <option value="transition">Transition</option>
            <option value="fill">Fill</option>
          </select>
        </div>

        <p className="text-[9px] text-neutral-500">
          {filteredPresets.length} preset{filteredPresets.length !== 1 ? 's' : ''} found
        </p>
      </div>

      {/* Presets List */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {filteredPresets.length === 0 ? (
          <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-4 text-center">
            <p className="text-[11px] text-neutral-500">No presets found</p>
          </div>
        ) : (
          filteredPresets.map((preset) => (
            <div
              key={preset.id}
              className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-3 space-y-2"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <p className="text-[12px] font-bold text-neutral-100">{preset.name}</p>
                  <p className="text-[9px] text-neutral-500">
                    {preset.profile.name} • {preset.profile.category}
                  </p>
                </div>
                <button
                  onClick={() => toggleFavorite(preset.id)}
                  className={`p-1 transition-all ${
                    preset.favorite ? 'text-rose-400' : 'text-neutral-600 hover:text-neutral-400'
                  }`}
                >
                  <Star className="w-4 h-4" fill={preset.favorite ? 'currentColor' : 'none'} />
                </button>
              </div>

              <div className="flex gap-1">
                <button
                  onClick={() => loadPreset(preset.id)}
                  className="flex-1 px-2 py-1 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 rounded text-[9px] font-mono text-rose-200 transition-all"
                >
                  Load
                </button>
                <button
                  onClick={() => {
                    loadPreset(preset.id);
                    selectProfile(preset.profile);
                  }}
                  className="flex-1 px-2 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded text-[9px] font-mono text-neutral-300 transition-all"
                >
                  Select
                </button>
                <button className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded text-neutral-400 hover:text-neutral-300 transition-all">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>

              {preset.tags && preset.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {preset.tags.map((tag) => (
                    <span key={tag} className="px-1 py-0.5 bg-neutral-800 text-[8px] text-neutral-400 rounded">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <p className="text-[8px] text-neutral-600">
                Used {preset.usageCount || 0} times
              </p>
            </div>
          ))
        )}
      </div>

      {/* Export/Import */}
      <div className="flex gap-2">
        <button className="flex-1 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded text-[10px] font-mono text-neutral-300 flex items-center justify-center gap-2 transition-all">
          <Download className="w-3 h-3" />
          Export
        </button>
        <button className="flex-1 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded text-[10px] font-mono text-neutral-300 flex items-center justify-center gap-2 transition-all">
          <Upload className="w-3 h-3" />
          Import
        </button>
      </div>
    </div>
  );
};
