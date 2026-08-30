import React from 'react';
import { ModuleState } from '../context/ModuleStateContext';
import { usePluginManager } from '../context/PluginManagerContext';

interface ModuleContainerProps {
  id: string;
  name: string;
  state: ModuleState;
  children: React.ReactNode;
}

export const ModuleContainer = React.memo(({ id, name, state, children }: ModuleContainerProps) => {
  const { pluginLocks } = usePluginManager();
  const isLocked = pluginLocks[id]?.active && pluginLocks[id]?.lockedBy !== 'localUser';

  if (state === 'OFF') return null;

  return (
    <div className={`monk-panel relative overflow-hidden transition-all duration-300 edge-inset ${
      state === 'AUTO_AI' ? 'ring-1 ring-orange-400/30 animate-pulse' : state === 'PRO' ? 'ring-1 ring-purple-500/20' : ''
    }`}>
      <div className="flex justify-between items-center mb-3 pb-2 border-b border-white/5">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/70 shadow-[0_0_6px_rgba(34,211,238,0.6)]" />
          <h2 className="text-xs font-bold uppercase tracking-widest text-neutral-300">{name}</h2>
        </div>
        {isLocked && <span className="text-[10px] text-red-400 font-bold uppercase tracking-wider">Locked · Remote</span>}
      </div>
      
      {state === 'AUTO_AI' && (
        <div className="absolute top-4 right-4 px-2 py-0.5 bg-orange-500/90 rounded-full text-[9px] font-bold text-white uppercase shadow-[0_0_12px_-2px_rgba(249,115,22,0.6)]">AI Active</div>
      )}
      
      <div className={isLocked ? 'pointer-events-none opacity-50' : ''}>
        {children}
      </div>
    </div>
  );
});
