import React, { useEffect, useState } from 'react';
import { Cloud, CloudOff, Loader2 } from 'lucide-react';

interface CloudHealth {
  supabase?: string;
  r2?: { status?: string; buckets?: string[] };
  error?: string;
}

type State = 'checking' | 'configured' | 'partial' | 'offline';

/**
 * CloudStatusBadge – ehrlicher Cloud-Konfigurationsstatus (Supabase + R2).
 * Fragt GET /api/cloud/health ab; ohne konfigurierte Keys zeigt er OFFLINE
 * (App bleibt lokal voll nutzbar).
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
        const r2Ok = data.r2?.status === 'ok';
        if (sbOk && r2Ok) {
          setState('configured');
          setDetail(`Supabase ${data.supabase} · R2 ${data.r2?.buckets?.join(', ') || 'ok'}`);
        } else if (sbOk || r2Ok) {
          setState('partial');
          setDetail(`Supabase ${data.supabase ?? '?'} · R2 ${data.r2?.status ?? '?'}`);
        } else {
          setState('offline');
          setDetail('Supabase/R2 nicht konfiguriert – lokaler Modus (OPFS/Presets) aktiv.');
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
