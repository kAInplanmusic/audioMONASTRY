import React from 'react';
import { AM_MODULE, AM_PATH, AmMark, AmSvg, amColor } from './am/amUi';
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
  /** Farbe des Halters (Nutzer 1–4). */
  ownerColor?: string;
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
  icon: _icon,
  mode,
  ownerLabel,
  ownerColor,
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
  children,
}: RackRowProps) {
  const showPanel = panelOpen;
  const active = mode !== 'OFF';
  const nextHint = mode === 'OFF' ? 'Tippen: holen (STBY)' : mode === 'STBY' ? 'Tippen: aktivieren (ON)' : 'Tippen: freigeben (OFF)';

  const color = amColor(id);
  const sub = AM_MODULE[id];
  const locked = lockedByOther || (!!cycleLockedReason && mode === 'ON');
  const pwClass = locked ? 'am-tk' : mode === 'ON' ? `am-on${running ? ' am-run' : ''}` : mode === 'STBY' ? 'am-stby' : '';

  return (
    <section
      id={`rack-${id}`}
      data-plugin-mode={mode}
      data-plugin-owner={ownedByMe ? 'me' : ownerLabel ? 'other' : 'none'}
      className={`am-box am-st ${showPanel ? 'am-open' : ''} ${getPluginThemeClass(id)}`}
      style={{ ['--c' as string]: color, ['--u' as string]: ownerColor ?? '#ffffff', ...(active ? { borderColor: `color-mix(in srgb, ${color} 55%, var(--ln2))` } : {}) }}
      aria-label={name}
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
      <div className="am-sh">
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(MONK_DRAG_MIME, JSON.stringify({ type: 'module', id, name, state: mode } satisfies ScratchpadDragItem));
            e.dataTransfer.effectAllowed = 'copy';
          }}
          aria-label={`${name} in den Zwischenspeicher ziehen`}
          title={`${short}: in den Zwischenspeicher ziehen`}
          style={{ cursor: 'grab', display: 'inline-flex' }}
        >
          <AmMark />
        </span>
        <div className="am-nm">
          <h2>
            {number && <i>{number}</i>}
            <em style={{ color: 'var(--c)' }}>{name.replace(/MONK$/, '')}</em>MONK
          </h2>
          <span className="am-chips3" role="img" aria-label={`Modus ${mode}`}>
            {MODES.map((m) => (
              <span key={m} className={m === mode ? `am-on ${m === 'STBY' ? 'am-st2' : m === 'OFF' ? 'am-off' : ''}` : ''}>{m}</span>
            ))}
          </span>
          <svg className={`am-lk ${lockedByOther ? 'am-red' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
            <path d={lockedByOther ? AM_PATH.lock : AM_PATH.unlock} />
          </svg>
          <span className="am-who">
            {ownerLabel ? <span className="am-udot" style={{ width: 9, height: 9 }} /> : null}
            {ownerLabel ? (ownedByMe ? 'du' : ownerLabel) : 'frei'}
          </span>
          {sub ? <span className="am-vb">Vorbild: {sub.vb}</span> : null}
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
            className={`am-tg am-sync ${sync.on ? 'am-on' : ''}`}
          >
            ⟲ SYNC
          </button>
        )}
        {onCopy && ownedByMe && (
          <button type="button" onClick={onCopy} aria-label={`${name} in Zwischenablage senden`} title="Stand als JSON in die Zwischenablage" className="am-tool">
            <AmSvg d={AM_PATH.clip} />
          </button>
        )}
        <button
          type="button"
          onClick={onCycle}
          disabled={!!cycleLockedReason}
          title={cycleLockedReason ?? nextHint}
          aria-label={`${name} Modus ${mode}`}
          className={`am-pw ${pwClass}`}
        >
          {locked && <AmSvg d={AM_PATH.lock} />}
          {mode}
        </button>
      </div>

      {!showPanel && summary ? <div className="am-sum">{summary}</div> : null}
      {children && (showPanel || keepMounted) ? (
        <div className="am-sb" hidden={!showPanel}>{children}</div>
      ) : null}
    </section>
  );
});
