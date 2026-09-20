import React, { useEffect, useState } from 'react';
import { Cloud, CloudOff, Loader2 } from 'lucide-react';

interface CloudHealth {
  supabase?: string;
  r2?: {
    status?: string;
    /** FIX F2: normalisierter Zustand (ok/degraded/error/unconfigured/unknown). */
    state?: string;
    ok?: boolean;
    reason?: string | null;
    message?: string | null;
    bucket?: string | null;
    attempts?: number;
    hint?: string;
    probe?: { method?: string; key?: string; attempts?: number } | null;
    credentials?: { source?: string; deviationCount?: number; usedEnvKeys?: string[] };
    buckets?: string[];
  };
  error?: string;
}

type State = 'checking' | 'configured' | 'partial' | 'offline';

/**
 * CloudStatusBadge – ehrlicher Cloud-Konfigurationsstatus (Supabase + R2).
 * Fragt GET /api/cloud/health ab; ohne konfigurierte Keys zeigt er OFFLINE
 * (App bleibt lokal voll nutzbar).
 *
 * FIX F2: Der Badge hat vorher nur `status === 'ok'` als „gut“ gewertet und bei
 * allem anderen „TEILW.“ ohne Grund angezeigt. Ein `SignatureDoesNotMatch` auf
 * app-1 war damit unsichtbar – obwohl die Cloud-Anbindung faktisch ausfiel.
 * Jetzt entscheidet der normalisierte Zustand (`state`), und die Ursache
 * (`reason`/`hint`/Abweichungszahl) steht im Tooltip, ohne Secret-Werte.
 */
export const CloudStatusBadge: React.FC = () => {
  const [state, setState] = useState<State>('checking');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch('/api/cloud/health');
        const data = (await resp.json().catch(() => ({}))) as CloudHealth;
        if (cancelled) return;
        const sbOk = data.supabase?.startsWith('ok');
        const r2 = data.r2 ?? {};
        // `state` ist der neue, auswertbare Zustand; `status` bleibt als
        // Fallback für ältere Server (Rollback) erhalten.
        const r2State = r2.state ?? (r2.status === 'ok' ? 'ok' : r2.status === 'not-configured' ? 'unconfigured' : 'unknown');
        const r2Ok = r2State === 'ok';
        const r2Broken = r2State === 'degraded' || r2State === 'error';
        const r2Reason = r2.reason && r2.reason !== 'none' ? r2.reason : null;

        if (sbOk && r2Ok) {
          setState('configured');
          setDetail(`Supabase ${data.supabase} · R2 ${r2.bucket ?? 'ok'} (Schreibprobe ok${r2.probe?.method ? `, ${r2.probe.method}` : ''})`);
        } else if (r2Broken) {
          // Fehler NICHT als „teilweise konfiguriert“ verstecken: der Cloud-
          // Speicher ist ausgefallen, das muss der Bediener sehen.
          setState('partial');
          setDetail(
            `R2 ${r2State}${r2Reason ? ` (${r2Reason})` : ''}: ${r2.hint ?? r2.message ?? 'Ursache unbekannt'}`
            + (r2.credentials?.deviationCount ? ` · ${r2.credentials.deviationCount} widersprüchliche Konfigurationsquelle(n)` : '')
            + (r2.credentials?.source ? ` · Quelle: ${r2.credentials.source}` : ''),
          );
        } else if (sbOk || r2Ok) {
          setState('partial');
          setDetail(`Supabase ${data.supabase ?? '?'} · R2 ${r2State}`);
        } else {
          setState('offline');
          setDetail(
            `Supabase/R2 nicht konfiguriert – lokaler Modus (OPFS/Presets) aktiv.`
            + (r2.hint ? ` ${r2.hint}` : ''),
          );
        }
      } catch {
        if (!cancelled) {
          setState('offline');
          setDetail('Cloud-Health nicht erreichbar – lokaler Modus aktiv.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const icon = state === 'checking'
    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
    : state === 'configured'
      ? <Cloud className="w-3.5 h-3.5 text-emerald-400" />
      : state === 'partial'
        ? <Cloud className="w-3.5 h-3.5 text-amber-400" />
        : <CloudOff className="w-3.5 h-3.5 text-neutral-500" />;

  return (
    <span
      title={detail}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[9px] font-mono tracking-widest ${
        state === 'configured' ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/5'
        : state === 'partial' ? 'border-amber-500/40 text-amber-300 bg-amber-500/5'
        : state === 'checking' ? 'border-neutral-700 text-neutral-400'
        : 'border-neutral-800 text-neutral-500'
      }`}
    >
      {icon}
      {state === 'checking' ? 'CLOUD…' : state === 'configured' ? 'CLOUD OK' : state === 'partial' ? 'CLOUD TEILW.' : 'CLOUD OFFLINE'}
    </span>
  );
};
