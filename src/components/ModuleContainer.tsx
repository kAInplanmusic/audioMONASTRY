import React from 'react';
import { ModuleState } from '../context/ModuleStateContext';
import { usePluginManager } from '../context/PluginManagerContext';
import { getPluginThemeClass, getHardwareSkinClass } from '../utils/pluginTheme';
import { webRTCManager } from '../utils/WebRTCManager';

interface ModuleContainerProps {
  id: string;
  name: string;
  state: ModuleState;
  children: React.ReactNode;
  /** P0-3: Close-/OFF-Button – ruft setModuleState(id,'OFF') + releaseLock auf. */
  onClose?: () => void;
  /** P1-4: „⧉ In Zwischenablage senden" – kopiert Plugin-State/Config als JSON. */
  onCopyToClipboard?: () => void;
}

export const ModuleContainer = React.memo(({ id, name, state, children, onClose, onCopyToClipboard }: ModuleContainerProps) => {
  const { pluginLocks } = usePluginManager();
  const isLocked = pluginLocks[id]?.active && pluginLocks[id]?.lockedBy !== webRTCManager.userId;

  if (state === 'OFF') return null;

  return (
    <div className={`monk-panel relative overflow-hidden transition-all duration-300 edge-inset ${getPluginThemeClass(id)} ${getHardwareSkinClass(id)} ${
      state === 'AUTO_AI' ? 'ring-1 ring-orange-400/30 animate-pulse' : state === 'PRO' ? 'ring-1 ring-purple-500/20' : ''
    }`}>
      {/* P1-2: Akzent-Hairline oben, folgt dem Plugin-Skin (--monk-accent). */}
      <div
        aria-hidden
        className="absolute top-0 left-0 right-0 h-0.5 opacity-80"
        style={{ background: 'linear-gradient(90deg, transparent, var(--monk-accent), transparent)' }}
      />
      <div className="flex justify-between items-center mb-3 pb-2 pt-1 border-b border-white/5">
        <div className="flex items-center gap-2">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: 'var(--monk-accent)', boxShadow: '0 0 6px var(--monk-glow-accent)' }}
          />
          <h2 className="text-xs font-bold uppercase tracking-widest text-neutral-300">{name}</h2>
        </div>
        <div className="flex items-center gap-2">
          {isLocked && <span className="text-[10px] text-red-400 font-bold uppercase tracking-wider">Locked · Remote</span>}
          {onCopyToClipboard && (
            <button
              type="button"
              onClick={onCopyToClipboard}
              aria-label={`${name} in Zwischenablage senden`}
              className="px-2 py-0.5 rounded-md border border-neutral-700 text-neutral-400 text-[10px] font-bold uppercase tracking-wider hover:text-amber-300 hover:border-amber-400/60 hover:bg-amber-500/10 transition-colors cursor-pointer"
            >
              ⧉ JSON
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={`${name} schließen (OFF)`}
              className="px-2 py-0.5 rounded-md border border-neutral-700 text-neutral-400 text-[10px] font-bold uppercase tracking-wider hover:text-red-300 hover:border-red-500/60 hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              ✕ OFF
            </button>
          )}
        </div>
      </div>

      {state === 'AUTO_AI' && (
        <div className="absolute top-4 right-16 px-2 py-0.5 bg-orange-500/90 rounded-full text-[9px] font-bold text-white uppercase shadow-[0_0_12px_-2px_rgba(249,115,22,0.6)]">AI Active</div>
      )}

      <div className={isLocked ? 'pointer-events-none opacity-50' : ''}>
        {children}
      </div>
    </div>
  );
});
