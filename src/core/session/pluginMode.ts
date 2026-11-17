/**
 * Betreiberkorrektur 2026-11-13: AUS / AN / KI, unabhängig vom Collaboration-Lock.
 * ================================================================================
 * Reine Abbildung der sichtbaren Modi auf die zwei vorhandenen Wahrheiten:
 *   - Modul-Zustand (`ModuleState`, repliziert: 'OFF' | 'AUTO_AI' | 'PRO')
 *   - zentraler Collaboration-Lock (serverautoritativ, wer hält das Plugin)
 *
 *   OFF  = kein Halter, Modul aus      → frei, jeder darf es holen
 *   ON   = PRO, manuell aktiv
 *   AI   = AUTO_AI, bestehende pluginbezogene KI-Steuerung
 *
 * mixerMONK ist immer ON und hat immer genau einen Halter (Server, UI2-P0-001).
 * Fremde Plugins sind gesperrt: kein Anfragen, kein Übernehmen.
 * KI gibt den menschlichen Lock nach serverattestierter Delegation frei; ein neuer Halter widerruft die Generation.
 */

export type PluginMode = 'OFF' | 'ON' | 'AI';
export const PLUGIN_MODE_LABELS: Record<PluginMode, string> = { OFF: 'Aus', ON: 'An', AI: 'KI' };

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
export function pluginModeOf(id: string, state: string | undefined, _lock: ModeLock | undefined): PluginMode {
  if (id === MIXER_ID) return 'ON';
  if (state === 'AUTO_AI') return 'AI';
  return state === 'PRO' ? 'ON' : 'OFF';
}

export type ModeStep =
  | { kind: 'acquire' }   // OFF → ON: nach serverbestätigtem Lock einschalten
  | { kind: 'activate' }
  | { kind: 'automate' }  // ON → AI: vorhandenes AUTO_AI
  | { kind: 'release' }   // ON → OFF: Modul aus, Lock freigeben
  | { kind: 'denied'; reason: string };

/** Keyboard/cycle fallback: OFF → ON → AI → OFF. Mixer remains continuously on. */
export function nextModeStep(id: string, mode: PluginMode, owner: string | null, me: string): ModeStep {
  if (id === MIXER_ID) return { kind: 'denied', reason: 'mixerMONK ist nicht schließbar. Der Halter kann ihn nur übergeben.' };
  if (owner && owner !== me) return { kind: 'denied', reason: `Belegt von ${owner}. Anfragen oder Übernehmen gibt es nicht.` };
  if (!owner) return { kind: 'acquire' };
  if (mode === 'OFF') return { kind: 'activate' };
  if (mode === 'ON') return { kind: 'automate' };
  return { kind: 'release' };
}

/** Darf die Bedienfläche für diesen Nutzer offen sein? */
export function pluginPanelOpen(id: string, mode: PluginMode, owner: string | null, me: string): boolean {
  if (id === MIXER_ID) return owner === me;
  return mode !== 'OFF' && owner === me;
}

/** Text für Nutzer, die das Plugin nicht bedienen (eingeklappte Zeile). */
export function pluginSummary(id: string, mode: PluginMode, owner: string | null, me: string, ownerName = owner ?? ''): string {
  if (id === MIXER_ID) return owner === me ? '' : owner ? `Gehalten von ${ownerName}. Nur der Halter bedient den Mixer und startet Ton auf Main.` : 'Wird gerade vergeben.';
  if (!owner) return mode !== 'OFF' ? 'Läuft ohne Halter. Betriebsmodus wählen, um es zu übernehmen.' : 'Frei. An oder KI wählen, um es zu aktivieren.';
  if (owner !== me) return `Gehalten von ${ownerName} · ${mode}.`;
  return mode === 'OFF' ? 'Aus (Bypass). An oder KI wählen, um es zu aktivieren.' : '';
}
