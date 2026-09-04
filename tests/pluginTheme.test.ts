/**
 * P1-2 Plugin-Theme-Tests (CSS-Variablen-Themes je Plugin, D8).
 *
 * Stellt sicher, dass:
 *  - jede der 20 Plugin-IDs eine Theme-Klasse bekommt,
 *  - jede Theme-Klasse in `src/index.css` die Akzent-Tokens definiert,
 *  - die Referenz-Looks vollständig gepflegt sind,
 *  - die Theme-Zuordnung keine plugin-lokalen Hex-Werte enthält.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_CLASS,
  PLUGIN_SKIN_REFERENCES,
  PLUGIN_THEME_IDS,
  getPluginSkinReference,
  getPluginThemeClass,
} from '../src/utils/pluginTheme';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../public/plugin-manifest.json'), 'utf8'),
) as { ui_plugins: { id: string }[] };

const indexCss = readFileSync(resolve(__dirname, '../src/index.css'), 'utf8');

describe('pluginTheme (P1-2) – CSS-Variablen-Themes je Plugin', () => {
  it('deckt exakt die 20 Plugins aus dem Manifest ab', () => {
    const manifestIds = manifest.ui_plugins.map((p) => p.id).sort();
    expect(PLUGIN_THEME_IDS).toHaveLength(20);
    expect([...PLUGIN_THEME_IDS].sort()).toEqual(manifestIds);
    expect(new Set(PLUGIN_THEME_IDS).size).toBe(20);
  });

  it('liefert für jede Plugin-ID eine Theme-Klasse mit CSS-Tokens in index.css', () => {
    for (const id of PLUGIN_THEME_IDS) {
      const cls = getPluginThemeClass(id);
      expect(cls).toBe(`monk-theme-${id}`);
      // CSS-Block muss existieren und den Akzent definieren.
      const block = new RegExp(`\\.monk-theme-${id}\\s*\\{[^}]*--monk-accent:`);
      expect(indexCss).toMatch(block);
      expect(indexCss).toContain(`--monk-accent-rgb`);
    }
  });

  it('nutzt einen sicheren Fallback für unbekannte IDs', () => {
    expect(getPluginThemeClass('unbekannt')).toBe(DEFAULT_THEME_CLASS);
    expect(getPluginThemeClass(null)).toBe(DEFAULT_THEME_CLASS);
    expect(getPluginThemeClass(undefined)).toBe(DEFAULT_THEME_CLASS);
  });

  it('hat für alle 20 Plugins einen Referenz-Hardware-Look', () => {
    for (const id of PLUGIN_THEME_IDS) {
      const ref = getPluginSkinReference(id);
      expect(ref.length).toBeGreaterThan(0);
      expect(PLUGIN_SKIN_REFERENCES[id]).toBe(ref);
    }
    expect(getPluginSkinReference('unbekannt')).toBe('Eigenes Theme');
  });

  it('enthält keine Hex-Farbwerte im TS-Modul (Token-Quelle ist nur index.css)', () => {
    const themeModule = readFileSync(resolve(__dirname, '../src/utils/pluginTheme.ts'), 'utf8');
    expect(themeModule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
