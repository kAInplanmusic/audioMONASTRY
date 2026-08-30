import React from 'react';
import { Database, Trash2 } from 'lucide-react';
import { useSession } from '../context/SessionContext';
import { DropTarget } from './DropTarget';

export const Scratchpad: React.FC = () => {
  const { scratchpadItems, addToScratchpad, removeFromScratchpad } = useSession();

  return (
    <div className="relative group">
      <button type="button" className="flex items-center gap-2 bg-[#1a1a1a] border border-neutral-800 rounded-lg p-2 hover:border-sky-500 transition-colors">
        <Database className="w-4 h-4 text-sky-400" />
        <span className="text-[10px] font-bold text-sky-200">SCRATCHPAD ({scratchpadItems.length})</span>
      </button>

      {/* Flyout panel */}
      <div className="absolute top-full mt-2 right-0 w-64 bg-[#111] border border-neutral-800 rounded-lg shadow-2xl p-4 hidden group-hover:block z-50">
        <h4 className="text-[10px] font-bold text-neutral-500 uppercase mb-3">Live Session Assets</h4>
        <DropTarget
            onDrop={addToScratchpad}
            className="border-2 border-dashed border-neutral-800 rounded-lg p-4 text-center text-[10px] text-neutral-600 mb-4 hover:border-sky-500"
        >
            DRAG SAMPLES HERE
        </DropTarget>
        <div className="space-y-2 max-h-40 overflow-y-auto">
            {scratchpadItems.map(item => (
                <div key={item.id} className="flex items-center justify-between bg-[#1a1a1a] p-2 rounded text-[10px] font-mono">
                    <span className="truncate w-3/4">{item.name}</span>
                    <button type="button" onClick={() => removeFromScratchpad(item.id)} className="text-red-500"><Trash2 className="w-3 h-3" /></button>
                </div>
            ))}
        </div>
      </div>
    </div>
  );
};
