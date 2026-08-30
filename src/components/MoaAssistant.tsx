import { useState, useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { moaAgent, type MoaStep } from '../core/ai/MoaAgent';
import { moaHistory } from '../core/ai/MoaHistory';
import { storageGetJson, storageSetJson } from '../utils/storage';
import { moaTaskForPlugin } from '../utils/prompts';

interface MoaAssistantProps {
  pluginId: string;
  placeholder?: string;
  /** Wird bei MOA-Start/-Ende aufgerufen, damit das Terminal AUTO_AI anzeigen kann. */
  onActivity?: (active: boolean) => void;
  /** AUTO_AI-Modus: periodische, plugin-spezifische MOA-Vorschläge ausführen. */
  autoMode?: boolean;
}

const AUTO_FIRST_MS = 2500;
const AUTO_INTERVAL_MS = 90000;

/**
 * audioMONASTRY · MoaAssistant (MOA/MCP-Eingabezeile für Plugin-Terminals)
 * ========================================================================
 * Aufgabe eingeben → MoaAgent plant (DeepSeek V4 Flash via Server-Proxy) →
 * plugin-bewusste Ausführung über das VoiceControlService-Registry.
 * Im AUTO_AI-Modus werden periodisch Vorschläge geplant und ausgeführt;
 * alle Läufe landen in der zentralen MoaHistory.
 */
export function MoaAssistant({ pluginId, placeholder = 'MOA-Aufgabe…', onActivity, autoMode = false }: MoaAssistantProps) {
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>(() => storageGetJson<string[]>(`moa-log-${pluginId}`) ?? []);
  const busyRef = useRef(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Letzte MOA-Ergebnisse pro Plugin persistieren (max. 5 Einträge).
  useEffect(() => {
    if (log.length > 0) storageSetJson(`moa-log-${pluginId}`, log.slice(-5));
  }, [log, pluginId]);

  const runTask = async (input: string, auto = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onActivity?.(true);
    try {
      const plan = await moaAgent.plan(`${pluginId}: ${input}`);
      const steps: MoaStep[] = plan.steps.length
        ? plan.steps
        : [{ pluginId, command: input, prompt: input }];
      const results = await moaAgent.executePlan({ ...plan, steps }, 'localUser');
      const entries = results.map((r) =>
        `${r.handled ? '✓' : '✗'} ${r.pluginId || r.step.pluginId}: ${r.step.command}${r.error ? ` (${r.error})` : ''}`,
      );
      setLog((prev) => [...prev.slice(-4), ...(auto ? entries.map((e) => `AUTO: ${e}`) : entries)]);
      moaHistory.add({
        pluginId,
        task: input,
        provider: plan.provider,
        results: entries,
        at: Date.now(),
      });
    } catch (error) {
      const msg = `Fehler: ${error instanceof Error ? error.message : String(error)}`;
      setLog((prev) => [...prev.slice(-4), msg]);
      moaHistory.add({ pluginId, task: input, provider: 'error', results: [msg], at: Date.now() });
    } finally {
      busyRef.current = false;
      setBusy(false);
      onActivity?.(false);
    }
  };

  const run = () => {
    const clean = task.trim();
    if (clean) {
      runTask(clean).catch(() => { /* Fehler werden in runTask geloggt */ });
    }
  };

  // AUTO_AI: periodische, plugin-spezifische Vorschläge planen und ausführen.
  useEffect(() => {
    if (!autoMode) return;
    const tick = () => {
      runTask(moaTaskForPlugin(pluginId), true).catch(() => { /* Fehler werden in runTask geloggt */ });
    };
    const first = window.setTimeout(tick, AUTO_FIRST_MS);
    const interval = window.setInterval(tick, AUTO_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode, pluginId]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
          placeholder={placeholder}
          className="flex-1 min-w-0 bg-black border border-neutral-800 rounded px-2 py-1 text-[10px] font-mono text-neutral-300 focus:outline-none focus:border-cyan-500/50"
        />
        <button
          type="button"
          onClick={() => run()}
          disabled={busy || !task.trim()}
          className="shrink-0 px-2 py-1 rounded border border-cyan-500/50 bg-cyan-500/10 text-cyan-300 text-[9px] font-bold tracking-widest hover:bg-cyan-500/20 disabled:opacity-40 flex items-center gap-1"
        >
          <Sparkles className="w-3 h-3" /> {busy ? 'MOA…' : 'MOA'}
        </button>
        {(busy || autoMode) && (
          <span className="shrink-0 px-2 py-0.5 rounded border border-cyan-500/40 bg-cyan-950/40 text-cyan-300 text-[8px] font-mono uppercase animate-pulse">
            AUTO_AI
          </span>
        )}
      </div>
      {log.length > 0 && (
        <div className="text-[9px] font-mono text-neutral-500 break-words">{log.join(' · ')}</div>
      )}
    </div>
  );
}
