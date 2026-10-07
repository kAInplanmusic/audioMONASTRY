
/**
 * Status der Kopf-Symbole (UI2-P1-003, docs/UI_SPEC.md „Kopf-Icons“).
 * Gezeichnet werden die Symbole in App.tsx nach dem Entwurf (`am-ic`).
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
