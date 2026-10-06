/**
 * UI2-P0-002 · Plugin-Modi OFF / STBY / ON (docs/UI_SPEC.md, Betreiber 2026-10-04)
 * ================================================================================
 * Reine Abbildung der sichtbaren Modi auf die zwei vorhandenen Wahrheiten:
 *   - Modul-Zustand (`ModuleState`, repliziert: 'OFF' | 'AUTO_AI' | 'PRO')
 *   - zentraler Collaboration-Lock (serverautoritativ, wer hält das Plugin)
 *
 *   OFF  = kein Halter, Modul aus      → frei, jeder darf es holen
 *   STBY = Halter vorhanden, Modul aus → gemountet, nicht aktiv (Bypass)
 *   ON   = Halter vorhanden, Modul an  → aktiv, Bedienfläche offen
 *
 * mixerMONK ist immer ON und hat immer genau einen Halter (Server, UI2-P0-001).
 * Fremde Plugins sind gesperrt: kein Anfragen, kein Übernehmen.
 * Ein `AUTO_AI` ohne Halter (Altbestand) zählt als ON ohne Halter und wird beim
 * nächsten Tippen geholt.
 */

export type PluginMode = 'OFF' | 'STBY' | 'ON';

export interface ModeLock {
  active?: boolean;
  lockedBy?: string | null;
}

export const MIXER_ID = 'mixer';

/** Halter des Plugins laut Lock, sonst `null`. */
export function pluginOwnerOf(lock: ModeLock | undefined): string | null {
  return lock?.active && lock.lockedBy ? lock.lockedBy : null;
}

/** Sichtbarer Modus aus Modul-Zustand und Lock. */
export function pluginModeOf(id: string, state: string | undefined, lock: ModeLock | undefined): PluginMode {
  if (id === MIXER_ID) return 'ON';
  const owner = pluginOwnerOf(lock);
  const running = !!state && state !== 'OFF';
  if (!owner) return running ? 'ON' : 'OFF';
  return running ? 'ON' : 'STBY';
}

export type ModeStep =
  | { kind: 'acquire' }   // OFF → STBY: Lock holen, Modul bleibt aus
  | { kind: 'activate' }  // STBY → ON: Modul an (PRO), Bedienfläche offen
  | { kind: 'release' }   // ON → OFF: Modul aus, Lock freigeben
  | { kind: 'denied'; reason: string };

/** Nächster Schritt für den Modus-Button rechts am Plugin (OFF → STBY → ON → OFF). */
export function nextModeStep(id: string, mode: PluginMode, owner: string | null, me: string): ModeStep {
  if (id === MIXER_ID) return { kind: 'denied', reason: 'mixerMONK ist nicht schließbar. Der Halter kann ihn nur übergeben.' };
  if (owner && owner !== me) return { kind: 'denied', reason: `Belegt von ${owner}. Anfragen oder Übernehmen gibt es nicht.` };
  if (!owner) return { kind: 'acquire' };
  if (mode === 'STBY') return { kind: 'activate' };
  return { kind: 'release' };
}

/** Darf die Bedienfläche für diesen Nutzer offen sein? */
export function pluginPanelOpen(id: string, mode: PluginMode, owner: string | null, me: string): boolean {
  if (id === MIXER_ID) return owner === me;
  return mode === 'ON' && owner === me;
}

/** Text für Nutzer, die das Plugin nicht bedienen (eingeklappte Zeile). */
export function pluginSummary(id: string, mode: PluginMode, owner: string | null, me: string, ownerName = owner ?? ''): string {
  if (id === MIXER_ID) return owner === me ? '' : owner ? `Gehalten von ${ownerName}. Nur der Halter bedient den Mixer und startet Ton auf Main.` : 'Wird gerade vergeben.';
  if (!owner) return mode === 'ON' ? 'Läuft ohne Halter. Tippe den Modus-Button, um es zu holen.' : 'Frei. Jede Person kann es mit OFF → STBY holen.';
  if (owner !== me) return `Belegt von ${ownerName} · ${mode} · für dich nicht einsehbar.`;
  return mode === 'STBY' ? 'Dir zugeordnet, aber nicht aktiv (Bypass). Tippe STBY, um es zu aktivieren.' : '';
}
