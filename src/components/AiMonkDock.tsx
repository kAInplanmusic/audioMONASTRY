import React, { useRef, useState } from 'react';
import { useMoaRun } from './terminalShared';

/** Fixed shared entry point, not a plugin or a background automation mode.
 * A request runs only on explicit form submission; mounting and idling do nothing.
 */
export const AiMonkDock = React.memo(function AiMonkDock() {
  const [task, setTask] = useState('');
  const submitting = useRef(false);
  const { run, results, busy } = useMoaRun({
    pluginId: 'ai',
    withMeta: true,
    maxResults: 30,
    withRouting: true,
    typedExecutor: true,
  });
  const latest = results[0] ?? '';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || submitting.current || !task.trim()) return;
    submitting.current = true;
    const request = task.trim();
    try { await run(request); }
    finally { submitting.current = false; }
  };
  return (
    <section id="ai-monk-dock" className="am-box am-aidock" style={{ ['--c' as string]: '#ff4fa8' }} aria-label="aiMONK">
      <form className="am-aidock-row" onSubmit={event => { void submit(event); }}>
        <label className="am-aidock-name" htmlFor="ai-monk-request"><span>aiMONK</span></label>
        <input id="ai-monk-request" className="am-aidock-in" value={task}
          onChange={event => setTask(event.target.value)}
          placeholder={busy ? 'Anforderung wird ausgeführt …' : 'Aufgabe eingeben · Enter zum Ausführen'}
          aria-label="aiMONK Anforderung, Enter zum Ausführen" aria-busy={busy}
          aria-describedby="ai-monk-request-status" readOnly={busy} enterKeyHint="send"
          title={busy ? 'Anforderung wird ausgeführt' : latest || 'Nur abgesendete Anforderungen werden ausgeführt'} />
      </form>
      <span id="ai-monk-request-status" className="sr-only" role="status">{busy ? 'Anforderung wird ausgeführt' : latest}</span>
    </section>
  );
});
