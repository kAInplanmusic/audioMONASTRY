import React, { useEffect, useState } from 'react';
import { audioEngine } from '../utils/audioEngine';
import type { SinkRecoveryState } from '../core/audio/backends/sinkRecovery';

/**
 * UI2-P2-003: Engine-Status im Mastergraph (nur Anzeige, keine Bedienung).
 *
 * Im Ruhezustand ist die Ausgabe still, und der Browser startet Audio erst nach
 * einer Nutzergeste. Ohne sichtbaren Status wirkt die App dann kaputt. Der Wert
 * kommt aus der Audio-Engine (AudioContext.state), nicht aus lokalem UI-State;
 * abgefragt wird im UI-Takt, nie im Audio-Thread.
 *
 * RT-AUDIT-P0-007: Zusätzlich zeigt der Badge den Fehlerpfad des V2-Live-Sinks
 * (Neuaufbau nach Prozessor-Absturz bzw. Fehlerzustand nach zu vielen
 * Neuaufbauten). Quelle ist die Engine, kein lokaler oder Browser-Speicher.
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

export interface SinkFaultNotice {
  label: string;
  hint: string;
  cls: string;
}

/** RT-AUDIT-P0-007: Hinweistext zum Fehlerpfad des V2-Live-Sinks (null = nichts anzeigen). */
export function sinkFaultNoticeOf(state: SinkRecoveryState | undefined): SinkFaultNotice | null {
  if (state === 'failed') {
    return {
      label: 'Audio-Engine gestört – bitte neu laden',
      hint: 'Der Audio-Prozessor ist mehrfach ausgefallen. Bitte die Seite neu laden.',
      cls: 'border-red-400/60 text-red-300',
    };
  }
  if (state === 'recovered') {
    return {
      label: 'Audio-Engine neu gestartet',
      hint: 'Der Audio-Prozessor ist ausgefallen und wurde automatisch neu aufgebaut.',
      cls: 'border-sky-400/50 text-sky-300',
    };
  }
  return null;
}

function readSinkState(): SinkRecoveryState | undefined {
  try {
    return audioEngine.getV2SinkRecoveryStatus?.().state;
  } catch {
    return undefined;
  }
}

export const EngineStatusBadge = React.memo(function EngineStatusBadge({ pollMs = 500 }: { pollMs?: number }) {
  const [status, setStatus] = useState<EngineStatus>(() => engineStatusOf(audioEngine.getAudioHealth().state));
  const [sinkState, setSinkState] = useState<SinkRecoveryState | undefined>(() => readSinkState());
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = engineStatusOf(audioEngine.getAudioHealth().state);
      setStatus((prev) => (prev === next ? prev : next));
      const nextSink = readSinkState();
      setSinkState((prev) => (prev === nextSink ? prev : nextSink));
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);
  const t = TEXT[status];
  const fault = sinkFaultNoticeOf(sinkState);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
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
      {fault && (
        <span
          role="alert"
          data-engine-fault={sinkState}
          title={fault.hint}
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[9px] font-mono tracking-widest ${fault.cls}`}
        >
          <span aria-hidden="true">!</span>
          {fault.label}
        </span>
      )}
    </span>
  );
});
