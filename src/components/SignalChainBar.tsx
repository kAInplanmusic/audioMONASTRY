import React from 'react';
import { ChevronRight } from 'lucide-react';
import { SIGNAL_CHAIN } from '../plugins/signalChain';
import { pluginModeOf, type ModeLock } from '../core/session/pluginMode';
import { getPluginThemeClass } from '../utils/pluginTheme';

interface SignalChainBarProps {
  moduleStates: Record<string, string | undefined>;
  pluginLocks: Record<string, ModeLock | undefined>;
}

/**
 * UI2-P2-002 · Signalweg-Leiste
 * Zeigt die feste Signalkette (src/plugins/signalChain.ts) als Chips:
 * Quellen → Mixer → Nachbearbeitung → Recorder → Main Out. Ein Chip leuchtet,
 * wenn das Plugin ON ist. Die Bildschirmreihenfolge darunter bleibt die
 * Kopfreihenfolge – die Leiste ist nur Anzeige, keine Verkabelung.
 */
export const SignalChainBar = React.memo(function SignalChainBar({ moduleStates, pluginLocks }: SignalChainBarProps) {
  const jump = (id: string) => {
    const el = typeof document !== 'undefined' ? document.getElementById(`rack-${id}`) : null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav aria-label="Signalweg" className="rounded-xl border border-neutral-800/80 bg-black/40 px-3 py-2 overflow-x-auto">
      <ol className="flex items-center gap-1.5 min-w-max text-[10px] font-mono">
        {SIGNAL_CHAIN.map((stage, si) => (
          <li key={stage.id} className="flex items-center gap-1.5">
            {si > 0 && <ChevronRight size={12} className="text-neutral-600" aria-hidden="true" />}
            <span className="text-neutral-500 uppercase tracking-widest mr-0.5">{stage.label}</span>
            {stage.plugins.map((id) => {
              const on = pluginModeOf(id, moduleStates[id], pluginLocks[id]) === 'ON';
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => jump(id)}
                  data-signal-on={on ? 'true' : 'false'}
                  aria-label={`${id} ${on ? 'aktiv' : 'aus'} – zum Plugin springen`}
                  className={`${getPluginThemeClass(id)} px-1.5 py-0.5 rounded border transition-colors cursor-pointer`}
                  style={on
                    ? { background: 'var(--monk-accent)', borderColor: 'var(--monk-accent)', color: '#06101c' }
                    : { borderColor: 'var(--monk-accent)', color: 'var(--monk-accent)', opacity: 0.55 }}
                >
                  {id}
                </button>
              );
            })}
          </li>
        ))}
      </ol>
    </nav>
  );
});
