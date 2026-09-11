import React, { useState } from 'react';
import { Link2, MonitorSpeaker, Monitor, Radio } from 'lucide-react';

/**
 * OutputsPanel – Erreichbarkeit der beiden Ghost-User (fixe Andock-URLs).
 *
 *   Ghostuser 5  →  /master-out  (Mainsound an PA/Verstärker)
 *   Ghostuser 6  →  /visual-out  (Visualisierung an Beamer)
 *
 * Beide Seiten zählen NICHT zu den 4 Session-Usern. Die URLs werden aus der
 * aktuellen Origin gebildet, damit sie auf jeder Instanz (lokal, Hetzner,
 * anunnakitools.de) stimmen.
 */
const OUTPUTS = [
  {
    id: 'master-out',
    label: 'MAIN SOUND',
    role: 'Ghostuser 5',
    path: '/master-out',
    alias: '/ghost/5',
    hint: 'Laptop an der PA/Verstärker – gibt den Master-Ton des Hosts aus.',
    Icon: Radio,
  },
  {
    id: 'visual-out',
    label: 'VISUAL',
    role: 'Ghostuser 6',
    path: '/visual-out',
    alias: '/ghost/6',
    hint: 'Beamer – im Studio „VISUAL" öffnen und „AN GHOSTUSER 6" drücken.',
    Icon: Monitor,
  },
] as const;

export const OutputsPanel: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string>('');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

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
        aria-label="Output-Verbindungen"
        aria-expanded={open}
        title="Ausgabe-Endpunkte: Mainsound (PA) und Visualisierung (Beamer)"
        className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-neutral-900/80 border border-neutral-800 text-neutral-300 hover:border-emerald-400/50 hover:text-emerald-300 transition-colors cursor-pointer"
      >
        <MonitorSpeaker className="w-4 h-4" />
        <span className="text-[9px] font-bold tracking-widest">OUTPUTS</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 z-[70] rounded-xl border border-white/10 bg-[#0b0f14]/98 backdrop-blur-xl shadow-2xl p-3">
          <div className="flex items-center gap-2 mb-2">
            <Link2 className="w-3.5 h-3.5 text-emerald-300" />
            <span className="text-[10px] font-bold tracking-widest text-neutral-200">AUSGABE-ENDPUNKTE</span>
          </div>

          {OUTPUTS.map(({ id, label, role, path, alias, hint, Icon }) => {
            const url = `${origin}${path}`;
            return (
              <div key={id} className="mb-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                <div className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5 text-cyan-300" />
                  <span className="text-[10px] font-bold tracking-widest text-neutral-100">{label}</span>
                  <span className="text-[9px] text-neutral-500">{role}</span>
                </div>
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
                <p className="mt-0.5 text-[9px] text-neutral-600">Alias: {alias} · zählt nicht als Session-User</p>
              </div>
            );
          })}

          <p className="text-[9px] leading-snug text-neutral-500">
            Beide Seiten docken automatisch an die Studio-Session an. Auf dem Ausgabegerät ggf. einmal
            „aktivieren" drücken (Autoplay-Policy).
          </p>
        </div>
      )}
    </div>
  );
};
