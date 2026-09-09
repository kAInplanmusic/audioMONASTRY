import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CANONICAL_PLUGIN_IDS,
  createPluginAdapters,
} from '../src/plugins/adapters';
import {
  LEGACY_PLUGIN_ALIASES,
  resolveCanonicalPluginId,
} from '../src/plugins/legacyAliases';
import { getPluginRegistry } from '../src/plugins/registry';

const MANIFEST_PATH = path.resolve(process.cwd(), 'public/plugin-manifest.json');

describe('Plugin-Registry-Vertrag (16 kanonische Plugins)', () => {
  it('Registry enthält exakt 16 kanonische IDs', () => {
    const registry = getPluginRegistry();
    const ids = registry.map((p) => p.id).sort();
    expect(ids).toEqual([...CANONICAL_PLUGIN_IDS].sort());
    expect(ids).toHaveLength(16);
  });

  it('keine ID ist doppelt vorhanden', () => {
    const ids = getPluginRegistry().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Systemmodule sind nicht in der Registry', () => {
    const ids = new Set(getPluginRegistry().map((p) => p.id));
    expect(ids.has('masterplayer')).toBe(false);
    expect(ids.has('ai')).toBe(false);
    expect(ids.has('performance')).toBe(false);
    expect(ids.has('perfor')).toBe(false);
    expect(ids.has('controller')).toBe(false);
  });

  it('public/plugin-manifest.json und Built-in-Fallback sind mengenidentisch', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      ui_plugins: Array<{ id: string }>;
    };
    const manifestIds = manifest.ui_plugins.map((p) => p.id).sort();
    const registryIds = getPluginRegistry().map((p) => p.id).sort();
    expect(manifestIds).toEqual(registryIds);
  });

  it('jeder Registry-Eintrag besitzt ein Adapterobjekt', () => {
    for (const plugin of getPluginRegistry()) {
      expect(plugin.adapter).toBeTruthy();
      expect(typeof plugin.adapter.process).toBe('function');
      expect(plugin.adapter.manifest.id).toBe(plugin.id);
    }
  });

  it('alle Legacy-Aliase lösen auf eine kanonische ID auf', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_PLUGIN_ALIASES)) {
      expect(resolveCanonicalPluginId(legacy)).toBe(canonical);
      expect(CANONICAL_PLUGIN_IDS).toContain(canonical);
    }
  });

  it('Systemmodule werden nicht als kanonische Plugins aufgelöst', () => {
    for (const id of ['masterplayer', 'ai', 'performance', 'perfor', 'controller']) {
      expect(resolveCanonicalPluginId(id)).toBeNull();
    }
  });

  it('createPluginAdapters liefert exakt 16 eindeutige Adapter', () => {
    const adapters = createPluginAdapters();
    const ids = Object.values(adapters).map((a) => a.manifest.id).sort();
    expect(ids).toEqual([...CANONICAL_PLUGIN_IDS].sort());
    expect(new Set(ids).size).toBe(16);
  });
});
