import React from 'react';
import { Power, Copy, GripVertical } from 'lucide-react';
import { ModuleState } from '../context/ModuleStateContext';
import { getPluginThemeClass } from '../utils/pluginTheme';
import { MONK_DRAG_MIME, MONK_SCRATCH_MIME, readMonkDragItem, type ScratchpadDragItem } from '../core/session/sessionScratchpad';

interface RackRowProps {
  id: string;
  name: string;
  short: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  state: ModuleState;
  lockedByOther: boolean;
  onToggle: () => void;
  onPromote: () => void;
  /** P1-4: „In Zwischenablage senden" – kopiert Plugin-State/Config als JSON. */
  onCopy?: () => void;
  /** P1-4: Scratchpad-Eintrag auf dieses Modul ziehen → laden/anwenden. */
  onLoadScratch?: (entry: ScratchpadDragItem) => void;
  children?: React.ReactNode;
}

/**
 * RackRow – ein Modulstreifen im audioMONASTRY-Rack-Layout (Designvorlage).
 * Links Icon-Kachel + Name, rechts runder Power-Button + ⋮-Menü.
 * Aktiv/Aufgeklappt = Plugin-Akzent (--monk-accent); OFF = gedimmt.
 * P1-4: Drag-Handle zieht das Modul in den Zwischenspeicher; die Zeile
 * akzeptiert Scratchpad-Einträge als Drop-Ziel (Laden aufs Modul).
 */
export const RackRow = React.memo(function RackRow({
  id,
  name,
  short,
  icon: Icon,
  state,
  lockedByOther,
  onToggle,
  onPromote,
  onCopy,
  onLoadScratch,
  children,
}: RackRowProps) {
  const active = state !== 'OFF';
  const pro = state === 'PRO';

  return (
    <section
      id={`rack-${id}`}
      className={`rounded-xl border transition-all duration-300 ${getPluginThemeClass(id)} ${
        active
          ? 'bg-cyan-950/10'
          : 'border-neutral-800/80 bg-black/50 opacity-70 hover:opacity-100'
      }`}
      style={active ? { borderColor: 'var(--monk-accent)', boxShadow: '0 0 24px -8px var(--monk-glow-accent)' } : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MONK_SCRATCH_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const entry = readMonkDragItem(e, MONK_SCRATCH_MIME);
        if (entry && onLoadScratch) {
          e.preventDefault();
          onLoadScratch(entry);
        }
      }}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(MONK_DRAG_MIME, JSON.stringify({ type: 'module', id, name, state } satisfies ScratchpadDragItem));
            e.dataTransfer.effectAllowed = 'copy';
          }}
          title={`${name} in den Zwischenspeicher ziehen`}
          aria-label={`${name} in den Zwischenspeicher ziehen`}
          className="shrink-0 text-neutral-700 hover:text-neutral-400 cursor-grab active:cursor-grabbing p-0.5"
        >
          <GripVertical size={14} />
        </span>
        <button
          type="button"
          onClick={onToggle}
          onDoubleClick={onPromote}
          title={short}
          aria-label={`${name} ${active ? 'aktiv' : 'inaktiv'}`}
          aria-pressed={active}
          className={`w-10 h-10 shrink-0 rounded-lg border flex items-center justify-center transition-all cursor-pointer ${
            pro
              ? 'bg-fuchsia-600/20 border-fuchsia-500/70 text-fuchsia-300 shadow-[0_0_14px_rgba(217,70,239,0.35)]'
              : active
                ? 'bg-cyan-900/40 text-cyan-300'
                : 'bg-black/60 border-neutral-800 text-neutral-500 hover:text-cyan-300 hover:border-cyan-400/40'
          }`}
          style={active && !pro ? { borderColor: 'var(--monk-accent)', boxShadow: '0 0 12px var(--monk-glow-accent)', color: 'var(--monk-accent)' } : undefined}
        >
          <Icon size={18} />
        </button>

        <div className="min-w-0 flex-1">
          <h3 className={`text-sm font-black tracking-[0.25em] uppercase truncate ${active ? 'text-neutral-100' : 'text-neutral-500'}`}>
            {name}
          </h3>
          <div className="text-[9px] font-mono tracking-widest flex items-center gap-2">
            <span className={active ? 'text-cyan-400' : 'text-neutral-600'} style={active ? { color: 'var(--monk-accent)' } : undefined}>{state}</span>
            {lockedByOther && <span className="text-red-400 font-bold">LOCKED · REMOTE</span>}
          </div>
        </div>

        <button
          type="button"
          onClick={onToggle}
          title={`${short} Power`}
          aria-label={`${name} Power`}
          className={`w-9 h-9 shrink-0 rounded-full border flex items-center justify-center transition-all cursor-pointer ${
            active
              ? 'bg-cyan-400/10 text-cyan-300'
              : 'border-neutral-700 text-neutral-600 hover:text-cyan-300 hover:border-cyan-400/40'
          }`}
          style={active ? { borderColor: 'var(--monk-accent)', boxShadow: '0 0 14px var(--monk-glow-accent)', color: 'var(--monk-accent)' } : undefined}
        >
          <Power size={14} />
        </button>
        <button
          type="button"
          onClick={onPromote}
          title={`${short} Menü (PRO/OFF)`}
          aria-label={`${name} Menü`}
          className={`w-9 h-9 shrink-0 rounded-full border flex items-center justify-center text-lg font-black transition-colors cursor-pointer ${
            pro
              ? 'border-fuchsia-500/60 text-fuchsia-300 bg-fuchsia-500/10'
              : 'border-neutral-700 text-neutral-400 hover:text-cyan-300 hover:border-cyan-400/40'
          }`}
        >
          ⋮
        </button>
        {onCopy && (
          <button
            type="button"
            onClick={onCopy}
            title={`${short} in Zwischenablage senden`}
            aria-label={`${name} in Zwischenablage senden`}
            className="w-9 h-9 shrink-0 rounded-full border border-neutral-700 text-neutral-400 hover:text-amber-300 hover:border-amber-400/40 flex items-center justify-center transition-colors cursor-pointer"
          >
            <Copy size={13} />
          </button>
        )}
      </div>

      {active && children && (
        <div className={`px-3 pb-3 border-t border-white/5 ${lockedByOther ? 'pointer-events-none opacity-50' : ''}`}>
          <div className="pt-3">{children}</div>
        </div>
      )}
    </section>
  );
});
