import React, { useEffect, useState } from 'react';
import { audioEngine } from '../utils/audioEngine';

/**
 * UI2-P2-003: Engine-Status im Mastergraph (nur Anzeige, keine Bedienung).
 *
 * Im Ruhezustand ist die Ausgabe still, und der Browser startet Audio erst nach
 * einer Nutzergeste. Ohne sichtbaren Status wirkt die App dann kaputt. Der Wert
 * kommt aus der Audio-Engine (AudioContext.state), nicht aus lokalem UI-State;
 * abgefragt wird im UI-Takt, nie im Audio-Thread.
 */
export type EngineStatus = 'running' | 'suspended' | 'closed';

export function engineStatusOf(state: string | undefined): EngineStatus {
  if (state === 'running') return 'running';
  if (state === 'suspended' || state === 'interrupted') return 'suspended';
  return 'closed';
}

const TEXT: Record<EngineStatus, { label: string; hint: string; cls: string }> = {
  running: { label: 'AUDIO LÄUFT', hint: 'Die Audio-Engine läuft.', cls: 'border-emerald-400/50 text-emerald-300' },
  suspended: {
    label: 'AUDIO ANGEHALTEN',
    hint: 'Der Browser hält Audio an, bis jemand im Studio tippt oder klickt. Ton auf Main startet ▶ im mixerMONK.',
    cls: 'border-amber-400/50 text-amber-300',
  },
  closed: { label: 'AUDIO AUS', hint: 'Die Audio-Engine ist noch nicht gestartet.', cls: 'border-neutral-600 text-neutral-400' },
};

export const EngineStatusBadge = React.memo(function EngineStatusBadge({ pollMs = 500 }: { pollMs?: number }) {
  const [status, setStatus] = useState<EngineStatus>(() => engineStatusOf(audioEngine.getAudioHealth().state));
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = engineStatusOf(audioEngine.getAudioHealth().state);
      setStatus((prev) => (prev === next ? prev : next));
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);
  const t = TEXT[status];
  return (
    <span
      role="status"
      aria-live="polite"
      data-engine-status={status}
      title={t.hint}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[9px] font-mono tracking-widest ${t.cls}`}
    >
      <span aria-hidden="true">{status === 'running' ? '●' : '○'}</span>
      {t.label}
    </span>
  );
});
