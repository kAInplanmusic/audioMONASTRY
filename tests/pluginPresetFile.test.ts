import { describe, expect, it, vi } from 'vitest';
import {
  buildPluginPresetFile,
  importPluginPresetText,
  MAX_PLUGIN_PRESET_FILE_CHARS,
  parsePluginPresetFile,
  pluginPresetFileName,
  PLUGIN_PRESET_FORMAT,
  PLUGIN_PRESET_SCHEMA_VERSION,
  serializePluginPresetFile,
} from '../src/core/session/pluginPresetFile';
import { PluginSettingsStore, type PluginSettingsTransport } from '../src/core/session/pluginSettingsSync';

// ---------------------------------------------------------------------------
// STORE-P1-001: eigene Presets als Datei (Ausnahme AGENTS.md §2.2). Import nur
// mit Plugin-Lock, über den bestehenden Plugin-Settings-Pfad.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-13T10:00:00.000Z');

function storeWith(holder: boolean) {
  const sent: Array<{ pluginId: string; settings: unknown }> = [];
  const transport: PluginSettingsTransport = {
    send: (pluginId, settings) => sent.push({ pluginId, settings }),
    isHolder: () => holder,
    setTimer: () => 1,
    clearTimer: () => undefined,
  };
  const store = new PluginSettingsStore(transport);
  const target = {
    isHolder: (id: string) => transport.isHolder(id),
    write: vi.fn((id: string, s: Record<string, unknown>) => store.write(id, s)),
    flush: vi.fn((id: string) => store.flush(id)),
  };
  return { store, sent, target };
}

describe('Preset-Datei – Export', () => {
  it('enthält Format, Schema-Version, pluginId und eine Kopie des Stands', () => {
    const settings = { gains: [1, 2, 3], q: 0.7 };
    const file = buildPluginPresetFile('eq', settings, { name: 'eqMONK', now: NOW });
    expect(file).toEqual({
      format: PLUGIN_PRESET_FORMAT,
      schemaVersion: PLUGIN_PRESET_SCHEMA_VERSION,
      pluginId: 'eq',
      name: 'eqMONK',
      exportedAt: NOW.toISOString(),
      settings,
    });
    settings.gains.push(4);
    expect(file.settings.gains).toEqual([1, 2, 3]);
  });

  it('Dateiname ohne Sonderzeichen', () => {
    expect(pluginPresetFileName('eq', NOW)).toBe('audiomonastry-eq-preset-2026-10-13.json');
    expect(pluginPresetFileName('../x y', NOW)).toBe('audiomonastry----x-y-preset-2026-10-13.json');
  });

  it('Rundreise Export → Import ergibt denselben Stand', () => {
    const text = serializePluginPresetFile(buildPluginPresetFile('dsp', { cutoff: 1200 }, { now: NOW }));
    const r = parsePluginPresetFile(text, 'dsp');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.preset.settings).toEqual({ cutoff: 1200 });
  });
});

describe('Preset-Datei – Import-Fehlerfälle', () => {
  const valid = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...buildPluginPresetFile('eq', { q: 1 }, { now: NOW }), ...over });

  it('kein JSON', () => {
    expect(parsePluginPresetFile('{nope', 'eq')).toMatchObject({ ok: false, error: 'INVALID_JSON' });
  });

  it('falsches Schema: fremdes Format, fehlende Felder, Settings kein Objekt', () => {
    expect(parsePluginPresetFile(valid({ format: 'other' }), 'eq')).toMatchObject({ ok: false, error: 'INVALID_SCHEMA' });
    expect(parsePluginPresetFile(JSON.stringify({ format: PLUGIN_PRESET_FORMAT, schemaVersion: 1, pluginId: 'eq' }), 'eq')).toMatchObject({ ok: false, error: 'INVALID_SCHEMA' });
    expect(parsePluginPresetFile(valid({ settings: [1, 2] }), 'eq')).toMatchObject({ ok: false, error: 'INVALID_SCHEMA' });
    expect(parsePluginPresetFile(valid({ schemaVersion: '1' }), 'eq')).toMatchObject({ ok: false, error: 'INVALID_SCHEMA' });
    expect(parsePluginPresetFile('[]', 'eq')).toMatchObject({ ok: false, error: 'INVALID_SCHEMA' });
  });

  it('unbekannte Schema-Version', () => {
    expect(parsePluginPresetFile(valid({ schemaVersion: 99 }), 'eq')).toMatchObject({ ok: false, error: 'UNSUPPORTED_VERSION' });
  });

  it('Preset eines anderen Plugins wird abgelehnt, Legacy-Alias wird erkannt', () => {
    expect(parsePluginPresetFile(valid(), 'dsp')).toMatchObject({ ok: false, error: 'WRONG_PLUGIN' });
    const rec = JSON.stringify(buildPluginPresetFile('recording', { inputSource: 'MASTER_OUT' }, { now: NOW }));
    expect(parsePluginPresetFile(rec, 'record').ok).toBe(true);
  });

  it('zu große Datei', () => {
    expect(parsePluginPresetFile('x'.repeat(MAX_PLUGIN_PRESET_FILE_CHARS + 1), 'eq')).toMatchObject({ ok: false, error: 'TOO_LARGE' });
    const bigSettings = valid({ settings: { blob: 'y'.repeat(64 * 1024) } });
    expect(parsePluginPresetFile(bigSettings, 'eq')).toMatchObject({ ok: false, error: 'TOO_LARGE' });
  });
});

describe('Preset-Import über den Plugin-Settings-Pfad', () => {
  const text = serializePluginPresetFile(buildPluginPresetFile('eq', { q: 2, gains: [0, 1] }, { now: NOW }));

  it('fremder Lock: nichts schreiben, nichts senden', () => {
    const { store, sent, target } = storeWith(false);
    const r = importPluginPresetText(text, 'eq', target);
    expect(r).toMatchObject({ ok: false, error: 'NOT_HOLDER' });
    expect(target.write).not.toHaveBeenCalled();
    expect(store.read('eq')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('Halter: Stand landet im Speicher und geht sofort an die Session', () => {
    const { store, sent, target } = storeWith(true);
    const r = importPluginPresetText(text, 'eq', target);
    expect(r.ok).toBe(true);
    expect(store.read('eq')).toEqual({ q: 2, gains: [0, 1] });
    expect(sent).toEqual([{ pluginId: 'eq', settings: { q: 2, gains: [0, 1] } }]);
    expect(store.hasPending('eq')).toBe(false);
  });

  it('Halter, aber falsches Schema: Stand bleibt unverändert', () => {
    const { store, sent, target } = storeWith(true);
    store.write('eq', { q: 5 });
    store.flush('eq');
    sent.length = 0;
    const r = importPluginPresetText(JSON.stringify({ hello: 'world' }), 'eq', target);
    expect(r).toMatchObject({ ok: false, error: 'INVALID_SCHEMA' });
    expect(store.read('eq')).toEqual({ q: 5 });
    expect(sent).toEqual([]);
  });
});
