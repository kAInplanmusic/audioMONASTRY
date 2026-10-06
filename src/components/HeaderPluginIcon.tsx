import React from 'react';
import { getPluginThemeClass } from '../utils/pluginTheme';

/**
 * Kopf-Icon eines Plugins (UI2-P1-003, docs/UI_SPEC.md „Kopf-Icons“).
 *
 * - Symbol und Farbe sind je Plugin einzigartig; die Farbe ist die Modulfarbe
 *   im Rack (`--monk-accent` aus `.monk-theme-<id>`), sie wechselt nie mit dem
 *   Status.
 * - Der Status erscheint nur als Schein hinter dem Icon:
 *   frei = grünlich, von jemand anderem gehalten = dunkelrot,
 *   von mir gehalten = Ring in der Akzentfarbe.
 * - Der Status steht zusätzlich im Text (aria-label/title), nicht nur in Farbe.
 */
export type HeaderIconStatus = 'free' | 'mine' | 'locked';

export interface HeaderLock {
  active?: boolean;
  lockedBy?: string | null;
}

/** Leitet den Kopf-Status aus dem zentralen Collaboration-Lock ab. */
export function headerIconStatus(lock: HeaderLock | undefined, myUserId: string): HeaderIconStatus {
  if (!lock?.active || !lock.lockedBy) return 'free';
  return lock.lockedBy === myUserId ? 'mine' : 'locked';
}

const STATUS_TEXT: Record<HeaderIconStatus, string> = {
  free: 'frei',
  mine: 'von dir gehalten',
  locked: 'gesperrt, von jemand anderem gehalten',
};

const STATUS_SHADOW: Record<HeaderIconStatus, string> = {
  free: '0 0 10px 1px rgba(61, 220, 132, 0.30)',
  locked: '0 0 10px 2px rgba(170, 22, 34, 0.55)',
  mine: '0 0 0 2px var(--monk-accent), 0 0 10px var(--monk-glow-accent)',
};

interface HeaderPluginIconProps {
  id: string;
  name: string;
  label: string;
  icon: React.ComponentType<{ size?: number | string; strokeWidth?: number; className?: string; style?: React.CSSProperties }>;
  status: HeaderIconStatus;
  /** Modul läuft (nicht OFF): kleiner Punkt oben rechts. */
  on: boolean;
  /** Ansicht gerade markiert (Unterstrich). */
  active: boolean;
  onSelect: () => void;
}

export const HeaderPluginIcon = React.memo(function HeaderPluginIcon({
  id,
  name,
  label,
  icon: Icon,
  status,
  on,
  active,
  onSelect,
}: HeaderPluginIconProps) {
  return (
    <button
      type="button"
      data-plugin-id={id}
      data-lock-status={status}
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      aria-label={`${name}, ${STATUS_TEXT[status]}${on ? ', aktiv' : ''}`}
      title={`${name} · ${STATUS_TEXT[status]}`}
      className={`${getPluginThemeClass(id)} relative flex flex-col items-center justify-center gap-0.5 px-1 min-h-0 overflow-hidden text-center transition-colors cursor-pointer ${
        active ? 'bg-[#0f1a22]' : 'hover:bg-white/[0.03]'
      }`}
    >
      <span
        className="flex items-center justify-center w-6 h-5 rounded-md transition-shadow"
        style={{ boxShadow: STATUS_SHADOW[status] }}
      >
        <Icon size={15} strokeWidth={active || on ? 2 : 1.7} style={{ color: 'var(--monk-accent)' }} />
      </span>
      <span
        className={`text-[7px] font-bold tracking-[0.08em] uppercase leading-none truncate max-w-full ${
          active || on ? 'text-neutral-100' : 'text-[#8b9aa5]'
        }`}
      >
        {label}
      </span>
      <span
        className={`absolute bottom-0 left-1/2 -translate-x-1/2 h-[2px] rounded-full transition-all duration-300 ${active ? 'w-6 sm:w-8' : 'w-0'}`}
        style={{ background: 'var(--monk-accent)' }}
      />
      {on && (
        <span
          className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full"
          style={{ background: 'var(--monk-accent)', boxShadow: '0 0 6px var(--monk-glow-accent)' }}
        />
      )}
    </button>
  );
});
