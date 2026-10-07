import React, { useState } from 'react';
import { Bot, ChevronDown, ChevronUp } from 'lucide-react';
import { useMoaRun, useQuickActions } from './terminalShared';
import { AgentRunPanel } from './AgentRunPanel';

/**
 * aiMONK-Bottom-Dock (D7 / NEW-D7-1)
 * ====================================
 * Immer offenes KI-Dock für alle User (ersetzt „aiMONK als letztes Modul
 * unten"). Ausblendbar (Collapse), Fehler-/Log-Panel sichtbar, Aktionen
 * plugin-bewusst über MoaAgent → pluginCommandRegistry → PluginAudioRouter.
 */
export const AiMonkDock = React.memo(function AiMonkDock() {
  const [collapsed, setCollapsed] = useState(false);
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

  if (collapsed) {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-40">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="aiMONK öffnen"
          className="am-aidock-min"
          aria-expanded="false"
        >
          <Bot className="w-3.5 h-3.5" /> aiMONK <ChevronUp className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div id="ai-monk-dock" className="am am-aidock">
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
        <button type="button" onClick={() => setCollapsed(true)} aria-label="aiMONK-Dock einklappen" className="am-tool">
          <ChevronDown className="w-4 h-4" />
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
    </div>
  );
});
