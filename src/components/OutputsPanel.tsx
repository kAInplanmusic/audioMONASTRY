import React, { useState } from 'react';
import { Link2, MonitorSpeaker, Monitor, Radio, UserRound } from 'lucide-react';
import { webRTCManager } from '../utils/WebRTCManager';
import { useSessionEndpoints } from '../hooks/useSessionEndpoints';
import { endpointLabel, MAX_UI_ENDPOINTS, type SessionEndpoint } from '../core/session/sessionEndpoints';

/**
 * OutputsPanel – Session-Ausgänge (Betreiber 2026-10-06)
 * ======================================================
 *   UI 1–4        Session-Nutzer: bekommen die UI, jeder in eigenem Format und
 *                 eigener Auflösung (Handy quer/hochkant, Pad, PC).
 *   MAIN AUDIO    genau ein Gerät  → /master-out (Ghostuser 5)
 *   MAIN VISUALS  genau ein Gerät  → /visual-out (Ghostuser 6)
 *   Beide über Internet oder LAN erreichbar; das erste Gerät hält die Adresse,
 *   jedes weitere wird vom Server abgewiesen (output-busy).
 *
 * Die beiden Main-Ausgänge zählen NICHT zu den 4 Nutzern. Die URLs werden aus
 * der aktuellen Origin gebildet, damit sie auf jeder Instanz stimmen. Alles hier
 * ist Anzeige – Zustand und Auflösung melden die Geräte selbst
 * (src/core/session/sessionEndpoints.ts).
 */
const MAIN_OUTPUTS = [
  {
    id: 'sound',
    label: 'MAIN AUDIO',
    role: 'genau 1 Gerät',
    path: '/master-out',
    alias: '/ghost/5',
    hint: 'Diese Adresse im Browser des Geräts öffnen, das den Main-Ton ausgibt (Internet oder LAN). Das erste Gerät hält sie, jedes weitere wird abgewiesen.',
    Icon: Radio,
  },
  {
    id: 'visual',
    label: 'MAIN VISUALS',
    role: 'genau 1 Gerät',
    path: '/visual-out',
    alias: '/ghost/6',
    hint: 'Diese Adresse im Browser des Geräts öffnen, das die Visuals zeigt (Internet oder LAN). Das erste Gerät hält sie, jedes weitere wird abgewiesen.',
    Icon: Monitor,
  },
] as const;

/** Nutzerfarben laut docs/UI_SPEC.md (Platz 1–4). */
const USER_COLORS = ['#4cc9f0', '#ffb703', '#e879f9', '#f1f5f9'];

function dotClass(e: SessionEndpoint | null): string {
  if (!e) return 'bg-neutral-700';
  const r = e.report;
  if (r && r.kind !== 'ui') {
    if (r.state === 'live') return 'bg-emerald-400';
    if (r.state === 'error') return 'bg-red-500';
    return 'bg-amber-400';
  }
  return 'bg-emerald-400';
}

export const OutputsPanel: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string>('');
  const { slots } = useSessionEndpoints();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const me = webRTCManager.userId;
  const usersOn = slots.users.filter(Boolean).length;

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied(''), 1500);
    } catch {
      setCopied('');
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Session-Ausgänge"
        aria-expanded={open}
        title={`Ausgänge: ${usersOn}/${MAX_UI_ENDPOINTS} Nutzer · Main Audio · Main Visuals`}
        className={`am-tool ${open ? 'am-on' : ''}`}
        style={{ ['--c' as string]: '#3ddc84' }}
      >
        <MonitorSpeaker />
        
        <span className="text-[9px] font-mono text-neutral-400">{usersOn}/{MAX_UI_ENDPOINTS}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass(slots.sound)}`} aria-hidden="true" />
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass(slots.visual)}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Session-Ausgänge"
          className="absolute right-0 mt-2 w-[min(22rem,calc(100vw-1rem))] max-h-[calc(var(--app-height,100vh)-5rem)] overflow-y-auto z-[70] rounded-xl border border-white/10 bg-[#0b0f14]/98 backdrop-blur-xl shadow-2xl p-3"
        >
          <div className="flex items-center gap-2 mb-2">
            <Link2 className="w-3.5 h-3.5 text-emerald-300" />
            <span className="text-[10px] font-bold tracking-widest text-neutral-200">SESSION-AUSGÄNGE</span>
          </div>

          <p className="text-[9px] tracking-widest text-neutral-500 mb-1">UI · 1–4 NUTZER</p>
          <ul className="mb-3 rounded-lg border border-white/5 bg-white/[0.02] divide-y divide-white/5">
            {slots.users.map((u, i) => (
              <li key={i} data-testid={`endpoint-user-${i + 1}`} className="flex items-center gap-2 px-2.5 py-1.5">
                <span
                  className="w-5 h-5 shrink-0 rounded-full border flex items-center justify-center text-[9px] font-bold"
                  style={{ borderColor: USER_COLORS[i], color: USER_COLORS[i] }}
                >
                  {i + 1}
                </span>
                <UserRound className={`w-3.5 h-3.5 shrink-0 ${u ? 'text-neutral-300' : 'text-neutral-700'}`} aria-hidden="true" />
                <span className="text-[10px] font-mono text-neutral-200 w-14 truncate">
                  {u ? (u.userId === me ? 'du' : u.userId.replace(/^user-/, 'u')) : '—'}
                </span>
                <span className={`flex-1 min-w-0 truncate text-[10px] ${u ? 'text-neutral-300' : 'text-neutral-600'}`}>{endpointLabel(u)}</span>
              </li>
            ))}
          </ul>

          {MAIN_OUTPUTS.map(({ id, label, role, path, alias, hint, Icon }) => {
            const url = `${origin}${path}`;
            const endpoint = id === 'sound' ? slots.sound : slots.visual;
            return (
              <div key={id} data-testid={`endpoint-${id}`} className="mb-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${dotClass(endpoint)}`} aria-hidden="true" />
                  <Icon className="w-3.5 h-3.5 text-cyan-300" />
                  <span className="text-[10px] font-bold tracking-widest text-neutral-100">{label}</span>
                  <span className="text-[9px] text-neutral-500 truncate">{role}</span>
                </div>
                <p className="mt-1 text-[10px] text-neutral-300" data-testid={`endpoint-${id}-status`}>
                  {endpoint ? endpointLabel(endpoint) : 'nicht verbunden'}
                </p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <code className="flex-1 truncate text-[10px] text-emerald-200/90 bg-black/40 rounded px-2 py-1">{url}</code>
                  <button
                    type="button"
                    onClick={() => copy(url)}
                    className="shrink-0 px-2 py-1 rounded text-[9px] font-bold tracking-widest border border-emerald-400/40 text-emerald-200 hover:bg-emerald-400/10 transition-colors"
                  >
                    {copied === url ? 'KOPIERT' : 'KOPIEREN'}
                  </button>
                </div>
                <p className="mt-1 text-[9px] leading-snug text-neutral-500">{hint}</p>
                <p className="mt-0.5 text-[9px] text-neutral-600">Alias: {alias} · zählt nicht als Nutzer · max. 1 Gerät</p>
              </div>
            );
          })}

          <p className="text-[9px] leading-snug text-neutral-500">
            Genau ein Main-Ausgang Audio und einer Visuals, je über eine eigene Adresse. Auf dem Ausgabegerät
            ggf. einmal „aktivieren“ drücken (Autoplay-Regel des Browsers).
          </p>
        </div>
      )}
    </div>
  );
};
