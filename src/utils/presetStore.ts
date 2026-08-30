/**
 * Lokaler Preset-Store (Cloud-/Anbieter-ENTKOPPELT).
 *
 * Dieses Modul bietet KEINERLEI Verbindung zu externen Cloud-Anbietern.
 * Es ist ein reiner lokaler Adapter, der die bisherige Export-Oberflaeche
 * (`db`, `savePresetToCloud`, `fetchPresetsFromCloud`, ...) beibehält, damit
 * andere Module weiterhin importieren koennen, ohne dass irgendeine
 * Cloud-/Anbieter-Verbindung aufgebaut wird.
 *
 * Speicherung erfolgt ausschliesslich im Browser (localStorage).
 */
import type { TrackPreset } from '../types';
import { random } from './random';
import { storageGet, storageSet } from './storage';

export const db: unknown = null;

// Lokale Liste gespeicherter Presets (Persistenz im Browser)
const LOCAL_PRESETS_KEY = 'audiomonastry_local_presets';

function readLocalPresets(): any[] {
  try {
    const raw = storageGet(LOCAL_PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLocalPresets(items: any[]) {
  try {
    storageSet(LOCAL_PRESETS_KEY, JSON.stringify(items));
  } catch (e) {
    console.error('Could not persist local presets:', e);
  }
}

// Stellt die Verbindung dar – lokaler No-Op (keine Netzwerkverbuelt)
export async function testConnection(): Promise<boolean> {
  return true;
}

// Speichert ein Preset LOKAL (statt in die Cloud).
export async function savePresetToCloud(preset: any): Promise<string> {
  const entries = readLocalPresets();
  const id = 'local_' + Date.now() + '_' + random().toString(36).slice(2, 8);
  entries.unshift({ ...preset, id, createdAt: new Date().toISOString() });
  writeLocalPresets(entries.slice(0, 50)); // max. 50 lokale Presets
  return id;
}

// Laedt lokal gespeicherte Presets.
export async function fetchPresetsFromCloud(): Promise<TrackPreset[]> {
  return readLocalPresets();
}

// Seed-Funktion: lokale Basis-Datensaetze (kein Cloud-Zugriff).
export async function seedDatabase() {
  return { success: true, message: 'Local mode: no remote seeding needed.' };
}

// Upload-Funktion: im lokalen Modus wird nur der Dateiname zurueckgegeben.
export async function uploadAudioElementToCloud(
  file: File,
  name: string,
  _type: 'sample' | 'song' | 'noise',
  tags: string[],
): Promise<{ success: boolean; message: string }> {
  try {
    readLocalPresets(); // (no-op, keeps imports used)
    return {
      success: true,
      message: `[Lokal] ${name} mit Tags ${tags.join(', ') || '(keine)'} registriert (Datei: ${file.name}).`,
    };
  } catch (err) {
    return { success: false, message: 'Lokaler Upload fehlgeschlagen: ' + (err as Error).message };
  }
}
