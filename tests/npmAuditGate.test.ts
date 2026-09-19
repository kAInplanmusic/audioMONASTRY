import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectAdvisories, dependenciesFromLock, packageNameFromPath } from '../scripts/npm-audit.mjs';

/**
 * Gate-Defekt 2026-09-19: `npm audit` (npm 10.x) postet an den abgekuendigten
 * `quick`-Endpunkt und bekommt 400 - `npm run security` (und damit `npm run
 * verify`) schlug damit DAUERHAFT fuer jeden fehl. Das Audit laeuft jetzt in
 * scripts/npm-audit.mjs. Diese Tests halten fest, dass das Gate (a) Abhaengigkeiten
 * richtig liest und (b) einen Befund auch wirklich MELDET - ein Gate, das nie
 * fehlschlagen kann, ist keine Pruefung.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Sicherheits-Gate (scripts/npm-audit.mjs)', () => {
  it('liest Abhaengigkeiten aus package-lock v3 (inkl. verschachtelter und Scoped-Namen)', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/express': { version: '4.18.2' },
        'node_modules/@scope/pkg': { version: '2.0.0' },
        'node_modules/a/node_modules/nested': { version: '3.1.0' },
        'node_modules/a/node_modules/@other/x': { version: '9.9.9' },
        'node_modules/ohne-version': {},
      },
    });
    expect(dependenciesFromLock(lock)).toEqual({
      express: '4.18.2',
      '@scope/pkg': '2.0.0',
      nested: '3.1.0',
      '@other/x': '9.9.9',
    });
  });

  it('leitet Paketnamen aus Lock-Pfaden ab', () => {
    expect(packageNameFromPath('node_modules/express')).toBe('express');
    expect(packageNameFromPath('node_modules/a/node_modules/@s/b')).toBe('@s/b');
    expect(packageNameFromPath('irgendwas')).toBe('');
  });

  it('MELDET Befunde vom bulk-Endpunkt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            lodash: [
              { severity: 'high', title: 'Command Injection', vulnerable_versions: '<4.17.21', url: 'https://x' },
            ],
          }),
      })),
    );

    const result = await collectAdvisories({ lodash: '4.17.20' });
    expect(result.source).toBe('bulk');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ module: 'lodash', severity: 'high' });
  });

  it('weicht bei bulk-503 auf den full-Endpunkt aus und sagt das auch', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) return { status: 503, text: async () => JSON.stringify({ error: 'service unavailable' }) };
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              advisories: {
                '42': { module_name: 'foo', severity: 'moderate', title: 'Problem', vulnerable_versions: '<2.0.0' },
              },
            }),
        };
      }),
    );

    const result = await collectAdvisories({ foo: '1.0.0' });
    expect(result.source).toBe('full');
    expect(result.bulkStatus).toBe(503);
    expect(result.findings[0]).toMatchObject({ module: 'foo', severity: 'moderate' });
  });

  it('behauptet KEIN "gruen", wenn kein Endpunkt erreichbar ist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 500, text: async () => 'kaputt' })),
    );

    const result = await collectAdvisories({ foo: '1.0.0' });
    expect(result.source).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.error).toContain('500');
  });
});
