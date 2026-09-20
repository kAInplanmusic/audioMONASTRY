import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Ban, Play, RotateCcw, Loader2 } from 'lucide-react';
// F5-Fix: Der Server zaehlt Rate-Limits je Nutzer-/Session-Identitaet statt je
// Master-Token – das Status-Polling eines Laufs darf nicht im Budget der
// anderen Session-Nutzer landen (server/rateLimitKeys.ts).
import { sessionIdentityHeaders } from '../core/session/sessionIdentity';

/**
 * AI-P1-006 · Agent-Lauf-Panel (aiMONK-Loop: planen -> ausfuehren -> pruefen)
 * ========================================================================
 * Startet einen serverseitigen Agent-Lauf und zeigt **Ergebnis und Kosten**:
 * Phase/Status, die Schritte mit Haken oder Fehler und die Kostensumme
 * (getrennt nach Planung und Korrekturen - die Ausfuehrung selbst sind lokale
 * Kommandos und kosten nichts).
 *
 * Abbruch und Wiederaufnahme: "Abbrechen" stoppt kooperativ vor dem naechsten
 * Schritt, "Fortsetzen" macht mit dem ORIGINALPLAN an der Abbruchstelle weiter
 * (bereits erledigte Schritte werden nicht wiederholt).
 *
 * Der Lauf liegt serverseitig (Datei-Store), deshalb uebersteht die Anzeige auch
 * einen Reload - beim Oeffnen wird der letzte Lauf geladen.
 */

interface AgentRunView {
  runId: string;
  task: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  phase: string;
  steps: Array<{ index: number; pluginId: string; command: string; handled: boolean; error?: string }>;
  executedCount: number;
  corrections: number;
  cost: { totalUsd: number; planningUsd: number; correctionsUsd: number; estimated: boolean };
  succeeded: boolean;
  error?: string;
}

const POLL_MS = 1500;

const STATUS_STYLE: Record<AgentRunView['status'], string> = {
  running: 'border-cyan-500/40 bg-cyan-950/40 text-cyan-300',
  done: 'border-emerald-500/40 bg-emerald-950/40 text-emerald-300',
  cancelled: 'border-amber-500/40 bg-amber-950/40 text-amber-300',
  failed: 'border-red-500/40 bg-red-950/40 text-red-300',
};

const STATUS_TEXT: Record<AgentRunView['status'], string> = {
  running: 'LÄUFT',
  done: 'FERTIG',
  cancelled: 'ABGEBROCHEN',
  failed: 'FEHLGESCHLAGEN',
};

