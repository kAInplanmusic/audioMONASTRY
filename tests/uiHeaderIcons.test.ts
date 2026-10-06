/**
 * UI2-P1-003 / UI2-P1-005 / UI2-P2-003 – Kopf-Icons, Versionsquelle, Engine-Status.
 *
 * - 16 Plugins, jedes mit eigenem Symbol (Manifest + Registry) und eigener
 *   Farbe (index.css, Formel aus docs/UI_SPEC.md).
 * - Kopf-Status kommt aus dem zentralen Lock: frei / meins / gesperrt.
 * - Die Version in der Oberfläche ist die aus package.json.
 * - Engine-Status bildet AudioContext.state ab.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { headerIconStatus } from '../src/components/HeaderPluginIcon';
import { engineStatusOf } from '../src/components/EngineStatusBadge';
import { APP_VERSION } from '../src/config/appVersion';
import { getPluginRegistry } from '../src/plugins/registry';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/plugin-manifest.json'), 'utf8')) as {
  ui_plugins: { id: string; icon: string }[];
};
const indexCss = readFileSync(resolve(root, 'src/index.css'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

const HEAD_ORDER = [
  'mixer', 'drop', 'song', 'effect', 'syntisampler', 'drumsampler', 'instru', 'biblio',
  'voice', 'sound', 'stem', 'spatial', 'eq', 'dsp', 'master', 'record',
];

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

describe('UI2-P1-003 – 16 Kopf-Icons, einzigartig in Symbol und Farbe', () => {
  it('Manifest: 16 Plugins, 16 verschiedene Symbole', () => {
    const icons = manifest.ui_plugins.map((p) => p.icon);
    expect(icons).toHaveLength(16);
    expect(new Set(icons).size).toBe(16);
  });

  it('Registry: 16 Plugins in Kopfreihenfolge, 16 verschiedene Icon-Komponenten', () => {
    const reg = getPluginRegistry();
    expect(reg.map((p) => p.id)).toEqual(HEAD_ORDER);
    expect(new Set(reg.map((p) => p.icon)).size).toBe(16);
  });

  it('Modulfarben folgen hsl(i*22.5+11, 72 %, 64 %) und sind alle verschieden', () => {
    const colors = HEAD_ORDER.map((id, i) => {
      const m = indexCss.match(new RegExp(`\\.monk-theme-${id}\\s*\\{[^}]*--monk-accent:\\s*(#[0-9a-f]{6})`));
      expect(m, id).not.toBeNull();
      const expected = hslToHex((i * 22.5 + 11) % 360, 0.72, 0.64);
      // ±1 je Kanal für Rundungsunterschiede
      const got = m![1];
      for (let c = 1; c < 7; c += 2) {
        expect(Math.abs(parseInt(got.slice(c, c + 2), 16) - parseInt(expected.slice(c, c + 2), 16)), id).toBeLessThanOrEqual(1);
      }
      return got;
    });
    expect(new Set(colors).size).toBe(16);
  });

  it('Status kommt aus dem zentralen Lock', () => {
    expect(headerIconStatus(undefined, 'u1')).toBe('free');
    expect(headerIconStatus({ active: false, lockedBy: 'u2' }, 'u1')).toBe('free');
    expect(headerIconStatus({ active: true, lockedBy: 'u1' }, 'u1')).toBe('mine');
    expect(headerIconStatus({ active: true, lockedBy: 'u2' }, 'u1')).toBe('locked');
  });
});

describe('UI2-P1-005 – eine Versionsquelle', () => {
  it('APP_VERSION ist die Version aus package.json', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('App.tsx wiederholt die Versionsnummer nicht', () => {
    const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8');
    expect(app).not.toContain(pkg.version);
  });
});

describe('UI2-P2-003 – Engine-Status', () => {
  it('bildet AudioContext.state ab', () => {
    expect(engineStatusOf('running')).toBe('running');
    expect(engineStatusOf('suspended')).toBe('suspended');
    expect(engineStatusOf('interrupted')).toBe('suspended');
    expect(engineStatusOf('closed')).toBe('closed');
    expect(engineStatusOf(undefined)).toBe('closed');
  });
});
