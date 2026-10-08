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

/**
 * DA-2026-09-29-036: Presets wurden per JSON.parse ungeprueft in den Audio-Graph
 * geladen. Ein Preset kann damit beliebige Keys setzen und NaN/Infinity/null in
 * AudioParam-Werte schreiben. Hier wird beim Einlesen hart validiert:
 * - unbekannte Felder werden verworfen (nur die bekannten TrackPreset-Felder bleiben)
 * - presetData wird auf flache, endliche Zahlenwerte reduziert und geklemmt
 * - das Original-Objekt wird NICHT mutiert
 * Bewusst tolerant gegenueber alten Eintraegen: fehlerhafte Presets werden
 * uebersprungen statt den ganzen Ladevorgang abzubrechen.
 */
const PRESET_PARAM_RANGE: Record<string, [number, number]> = {
  gain: [-60, 12],
  pan: [-1, 1],
  detune: [-2400, 2400],
  frequency: [0, 24000],
  q: [0.0001, 100],
  mix: [0, 1],
  drive: [0, 50],
  attack: [0, 30],
  release: [0, 30],
};
const PRESET_PARAM_DEFAULT_RANGE: [number, number] = [-100_000, 100_000];
const PRESET_NAME_MAX = 200;

function sanitizePresetData(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const [min, max] = PRESET_PARAM_RANGE[key] ?? PRESET_PARAM_DEFAULT_RANGE;
    clean[key] = Math.min(max, Math.max(min, value));
  }
  return clean;
}

function sanitizePreset(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const data = sanitizePresetData(source.presetData);
  const name = typeof source.name === 'string' ? source.name.slice(0, PRESET_NAME_MAX) : '';
  if (!name && Object.keys(data).length === 0) return null;
  const clean: Record<string, unknown> = {
    schemaVersion: 1,
    name,
    presetData: data,
  };
  for (const key of ['id', 'trackId', 'createdAt', 'userId'] as const) {
    const value = source[key];
    if (typeof value === 'string') clean[key] = value.slice(0, PRESET_NAME_MAX);
  }
  return clean;
}

function readLocalPresets(): any[] {
  try {
    const raw = storageGet(LOCAL_PRESETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizePreset).filter((p): p is Record<string, unknown> => p !== null);
  } catch {
    return [];
  }
}

function writeLocalPresets(items: any[]) {
  try {
    const clean = (Array.isArray(items) ? items : [])
      .map(sanitizePreset)
      .filter((p): p is Record<string, unknown> => p !== null);
    storageSet(LOCAL_PRESETS_KEY, JSON.stringify(clean));
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
