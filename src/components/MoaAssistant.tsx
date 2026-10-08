import { useState, useEffect, useRef } from 'react';
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
 * audioMONASTRY · MoaAssistant (AUTO_AI je Plugin, ohne eigene Zeile)
 * ====================================================================
 * Design: Eingabe, Agent-Läufe und Fehler stehen nur im aiMONK-Dock. Hier
 * bleibt der AUTO_AI-Takt: MoaAgent plant → plugin-bewusste Ausführung.
 * Im AUTO_AI-Modus werden periodisch Vorschläge geplant und ausgeführt;
 * alle Läufe landen in der zentralen MoaHistory.
 */
export function MoaAssistant({ pluginId, onActivity, autoMode = false }: MoaAssistantProps) {
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

  // Design (Entwurf): keine KI-Zeilen in den Plugins – Aufgaben, Agent-Läufe
  // und Fehler stehen nur im aiMONK-Dock. Hier läuft nur noch AUTO_AI.
  return null;
}
