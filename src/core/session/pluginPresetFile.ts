/**
 * Plugin-Preset als Datei (STORE-P1-001, Betreiber 2026-10-12)
 * =============================================================
 * Ausnahme von „Nichts auf den Geräten" (AGENTS.md §2.2): eigene Presets
 * dürfen ausdrücklich per Nutzeraktion als Datei exportiert und wieder
 * importiert werden. Die Quelle der Wahrheit bleibt der Plugin-Stand in der
 * Session (pluginSettingsSync.ts): der Import schreibt über genau diesen Pfad
 * und nur, wenn der Nutzer das Plugin hält (zentraler Lock).
 *
 * Diese Datei ist rein (kein Browser, kein Socket) und damit testbar.
 * Datei-Dialoge/Downloads liegen ausschließlich in src/utils/userExport.ts.
 */
import { z } from 'zod';
import { MAX_PLUGIN_SETTINGS_CHARS } from './authoritativeSession';
import { resolveCanonicalPluginId } from '../../plugins/legacyAliases';
import type { PluginSettings } from './pluginSettingsSync';

export const PLUGIN_PRESET_FORMAT = 'audiomonastry.plugin-preset';
export const PLUGIN_PRESET_SCHEMA_VERSION = 1;
/** Obergrenze für die Datei selbst (Stand + Hülle), vor dem JSON-Parse geprüft. */
export const MAX_PLUGIN_PRESET_FILE_CHARS = MAX_PLUGIN_SETTINGS_CHARS + 4 * 1024;

const settingsSchema = z.record(z.string(), z.unknown());

export const pluginPresetFileSchema = z.object({
  format: z.literal(PLUGIN_PRESET_FORMAT),
  schemaVersion: z.number().int().positive(),
  pluginId: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
  exportedAt: z.string().max(64).optional(),
  settings: settingsSchema,
});

export type PluginPresetFile = z.infer<typeof pluginPresetFileSchema>;

export type PresetImportError =
  | 'TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_SCHEMA'
  | 'UNSUPPORTED_VERSION'
  | 'WRONG_PLUGIN'
  | 'NOT_HOLDER';

export type PresetParseResult =
  | { ok: true; preset: PluginPresetFile; message: string }
  | { ok: false; error: PresetImportError; message: string };

/** Gleiche Plugin-Identität, auch über Legacy-Aliase (z. B. recording → record). */
export function samePluginId(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = resolveCanonicalPluginId(a);
  return ca !== null && ca === resolveCanonicalPluginId(b);
}

/** Baut die Exportdatei aus dem aktuellen Session-Stand. */
export function buildPluginPresetFile(pluginId: string, settings: PluginSettings, opts: { name?: string; now?: Date } = {}): PluginPresetFile {
  return {
    format: PLUGIN_PRESET_FORMAT,
    schemaVersion: PLUGIN_PRESET_SCHEMA_VERSION,
    pluginId,
    ...(opts.name ? { name: opts.name.slice(0, 120) } : {}),
    exportedAt: (opts.now ?? new Date()).toISOString(),
    settings: JSON.parse(JSON.stringify(settings)) as PluginSettings,
  };
}

export function serializePluginPresetFile(preset: PluginPresetFile): string {
  return `${JSON.stringify(preset, null, 2)}\n`;
}

/** Dateiname ohne Pfad-/Sonderzeichen, z. B. `audiomonastry-eq-preset-2026-10-13.json`. */
export function pluginPresetFileName(pluginId: string, now: Date = new Date()): string {
  const id = pluginId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'plugin';
  return `audiomonastry-${id}-preset-${now.toISOString().slice(0, 10)}.json`;
}

/** Liest und prüft eine Preset-Datei für genau dieses Plugin. */
export function parsePluginPresetFile(text: string, expectedPluginId: string): PresetParseResult {
  if (typeof text !== 'string' || text.length > MAX_PLUGIN_PRESET_FILE_CHARS) {
    return { ok: false, error: 'TOO_LARGE', message: 'Preset-Datei ist zu groß.' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'INVALID_JSON', message: 'Keine gültige JSON-Datei.' };
  }
  const parsed = pluginPresetFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'INVALID_SCHEMA', message: 'Keine audioMONASTRY-Preset-Datei (Schema stimmt nicht).' };
  }
  const preset = parsed.data;
  if (preset.schemaVersion !== PLUGIN_PRESET_SCHEMA_VERSION) {
    return { ok: false, error: 'UNSUPPORTED_VERSION', message: `Preset-Schema v${preset.schemaVersion} wird nicht unterstützt (erwartet v${PLUGIN_PRESET_SCHEMA_VERSION}).` };
  }
  if (!samePluginId(preset.pluginId, expectedPluginId)) {
    return { ok: false, error: 'WRONG_PLUGIN', message: `Preset gehört zu „${preset.pluginId}", nicht zu „${expectedPluginId}".` };
  }
  if (JSON.stringify(preset.settings).length > MAX_PLUGIN_SETTINGS_CHARS) {
    return { ok: false, error: 'TOO_LARGE', message: 'Plugin-Stand im Preset ist zu groß.' };
  }
  return { ok: true, preset, message: 'Preset gültig.' };
}

export interface PresetImportTarget {
  /** Hält dieser Nutzer das Plugin (zentraler Lock)? */
  isHolder(pluginId: string): boolean;
  /** Bestehender Plugin-Settings-Pfad (PluginSettingsStore.write). */
  write(pluginId: string, settings: PluginSettings): void;
  /** Sofort an den Server senden (ausdrückliche Nutzeraktion). */
  flush(pluginId: string): void;
}

/**
 * Import: erst Lock prüfen (fremder Lock → nichts lesen, nichts schreiben),
 * dann Datei prüfen, dann über den Plugin-Settings-Pfad schreiben und sofort
 * an die Session senden.
 */
export function importPluginPresetText(text: string, pluginId: string, target: PresetImportTarget): PresetParseResult {
  if (!target.isHolder(pluginId)) {
    return { ok: false, error: 'NOT_HOLDER', message: 'Import nur für den Halter des Plugins.' };
  }
  const result = parsePluginPresetFile(text, pluginId);
  if (!result.ok) return result;
  target.write(pluginId, result.preset.settings);
  target.flush(pluginId);
  return result;
}
