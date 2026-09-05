import { useCallback, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Play, Square, Wand2 } from 'lucide-react';
import { moaAgent, type MoaStep } from '../core/ai/MoaAgent';
import { moaHistory } from '../core/ai/MoaHistory';
import { routeModuleState } from '../core/pluginAudioRouter';
import { audioEngine } from '../utils/audioEngine';
import { webRTCManager } from '../utils/WebRTCManager';
import type { PluginState } from '../plugins/types';
import { MoaAssistant } from './MoaAssistant';

// --------------------------------------------------------------------------- //
// Gemeinsame Terminal-Bausteine (AD-N1/D5): MOA-Runner + Terminal-Rahmen.
// --------------------------------------------------------------------------- //

export interface MoaRunOptions {
  pluginId: string;
  withMeta?: boolean;
  maxResults?: number;
  /** P0-2/P0-8 Routing nur im Dock aktiv (Terminal verhält sich wie bisher). */
  withRouting?: boolean;
  /** Wird im finally-Zweig aufgerufen (z. B. Eingabefeld leeren). */
  onSettled?: () => void;
}

export function useMoaRun({
  pluginId,
  withMeta = false,
  maxResults = 20,
  withRouting = false,
  onSettled,
}: MoaRunOptions) {
  const [results, setResults] = useState<string[]>([]);
  const [meta, setMeta] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (input: string) => {
    const clean = input.trim();
    if (!clean || busy) return;
    setBusy(true);
    const started = Date.now();
    try {
      const plan = await moaAgent.plan(clean);
      const steps: MoaStep[] = plan.steps.length
        ? plan.steps
        : [{ pluginId: 'ai', command: clean, prompt: clean }];
      const executed = await moaAgent.executePlan({ ...plan, steps }, 'localUser');
      const lines = executed.map((r) => {
        // P0-2/P0-8: geplante Plugin-Aktionen wirklich ins Audio-Routing geben.
        if (withRouting && r.handled && r.pluginId) {
          const cmd = String(r.step.command ?? '');
          if (/an|ein|aktiv/i.test(cmd)) routeModuleState(r.pluginId, 'AUTO_AI');
          if (/aus|stopp|deaktiv/i.test(cmd)) routeModuleState(r.pluginId, 'OFF');
        }
        return `${r.handled ? '✓' : '✗'} ${r.pluginId || r.step.pluginId}: ${r.step.command}${r.error ? ` (${r.error})` : ''}`;
      });
      if (withMeta) setMeta(`Provider: ${plan.provider} · Dauer: ${Date.now() - started} ms`);
      setResults((prev) => [...lines, ...prev].slice(0, maxResults));
      moaHistory.add({ pluginId, task: clean, provider: plan.provider, results: lines, at: Date.now() });
    } catch (e) {
      if (withMeta) setMeta(`Provider: FEHLER · Dauer: ${Date.now() - started} ms`);
      setResults((prev) => [`✗ ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, maxResults));
    } finally {
      setBusy(false);
      onSettled?.();
    }
  }, [busy, pluginId, withMeta, maxResults, withRouting, onSettled]);

  return { run, results, meta, busy };
}

export interface QuickAction {
  label: string;
  icon: ComponentType<{ className?: string }>;
  run: () => void;
}

export function useQuickActions(run: (cmd: string) => void | Promise<void>): QuickAction[] {
  return [
    { label: '▶ PLAY', icon: Play, run: () => { void audioEngine.play(); } },
    { label: '⏹ STOP', icon: Square, run: () => { audioEngine.stop(); } },
    { label: 'KI-PATTERN', icon: Wand2, run: () => { void run('Erzeuge ein Techno-Pattern für den Sequencer und wende es an'); } },
  ];
}

// --------------------------------------------------------------------------- //
// TerminalFrame: gemeinsamer Lock-Wrapper + MoaAssistant-Leiste + Header.
// Wird von RecorderTerminal und VoiceGenTerminal genutzt.
// --------------------------------------------------------------------------- //

type Accent = 'cyan' | 'indigo' | 'orange';

const ACCENT = {
  cyan: {
    header: 'bg-linear-to-r from-cyan-900/20 to-[#111] border-b border-cyan-900/30',
    iconBox: 'bg-cyan-500/20 border-cyan-500/50',
    icon: 'text-cyan-400',
    badge: 'text-cyan-400 border-cyan-500/30',
  },
  indigo: {
    header: 'bg-linear-to-r from-indigo-900/20 to-[#111] border-b border-indigo-900/30',
    iconBox: 'bg-indigo-500/20 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.3)]',
    icon: 'text-indigo-400',
    badge: 'text-indigo-400 border-indigo-500/30',
  },
  orange: {
    header: 'bg-linear-to-r from-orange-900/20 to-[#111] border-b border-orange-900/30',
    iconBox: 'bg-orange-500/20 border-orange-500/50 shadow-[0_0_15px_rgba(249,115,22,0.3)]',
    icon: 'text-orange-400',
    badge: 'text-orange-400 border-orange-500/30',
  },
} as const;

export interface TerminalFrameProps {
  pluginId: string;
  moaPlaceholder: string;
  title: string;
  badge?: string;
  icon: ComponentType<{ className?: string }>;
  accent: Accent;
  lockStatus: { active: boolean; lockedBy: string | null };
  state: PluginState;
  updateState: (s: PluginState) => void;
  children: ReactNode;
}

export const TerminalFrame = ({
  pluginId,
  moaPlaceholder,
  title,
  badge,
  icon: Icon,
  accent,
  lockStatus,
  state,
  updateState,
  children,
}: TerminalFrameProps) => {
  const a = ACCENT[accent];
  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;

  return (
    <div className={`w-full h-full flex flex-col bg-[#111] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} overflow-hidden text-neutral-300 font-sans shadow-2xl relative ${locked ? 'opacity-50 grayscale' : ''}`}>
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId={pluginId} placeholder={moaPlaceholder} onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className={`flex items-center justify-between px-6 py-4 ${a.header}`}>
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full ${a.iconBox} flex items-center justify-center border`}>
            <Icon className={`w-5 h-5 ${a.icon}`} />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase flex items-center gap-2">
              {title}{badge && <span className={`text-[10px] font-mono ${a.badge} border px-2 py-0.5 rounded-sm`}>{badge}</span>}
            </h2>
          </div>
        </div>
        <select value={state} onChange={(e) => updateState(e.target.value as PluginState)} className="bg-black text-white text-xs p-1 rounded">
          <option value="OFF">OFF</option>
          <option value="AUTO_AI">AI</option>
          <option value="PRO">ACTIVE</option>
        </select>
      </div>
      {children}
    </div>
  );
};
