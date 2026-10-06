import React, { useState } from 'react';
import { Copy, GripVertical, Lock, LockOpen, RefreshCw } from 'lucide-react';
import { getPluginThemeClass } from '../utils/pluginTheme';
import type { PluginMode } from '../core/session/pluginMode';
import { MONK_DRAG_MIME, MONK_SCRATCH_MIME, readMonkDragItem, type ScratchpadDragItem } from '../core/session/sessionScratchpad';

interface RackRowProps {
  id: string;
  name: string;
  short: string;
  /** Nummer in Kopfreihenfolge, zweistellig ("01"–"16"). */
  number?: string;
  icon: React.ComponentType<{ size?: number | string; className?: string; style?: React.CSSProperties }>;
  /** Sichtbarer Modus (UI2-P0-002): OFF frei · STBY gehalten, Bypass · ON aktiv. */
  mode: PluginMode;
  /** Anzeigename des Halters (null = frei). */
  ownerLabel: string | null;
  ownedByMe: boolean;
  lockedByOther: boolean;
  /** Bedienfläche sichtbar (nur Halter bei ON; mixerMONK: nur Halter). */
  panelOpen: boolean;
  /** Zeile für alle, die die Bedienfläche nicht sehen. */
  summary?: string;
  /** Modul klingt gerade (Button leuchtet). */
  running?: boolean;
  /** Modus-Button rechts: OFF → STBY → ON → OFF. */
  onCycle: () => void;
  /** Gesetzt = Modus-Button gesperrt (Tooltip-Text, z. B. mixerMONK, fremdes Plugin). */
  cycleLockedReason?: string;
  /** SYNC gegen Main (UI2-P0-003), nur für spielende Plugins. */
  sync?: { on: boolean; onToggle: () => void; disabled?: boolean };
  /** Zusätzliche Kopfzeilen-Elemente (z. B. Mixer-Übergabe). */
  headerExtra?: React.ReactNode;
  /** P1-4: „In Zwischenablage senden" – kopiert Plugin-State/Config als JSON. */
  onCopy?: () => void;
  /** P1-4: Scratchpad-Eintrag auf dieses Modul ziehen → laden/anwenden. */
  onLoadScratch?: (entry: ScratchpadDragItem) => void;
  /** Bedienfläche auch eingeklappt gemountet halten (versteckt), damit ihr
   *  gespiegelter Zustand bei einer Übergabe erhalten bleibt (mixerMONK). */
  keepMounted?: boolean;
  /** Formate: Handy hochkant – kompakte Kopfzeile, Bedienfläche nur auf Wunsch. */
  simplified?: boolean;
  children?: React.ReactNode;
}

const MODES: PluginMode[] = ['OFF', 'STBY', 'ON'];

/**
 * RackRow – ein Plugin-Streifen nach docs/UI_SPEC.md und dem Entwurf
 * docs/design/audioMONASTRY-design.html: Nummer, Name in Modulfarbe,
 * Modus-Anzeige, Schloss mit Halter, SYNC, rechts der Modus-Button.
 * Fremde Plugins sind eingeklappt und gesperrt (kein Anfragen, kein Übernehmen).
 */
