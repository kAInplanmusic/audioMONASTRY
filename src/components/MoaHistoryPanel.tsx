import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { moaHistory, type MoaHistoryEntry } from '../core/ai/MoaHistory';

/**
 * audioMONASTRY · Zentrale MOA-Historie (Session/UI)
 * ==================================================
 * Zeigt die letzten pluginübergreifenden MOA/MCP-Läufe (Live-Update via
 * Subscribe) und kann den Verlauf löschen.
 */
export function MoaHistoryPanel() {
  const [entries, setEntries] = useState<MoaHistoryEntry[]>(() => moaHistory.list());

  useEffect(() => moaHistory.subscribe(() => setEntries(moaHistory.list())), []);

  if (entries.length === 0) return null;

  return (
    <div className="mt-6 rounded-xl border border-neutral-800 bg-[#0b0b0d] p-4 text-neutral-300">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-mono font-bold tracking-widest uppercase flex items-center gap-2">
          <History className="w-4 h-4 text-cyan-400" /> MOA Verlauf
        </h3>
        <button
          type="button"
          onClick={() => moaHistory.clear()}
          className="text-[9px] font-mono text-neutral-500 hover:text-red-400"
        >
          CLEAR
        </button>
      </div>
      <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
        {entries.slice(0, 10).map((e, i) => (
          <div key={`${e.at}-${i}`} className="text-[9px] font-mono text-neutral-500 leading-relaxed">
            <span className="text-cyan-400">{e.pluginId}</span>
            <span className="text-neutral-400"> · {e.task.slice(0, 60)}</span>
            <span className="text-neutral-600"> · {e.results.join(' / ').slice(0, 100)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
