import React, { useState } from 'react';
import { Bot } from 'lucide-react';
import { useMoaRun, useQuickActions } from './terminalShared';
import { AgentRunPanel } from './AgentRunPanel';

/**
 * aiMONK-Bottom-Dock (D7 / NEW-D7-1)
 * ====================================
 * Fest unten nach dem Rack (Betreiber 2026-10-07): für alle sichtbar, nicht
 * schließbar, nicht verschiebbar. Fehler-/Log-Panel sichtbar, Aktionen
 * plugin-bewusst über MoaAgent → pluginCommandRegistry → PluginAudioRouter.
 */
export const AiMonkDock = React.memo(function AiMonkDock() {
  const [agentOpen, setAgentOpen] = useState(false);
  const [task, setTask] = useState('');
  const { run, results, meta, busy } = useMoaRun({
    pluginId: 'ai',
    withMeta: true,
    maxResults: 30,
    withRouting: true,
    onSettled: () => setTask(''),
  });
  const quickActions = useQuickActions(run);

  return (
    <section id="ai-monk-dock" className="am-box am-aidock" style={{ ['--c' as string]: '#ff4fa8' }} aria-label="aiMONK">
      {agentOpen && (
        <div className="am-aidock-agent">
          <AgentRunPanel />
        </div>
      )}
      <div className="am-aidock-row">
        <div className="am-aidock-name">
          <Bot className="w-4 h-4" />
          <span>aiMONK</span>
          <small>Assistent · fest für alle</small>
        </div>

        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(task); }}
          placeholder="Aufgabe: 'Tempo auf 128, Sequencer an, Pattern laden' …"
          className="am-aidock-in"
        />
        <button type="button" onClick={() => void run(task)} disabled={busy || !task.trim()} className="am-btn am-pri" style={{ ['--c' as string]: '#ff4fa8' }}>
          {busy ? 'PLANT…' : 'AUSFÜHREN'}
        </button>

        <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
          {quickActions.map((action) => (
            <button key={action.label} type="button" onClick={action.run} className="am-tool">
              <action.icon className="w-3 h-3" /> {action.label}
            </button>
          ))}
        </div>

        <button type="button" onClick={() => setAgentOpen((v) => !v)} aria-pressed={agentOpen} className={`am-tool ${agentOpen ? 'am-on' : ''}`} style={{ ['--c' as string]: '#ff4fa8' }} title="Agent-Lauf: planen → ausführen → prüfen">
          AGENT
        </button>
      </div>

      {results.length > 0 && (
        <div className="am-aidock-log">
          <div className="pt-1.5 space-y-0.5 font-mono text-[10px]">
            {meta && <div className="text-cyan-400">{meta}</div>}
            {results.map((line, i) => (
              <div key={i} className={line.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
});
