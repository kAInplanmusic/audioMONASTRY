/**
 * Piano-Roll Persistenz-Adapter (ZUK-001)
 * =======================================
 * Kapselt Lesen/Schreiben der Piano-Roll-Noten über den zentralen
 * Plugin-Settings-Mechanismus (`src/utils/pluginSettings.ts`).
 * Wird von `PianoRollTerminal` (UI) aufgerufen – KEIN Store-Import hier,
 * damit der Core-Store browserfrei bleibt.
 */
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { PIANO_ROLL_STORE_ID } from '../../core/sequencer/pianoRollStore';
import type { PianoRollStoreSettings } from '../../core/sequencer/pianoRollStore';

/** Liest den gespeicherten Stand (oder null, wenn noch keiner). */
export function readPersistedPianoRoll(): PianoRollStoreSettings | null {
  try {
    // section = undefined, kein legacyKey (reiner Session-Store)
    return readPluginSettings<PianoRollStoreSettings>(PIANO_ROLL_STORE_ID) ?? null;
  } catch {
    return null;
  }
}

/** Schreibt den aktuellen Stand (entprellt + Holder-Check im Store). */
export function writePersistedPianoRoll(settings: PianoRollStoreSettings): void {
  try {
    writePluginSettings(PIANO_ROLL_STORE_ID, settings);
  } catch {
    /* Persistenzfehler dürfen die UI nicht crashen */
  }
}