export function AgentRunPanel() {
  const [task, setTask] = useState('');
  const [run, setRun] = useState<AgentRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const pollRef = useRef<number | null>(null);

  const loadRun = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/ai/agent/runs/${encodeURIComponent(runId)}`, {
        headers: { ...sessionIdentityHeaders() },
      });
      if (!res.ok) return null;
      const body = await res.json() as { run?: AgentRunView };
      return body.run ?? null;
    } catch {
      return null;
    }
  }, []);

  // Beim Oeffnen den letzten Lauf anzeigen (der Lauf liegt serverseitig).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/ai/agent/runs', { headers: { ...sessionIdentityHeaders() } });
        if (!res.ok) return;
        const body = await res.json() as { runs?: AgentRunView[] };
        if (!cancelled && body.runs?.[0]) setRun(body.runs[0]);
      } catch { /* Anzeige ist optional */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Solange der Lauf laeuft, den Zustand nachfuehren.
  useEffect(() => {
    if (!run || run.status !== 'running') {
      if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = window.setInterval(() => {
      void loadRun(run.runId).then((fresh) => { if (fresh) setRun(fresh); });
    }, POLL_MS);
    return () => {
      if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [run, loadRun]);

  const start = async () => {
    const clean = task.trim();
    if (!clean || busy) return;
    setBusy(true);
    setNote('');
    try {
      const res = await fetch('/api/ai/agent/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sessionIdentityHeaders() },
        // Schreib-Schritte muessen ausdruecklich freigegeben werden; hier nur
        // lesende/diagnostische Schritte -> ohne allowWrite.
        body: JSON.stringify({ task: clean }),
      });
      const body = await res.json() as { run?: AgentRunView; message?: string };
      if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
      setRun(body.run ?? null);
      setTask('');
    } catch (error) {
      setNote(`Start fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/agent/runs/${encodeURIComponent(run.runId)}/cancel`, {
        method: 'POST',
        headers: { ...sessionIdentityHeaders() },
      });
      const body = await res.json() as { run?: AgentRunView };
      if (body.run) setRun(body.run);
    } catch (error) {
      setNote(`Abbruch fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!run) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/agent/runs/${encodeURIComponent(run.runId)}/resume`, {
        method: 'POST',
        headers: { ...sessionIdentityHeaders() },
      });
      const body = await res.json() as { run?: AgentRunView; message?: string };
      if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
      if (body.run) setRun(body.run);
    } catch (error) {
      setNote(`Fortsetzen fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const resumable = run && (run.status === 'cancelled' || run.status === 'failed');

  return (
    <div className="flex flex-col gap-1.5 rounded border border-neutral-800 bg-black/40 p-2">
      <div className="flex items-center gap-2">
        <Bot className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void start(); }}
          placeholder="Agent-Auftrag (planen → ausführen → prüfen)…"
          aria-label="Agent-Auftrag"
          className="flex-1 min-w-0 bg-black border border-neutral-800 rounded px-2 py-1 text-[10px] font-mono text-neutral-300 focus:outline-none focus:border-cyan-500/50"
        />
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || !task.trim()}
          aria-label="Agent-Lauf starten"
          className="shrink-0 px-2 py-1 rounded border border-cyan-500/50 bg-cyan-500/10 text-cyan-300 text-[9px] font-bold tracking-widest hover:bg-cyan-500/20 disabled:opacity-40 flex items-center gap-1"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} LAUF
        </button>
      </div>

      {run && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded border text-[8px] font-mono uppercase ${STATUS_STYLE[run.status]}`}>
              {STATUS_TEXT[run.status]}
            </span>
            <span className="text-[9px] font-mono text-neutral-500">
              Phase: {run.phase} · Schritte: {run.executedCount} · Korrekturen: {run.corrections} · Plan-Versuche: {run.phase === 'plan' ? 1 : 1}
            </span>
            {/* Kosten: Gesamt mit Hinweis, dass Planung/Korrektur geschaetzt sind. */}
            <span className="text-[9px] font-mono text-emerald-300" aria-label="Kosten des Laufs">
              Kosten: {run.cost.totalUsd.toFixed(4)} USD
              {run.cost.estimated ? ' (geschätzt)' : ''}
            </span>
            <span className="text-[8px] font-mono text-neutral-600">
              davon Planung {run.cost.planningUsd.toFixed(4)} · Korrektur {run.cost.correctionsUsd.toFixed(4)}
            </span>
            <span className="flex-1" />
            {run.status === 'running' && (
              <button
                type="button"
                onClick={() => void cancel()}
                aria-label="Agent-Lauf abbrechen"
                className="px-1.5 py-0.5 rounded border border-amber-500/50 bg-amber-500/10 text-amber-300 text-[8px] font-mono hover:bg-amber-500/20 flex items-center gap-1"
              >
                <Ban className="w-3 h-3" /> ABBRECHEN
              </button>
            )}
            {resumable && (
              <button
                type="button"
                onClick={() => void resume()}
                aria-label="Agent-Lauf fortsetzen"
                className="px-1.5 py-0.5 rounded border border-cyan-500/50 bg-cyan-500/10 text-cyan-300 text-[8px] font-mono hover:bg-cyan-500/20 flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> FORTSETZEN
              </button>
            )}
          </div>

          {run.steps.length > 0 && (
            <div className="text-[9px] font-mono text-neutral-400 break-words">
              {run.steps.map((step) => (
                <span key={step.index} className="mr-2">
                  {step.handled ? '✓' : '✗'} {step.pluginId}: {step.command}
                  {step.error ? ` (${step.error})` : ''}
                </span>
              ))}
            </div>
          )}
          {run.error && <div className="text-[9px] font-mono text-red-400">Abbruchgrund: {run.error}</div>}
        </div>
      )}
      {note && <div className="text-[9px] font-mono text-amber-300">{note}</div>}
    </div>
  );
}
