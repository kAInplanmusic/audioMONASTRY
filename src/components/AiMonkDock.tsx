import React, { useCallback, useState } from 'react';
import { Bot, ChevronDown, ChevronUp, Play, Square, Wand2 } from 'lucide-react';
import { moaAgent, type MoaStep } from '../core/ai/MoaAgent';
import { moaHistory } from '../core/ai/MoaHistory';
import { audioEngine } from '../utils/audioEngine';
import { routeModuleState } from '../core/pluginAudioRouter';

/**
 * aiMONK-Bottom-Dock (D7 / NEW-D7-1)
 * ====================================
 * Immer offenes KI-Dock für alle User (ersetzt „aiMONK als letztes Modul
 * unten"). Ausblendbar (Collapse), Fehler-/Log-Panel sichtbar, Aktionen
 * plugin-bewusst über MoaAgent → pluginCommandRegistry → PluginAudioRouter.
 */
export const AiMonkDock = React.memo(function AiMonkDock() {
  const [collapsed, setCollapsed] = useState(false);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const [meta, setMeta] = useState('');

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
        if (r.handled && r.pluginId) {
          const cmd = String(r.step.command ?? '');
          if (/an|ein|aktiv/i.test(cmd)) routeModuleState(r.pluginId, 'AUTO_AI');
          if (/aus|stopp|deaktiv/i.test(cmd)) routeModuleState(r.pluginId, 'OFF');
        }
        return `${r.handled ? '✓' : '✗'} ${r.pluginId || r.step.pluginId}: ${r.step.command}${r.error ? ` (${r.error})` : ''}`;
      });
      setMeta(`Provider: ${plan.provider} · Dauer: ${Date.now() - started} ms`);
      setResults((prev) => [...lines, ...prev].slice(0, 30));
      moaHistory.add({ pluginId: 'ai', task: clean, provider: plan.provider, results: lines, at: Date.now() });
    } catch (e) {
      setMeta(`Provider: FEHLER · Dauer: ${Date.now() - started} ms`);
      setResults((prev) => [`✗ ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, 30));
    } finally {
      setBusy(false);
      setTask('');
    }
  }, [busy]);

  const quickActions = [
    { label: '▶ PLAY', icon: Play, run: () => { void audioEngine.play(); } },
    { label: '⏹ STOP', icon: Square, run: () => { audioEngine.stop(); } },
    { label: 'KI-PATTERN', icon: Wand2, run: () => { void run('Erzeuge ein Techno-Pattern für den Sequencer und wende es an'); } },
  ];

  if (collapsed) {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-40">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[#0a0a0a]/95 border-t border-cyan-900/40 text-cyan-300 text-[10px] font-black tracking-[0.3em] uppercase hover:bg-cyan-500/10 transition-colors cursor-pointer"
          aria-expanded="false"
        >
          <Bot className="w-3.5 h-3.5" /> aiMONK <ChevronUp className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#0a0a0a]/95 backdrop-blur border-t border-cyan-900/40 text-neutral-300">
      <div className="max-w-[1600px] mx-auto px-4 py-2 flex items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-full bg-cyan-500/20 flex items-center justify-center border border-cyan-500/50">
            <Bot className="w-3.5 h-3.5 text-cyan-400" />
          </div>
          <span className="text-xs font-black tracking-widest text-neutral-100 uppercase hidden sm:block">aiMONK</span>
        </div>

        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(task); }}
          placeholder="Aufgabe: 'Tempo auf 128, Sequencer an, Pattern laden' …"
          className="flex-1 min-w-0 bg-[#161616] border border-neutral-800 rounded-lg px-3 py-2 text-xs text-white placeholder-neutral-600 focus:outline-none focus:border-cyan-500/60"
        />
        <button type="button" onClick={() => void run(task)} disabled={busy || !task.trim()} className="px-4 py-2 rounded-lg border border-cyan-500/60 bg-cyan-500/10 text-cyan-200 text-[10px] font-black tracking-widest hover:bg-cyan-500/20 disabled:opacity-40 shrink-0">
          {busy ? 'PLANT…' : 'AUSFÜHREN'}
        </button>

        <div className="hidden md:flex items-center gap-1.5 shrink-0">
          {quickActions.map((action) => (
            <button key={action.label} type="button" onClick={action.run} className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-neutral-700 bg-black/40 text-[9px] font-black tracking-widest text-neutral-300 hover:border-cyan-400/60 hover:text-cyan-200 transition-colors">
              <action.icon className="w-3 h-3" /> {action.label}
            </button>
          ))}
        </div>

        <button type="button" onClick={() => setCollapsed(true)} aria-label="aiMONK-Dock einklappen" className="p-1.5 rounded-md border border-neutral-800 text-neutral-500 hover:text-cyan-300 hover:border-cyan-500/40 shrink-0">
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>

      {results.length > 0 && (
        <div className="max-w-[1600px] mx-auto px-4 pb-2 max-h-28 overflow-y-auto border-t border-white/5">
          <div className="pt-1.5 space-y-0.5 font-mono text-[10px]">
            {meta && <div className="text-cyan-400">{meta}</div>}
            {results.map((line, i) => (
              <div key={i} className={line.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
