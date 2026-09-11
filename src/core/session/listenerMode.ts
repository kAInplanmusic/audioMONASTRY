/**
 * audioMONASTRY · Session-Modus & Listener (Ghost-User)
 * =====================================================
 * Eine Session hat vier aktive User. Daneben gibt es **Listener**, die NICHT
 * mitzählen und nur einen Ausgabestream empfangen:
 *
 *   `member`      – normaler Session-User (Mikro/State)
 *   `master-out`  – **Ghostuser 5**: Master-Sound an die PA (Seite `/master-out`)
 *   `visual-out`  – **Ghostuser 6**: Visualisierungs-Stream an den Beamer
 *                   (Seite `/visual-out`)
 *
 * Diese Datei ist die einzige Quelle für die Modus-Normalisierung (Server,
 * WebRTC-Manager, Seiten-Routing) – damit können die drei Stellen nicht
 * auseinanderlaufen.
 */

export const LISTENER_MODES = ['master-out', 'visual-out'] as const;

export type SessionMode = 'member' | (typeof LISTENER_MODES)[number];

/** Normalisiert einen beliebigen Modus-String (Server-Payload) auf einen gültigen Modus. */
export function normalizeSessionMode(input: unknown): SessionMode {
  const raw = String(input ?? '').trim();
  return (LISTENER_MODES as readonly string[]).includes(raw) ? (raw as SessionMode) : 'member';
}

/** Ist der Modus ein reiner Listener (zählt nicht zu den 4 Session-Usern)? */
export function isListenerMode(mode: SessionMode): boolean {
  return mode !== 'member';
}

/** Leitet den Modus aus dem URL-Pfad ab (fixe Andock-URLs). */
export function listenerModeForPath(pathname: string): SessionMode {
  const path = String(pathname ?? '');
  if (path.startsWith('/master-out') || path.startsWith('/ghost/5')) return 'master-out';
  if (path.startsWith('/visual-out') || path.startsWith('/ghost/6')) return 'visual-out';
  return 'member';
}

/** Anzeigename/Label je Modus (Statuszeilen, Titel). */
export const SESSION_MODE_LABEL: Record<SessionMode, string> = {
  member: 'Session-User',
  'master-out': 'MASTER OUT (Ghostuser 5)',
  'visual-out': 'VISUAL OUT (Ghostuser 6)',
};
