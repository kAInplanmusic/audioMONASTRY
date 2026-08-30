import React, { useCallback, useState } from 'react';
import { Bot, Play, Square, Wand2 } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { MoaAssistant } from './MoaAssistant';
import { moaAgent, type MoaStep } from '../core/ai/MoaAgent';
import { moaHistory } from '../core/ai/MoaHistory';
import { audioEngine } from '../utils/audioEngine';

/**
 * aiMONK – globaler KI-Assistent
 * ==============================
 * Freitext-Aufgaben werden über den MoaAgent (DeepSeek V4 Flash via
 * Server-Proxy) geplant und plugin-bewusst ausgeführt. Zusätzlich direkte
 * Transport-/Kompositions-Kurzbefehle für den laufenden Betrieb.
 */
export const AiMonkTerminal = React.memo(function AiMonkTerminal() {
  const { state, updateState } = usePluginState('ai', 'PRO');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<string[]>([]);

  const run = useCallback(async (input: string) => {
    const clean = input.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      const plan = await moaAgent.plan(clean);
      const steps: MoaStep[] = plan.steps.length
        ? plan.steps
        : [{ pluginId: 'ai', command: clean, prompt: clean }];
      const executed = await moaAgent.executePlan({ ...plan, steps }, 'localUser');
      const lines = executed.map((r) =>
        `${r.handled ? '✓' : '✗'} ${r.pluginId || r.step.pluginId}: ${r.step.command}${r.error ? ` (${r.error})` : ''}`,
      );
      setResults((prev) => [...lines, ...prev].slice(0, 20));
      moaHistory.add({ pluginId: 'ai', task: clean, provider: plan.provider, results: lines, at: Date.now() });
    } catch (e) {
      setResults((prev) => [`✗ ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, 20));
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

  return (
    <div className="w-full h-full flex flex-col bg-[#111] rounded-xl border border-neutral-800 overflow-hidden text-neutral-300 font-sans">
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="ai" placeholder="MOA: globale Aufgabe…" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-cyan-900/20 to-[#111] border-b border-cyan-900/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center border border-cyan-500/50">
            <Bot className="w-5 h-5 text-cyan-400" />
          </div>
          <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase">aiMONK</h2>
        </div>
        <select value={state} onChange={(e) => updateState(e.target.value as never)} className="bg-black text-white text-xs p-1 rounded">
          <option value="OFF">OFF</option>
          <option value="AUTO_AI">AI</option>
          <option value="PRO">ACTIVE</option>
        </select>
      </div>

      <div className="flex-1 p-6 overflow-y-auto space-y-6">
        <div className="flex gap-2">
          <input
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(task); }}
            placeholder="Aufgabe eingeben, z. B. 'Mastering-Kette prüfen' oder 'Drop vorbereiten'"
            className="flex-1 bg-[#1a1a1a] border border-neutral-800 rounded-lg px-4 py-3 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-cyan-500/60"
          />
          <button type="button" onClick={() => void run(task)} disabled={busy || !task.trim()} className="px-5 py-3 rounded-lg border border-cyan-500/60 bg-cyan-500/10 text-cyan-200 text-xs font-black tracking-widest hover:bg-cyan-500/20 disabled:opacity-40">
            {busy ? 'PLANT…' : 'AUSFÜHREN'}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {quickActions.map((action) => (
            <button key={action.label} type="button" onClick={action.run} className="flex items-center gap-2 px-4 py-2 rounded-full border border-neutral-700 bg-black/40 text-[10px] font-black tracking-widest text-neutral-300 hover:border-cyan-400/60 hover:text-cyan-200 transition-colors">
              <action.icon className="w-3 h-3" /> {action.label}
            </button>
          ))}
        </div>

        <div className="bg-black/40 border border-neutral-800 rounded-xl p-4 min-h-[160px]">
          <h3 className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-2">Ausführungs-Log</h3>
          <div className="space-y-1 font-mono text-[11px]">
            {results.length === 0 && <div className="text-neutral-600">Noch keine Ausführung – Aufgabe eingeben oder Kurzbefehl wählen.</div>}
            {results.map((line, i) => (
              <div key={i} className={line.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}>{line}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