export const RackRow = React.memo(function RackRow({
  id,
  name,
  short,
  number,
  icon: Icon,
  mode,
  ownerLabel,
  ownedByMe,
  lockedByOther,
  panelOpen,
  summary,
  running = false,
  onCycle,
  cycleLockedReason,
  sync,
  headerExtra,
  onCopy,
  onLoadScratch,
  keepMounted = false,
  simplified = false,
  children,
}: RackRowProps) {
  // Handy hochkant: Bedienflächen sind für das Querformat gebaut. Sie öffnen
  // hier nur auf ausdrücklichen Wunsch und scrollen dann in sich, nie die Seite.
  const [openHere, setOpenHere] = useState(false);
  const showPanel = panelOpen && (!simplified || openHere);
  const active = mode !== 'OFF';
  const nextHint = mode === 'OFF' ? 'Tippen: holen (STBY)' : mode === 'STBY' ? 'Tippen: aktivieren (ON)' : 'Tippen: freigeben (OFF)';

  return (
    <section
      id={`rack-${id}`}
      data-plugin-mode={mode}
      data-plugin-owner={ownedByMe ? 'me' : ownerLabel ? 'other' : 'none'}
      className={`rounded-xl border transition-all duration-300 ${getPluginThemeClass(id)} ${active ? 'bg-cyan-950/10' : 'border-neutral-800/80 bg-black/50'}`}
      style={active ? { borderColor: 'var(--monk-accent)', boxShadow: '0 0 24px -10px var(--monk-glow-accent)' } : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MONK_SCRATCH_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const entry = readMonkDragItem(e, MONK_SCRATCH_MIME);
        if (entry && onLoadScratch && ownedByMe) {
          e.preventDefault();
          onLoadScratch(entry);
        }
      }}
    >
      <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
        {!simplified && <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(MONK_DRAG_MIME, JSON.stringify({ type: 'module', id, name, state: mode } satisfies ScratchpadDragItem));
            e.dataTransfer.effectAllowed = 'copy';
          }}
          aria-label={`${name} in den Zwischenspeicher ziehen`}
          className="shrink-0 text-neutral-700 hover:text-neutral-400 cursor-grab active:cursor-grabbing p-0.5"
        >
          <GripVertical size={14} />
        </span>}
        <span
          className="w-9 h-9 shrink-0 rounded-lg border flex items-center justify-center bg-black/60"
          style={{ borderColor: 'var(--monk-accent)', color: 'var(--monk-accent)' }}
          title={short}
        >
          <Icon size={18} />
        </span>

        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-black tracking-[0.12em] truncate" style={{ color: 'var(--monk-accent)' }}>
            {number && <span className="font-mono text-neutral-500 mr-1.5">{number}</span>}
            {name}
          </h3>
          {!simplified && <span className="inline-flex gap-1" role="img" aria-label={`Modus ${mode}`}>
            {MODES.map((m) => (
              <span
                key={m}
                className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider border ${m === mode ? '' : 'border-neutral-700 text-neutral-600'}`}
                style={m === mode ? (m === 'ON' ? { background: 'var(--monk-accent)', borderColor: 'var(--monk-accent)', color: '#06101c' } : { borderColor: 'var(--monk-accent)', color: m === 'OFF' ? '#d9e2f2' : 'var(--monk-accent)' }) : undefined}
              >
                {m}
              </span>
            ))}
          </span>}
          <span className={`inline-flex items-center gap-1 text-[10px] font-mono ${lockedByOther ? 'text-red-300' : 'text-neutral-400'}`}>
            {lockedByOther ? <Lock size={12} aria-hidden="true" /> : <LockOpen size={12} aria-hidden="true" />}
            {ownerLabel ? (ownedByMe ? 'du' : ownerLabel) : 'frei'}
          </span>
          {headerExtra}
        </div>

        {sync && (
          <button
            type="button"
            onClick={sync.onToggle}
            disabled={sync.disabled}
            aria-pressed={sync.on}
            aria-label={`${name} SYNC gegen Main ${sync.on ? 'an' : 'aus'}`}
            title={sync.disabled ? 'SYNC kann nur der Halter ändern' : 'SYNC: Start auf dem nächsten Main-Takt, taktgleich mit Main, Tempo und Tonart von Main'}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[10px] font-bold tracking-widest transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--monk-accent)]"
            style={sync.on ? { background: 'var(--monk-accent)', borderColor: 'var(--monk-accent)', color: '#06101c' } : { borderColor: '#3a465c', color: '#8b9aa5' }}
          >
            <RefreshCw size={11} aria-hidden="true" /> SYNC
          </button>
        )}
        {onCopy && ownedByMe && !simplified && (
          <button
            type="button"
            onClick={onCopy}
            aria-label={`${name} in Zwischenablage senden`}
            className="w-8 h-8 shrink-0 rounded-full border border-neutral-700 text-neutral-400 hover:text-amber-300 hover:border-amber-400/40 flex items-center justify-center transition-colors cursor-pointer"
          >
            <Copy size={13} />
          </button>
        )}
        <button
          type="button"
          onClick={onCycle}
          disabled={!!cycleLockedReason}
          title={cycleLockedReason ?? nextHint}
          aria-label={`${name} Modus ${mode}`}
          className={`min-w-[4.5rem] h-8 shrink-0 px-3 rounded-full border-[1.5px] inline-flex items-center justify-center gap-1.5 text-[11px] font-black tracking-widest transition-all cursor-pointer disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--monk-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black ${running && mode === 'ON' ? 'motion-safe:animate-pulse' : ''}`}
          style={
            lockedByOther
              ? { borderColor: '#7f1d1d', color: '#fca5a5', opacity: 0.85 }
              : mode === 'ON'
                ? { background: 'var(--monk-accent)', borderColor: 'var(--monk-accent)', color: '#06101c', boxShadow: '0 0 14px var(--monk-glow-accent)' }
                : mode === 'STBY'
                  ? { borderColor: 'var(--monk-accent)', color: 'var(--monk-accent)' }
                  : { borderColor: '#3a465c', color: '#8b9aa5' }
          }
        >
          {lockedByOther && <Lock size={12} aria-hidden="true" />}
          {mode}
        </button>
      </div>

      {!panelOpen && summary ? (
        <p className={`px-3 pb-2.5 text-[11px] text-neutral-400 ${simplified ? '' : 'pl-[4.25rem]'}`}>{summary}</p>
      ) : null}
      {panelOpen && simplified ? (
        <div className="flex items-center gap-2 px-3 pb-2.5 text-[11px] text-neutral-400" data-testid={`panel-hint-${id}`}>
          <span className="flex-1">{openHere ? 'Bedienfläche hier geöffnet (waagerecht wischbar).' : 'Bedienfläche im Querformat – Handy drehen.'}</span>
          <button
            type="button"
            onClick={() => setOpenHere((v) => !v)}
            aria-expanded={openHere}
            aria-label={`${name} Bedienfläche ${openHere ? 'ausblenden' : 'hier öffnen'}`}
            className="px-2.5 py-1 rounded-full border text-[10px] font-bold tracking-widest cursor-pointer"
            style={{ borderColor: 'var(--monk-accent)', color: 'var(--monk-accent)' }}
          >
            {openHere ? 'AUSBLENDEN' : 'HIER ÖFFNEN'}
          </button>
        </div>
      ) : null}
      {children && (showPanel || keepMounted) ? (
        <div className="px-3 pb-3 border-t border-white/5 min-w-0 overflow-x-auto" hidden={!showPanel}>
          <div className="pt-3">{children}</div>
        </div>
      ) : null}
    </section>
  );
});
