// P1-1: MNOA-MCP Smoke-Skript — Wächter für den reproduzierbaren Testpfad.
// Stellt sicher, dass das Smoke-Skript existiert und alle geforderten Schritte
// (Healthcheck, Tools listen, harmloses Tool, Fehlerfall, fail-closed) abdeckt.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const scriptPath = resolve(__dirname, '../scripts/mcp-smoke.mjs');

describe('MNOA-MCP Smoke-Skript', () => {
  it('existiert und ist ausführbar referenziert (npm run mcp:smoke)', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
    expect(pkg.scripts?.['mcp:smoke']).toContain('mcp-smoke.mjs');
  });

  it('deckt alle geforderten Smoke-Schritte ab', () => {
    const src = readFileSync(scriptPath, 'utf8');
    for (const needle of [
      '/api/health',                    // Schritt 2: Healthcheck
      '/api/ai/mcp/tools',              // Schritt 3: Tools auflisten
      'models.list',                    // Schritt 4: harmloses Tool
      'does.not.exist',                 // Schritt 5: Fehlerfall
      'stepInvalidPayload',             // Input-Validierung
      'fail-closed ohne Studio-Token',  // Auth-Fail-closed
    ]) {
      expect(src).toContain(needle);
    }
  });
});
