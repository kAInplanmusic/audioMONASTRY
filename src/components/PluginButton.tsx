import React from 'react';
import { LucideIcon } from 'lucide-react';
import { getPluginThemeClass } from '../utils/pluginTheme';

interface PluginButtonProps {
  id: string;
  icon: LucideIcon;
  short: string;
  isActive: boolean;
  state: string;
  onClick: () => void;
  onDoubleClick?: () => void;
}

export const PluginButton = React.memo(({ id, icon: Icon, short, isActive, state, onClick, onDoubleClick }: PluginButtonProps) => {
  const accentStyle = isActive && state !== 'PRO'
    ? { borderColor: 'var(--monk-accent)', boxShadow: '0 0 14px var(--monk-glow-accent)' }
    : undefined;
  return (
    <button type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={short + (isActive ? ' (Klick: aus, Doppelklick: PRO)' : ' (Klick: an)')}
      aria-label={`${short} Plugin ${isActive ? 'aktiv' : 'inaktiv'}`}
      aria-pressed={isActive}
      className={`group flex flex-col items-center justify-center h-14 md:h-16 rounded-lg border transition-all duration-200 select-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${getPluginThemeClass(id)} ${
        isActive
          ? state === 'PRO'
            ? 'bg-linear-to-br from-purple-600/25 to-fuchsia-600/20 border-purple-500/80 shadow-[0_0_18px_rgba(236,72,153,0.35)] hover:shadow-[0_0_26px_rgba(236,72,153,0.5)]'
            : 'bg-cyan-900/30 border-cyan-400/70 animate-pulse hover:shadow-[0_0_22px_rgba(34,211,238,0.45)]'
          : 'bg-black/50 border-neutral-800 hover:border-cyan-400/50 hover:bg-neutral-900/70 hover:-translate-y-0.5 active:translate-y-0'
      }`}
      style={accentStyle}
    >
      <Icon size={20} className={`transition-colors duration-200 ${isActive ? (state === 'PRO' ? 'text-fuchsia-300' : 'text-cyan-300') : 'text-neutral-400 group-hover:text-cyan-300'} ${isActive ? 'drop-shadow-[0_0_6px_rgba(34,211,238,0.5)]' : ''}`} style={isActive && state !== 'PRO' ? { color: 'var(--monk-accent)' } : undefined} />
      <span className={`text-[9px] font-bold mt-1.5 uppercase tracking-wide transition-colors duration-200 ${isActive ? (state === 'PRO' ? 'text-fuchsia-200' : 'text-cyan-200') : 'text-neutral-500 group-hover:text-cyan-200'}`} style={isActive && state !== 'PRO' ? { color: 'var(--monk-accent)' } : undefined}>{short}</span>
    </button>
  );
});
