/**
 * FIX F2 (a) · Rollen-Quellen der R2-Zugangsdaten: Portal ↔ Server
 * ===============================================================
 * Der Live-Befund: app-1 trug die R2-Werte unter `CFS3_ACCESS_KEY_ID`/
 * `CFS3_SECRET_ACCESS_KEY` (Namen, die der Server nicht las), während die vom
 * Portal-Worker geschriebene Rollen-.env nur die Legacy-Familie `CFR2_*` setzte.
 * Zwei Schreibweisen, keine Prüfung → der Server fiel still auf ein falsches Paar
 * zurück (`SignatureDoesNotMatch`).
 *
 * Diese Tests halten beide Seiten zusammen:
 *   1. Der Worker schreibt die KANONISCHEN Namen, die `server/r2Config.ts` liest
 *      (Paritätsprüfung der Namenslisten – driften sie, wird es hier rot).
 *   2. Er schreibt Legacy-Spiegel mit IDENTISCHEM Wert (eine Herkunft).
 *   3. Widersprüchliche Portal-Werte werden gemeldet, nicht priorisiert.
 *   4. Der Server-Resolver akzeptiert genau die Namen, die der Worker schreibt,
 *      und liefert dieselben Werte (Round-Trip über die echte Rollen-.env-Zeile).
 */
import { describe, expect, it } from 'vitest';
// Cloudflare-Worker ist plain JS (ESM) – Typen sind hier nicht nötig.
// Default = fetch-Handler, Namespace = die exportierten Helfer (r2EnvLines …).
import * as portalWorkerModule from '../services/portal-worker/src/index.js';
import { R2_CANONICAL_ENV_KEYS, R2_ENV_ALIASES, resolveR2Config } from '../server/r2Config';

const worker = portalWorkerModule as unknown as {
  R2_CANONICAL_ENV_KEYS: Record<string, string>;
  portalR2Config: (env: Record<string, unknown>) => {
    configured: boolean;
    source: string;
    deviation: { field: string; chosen: string; names: string[] }[];
  };
  r2EnvLines: (env: Record<string, unknown>) => string[];
  r2Summary: (env: Record<string, unknown>) => { ok: boolean; configured: boolean; deviationCount: number; message: string; source: string };
};

const ACCESS_KEY = 'a'.repeat(32);
const SECRET_KEY = 'b'.repeat(64);
const BUCKET = 'audiomonastrysamples';

/** Wandelt die geschriebenen Env-Zeilen in eine Map (wie der Knoten sie lädt). */
function linesToEnv(lines: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of lines) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

describe('F2/a · Portal-Worker schreibt R2 aus EINER Herkunft', () => {
  it('hält die kanonischen Namen mit server/r2Config.ts synchron', () => {
    expect(worker.R2_CANONICAL_ENV_KEYS).toEqual(R2_CANONICAL_ENV_KEYS);
    // Und jeder kanonische Name muss im Server-Resolver auch gelesen werden.
    for (const [field, name] of Object.entries(worker.R2_CANONICAL_ENV_KEYS)) {
      expect(R2_ENV_ALIASES[field as keyof typeof R2_ENV_ALIASES], `Feld ${field}`).toContain(name);
    }
  });

  it('schreibt kanonische Namen UND Legacy-Spiegel mit demselben Wert', () => {
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'acct123',
      CFS3_ACCESS_KEY: ACCESS_KEY,
      CFS3_SECRET_KEY: SECRET_KEY,
      CFS3_BUCKET: BUCKET,
    };
    const lines = worker.r2EnvLines(env);
    const written = linesToEnv(lines);

    expect(written.CFS3_ACCESS_KEY).toBe(ACCESS_KEY);
    expect(written.CFS3_SECRET_KEY).toBe(SECRET_KEY);
    expect(written.CFS3_BUCKET).toBe(BUCKET);
    // Legacy-Spiegel: Knoten-Skripte (Backup) lesen weiter `CFR2_*`.
    expect(written.CFR2_ACCESS_KEY_ID).toBe(written.CFS3_ACCESS_KEY);
    expect(written.CFR2_SECRET_ACCESS_KEY).toBe(written.CFS3_SECRET_KEY);
    expect(written.CFR2_BUCKET).toBe(written.CFS3_BUCKET);
    // Keine Zeile ohne Wert, kein Duplikat.
    expect(lines.every((line) => line.includes('=') && line.split('=')[1].length > 0)).toBe(true);
    expect(new Set(lines.map((l) => l.split('=')[0])).size).toBe(lines.length);
  });

  it('akzeptiert auch die Legacy-Eingabe des Portal-Secrets (CFR2_*)', () => {
    const lines = worker.r2EnvLines({
      CFR2_ACCOUNT_ID: 'acct123',
      CFR2_ACCESS_KEY_ID: ACCESS_KEY,
      CFR2_SECRET_ACCESS_KEY: SECRET_KEY,
      CFR2_BUCKET: BUCKET,
      CFR2_PUBLIC_URL: 'https://r2.example/samples',
    });
    const written = linesToEnv(lines);
    expect(written.CFS3_ACCESS_KEY).toBe(ACCESS_KEY);
    expect(written.CFS3_SECRET_KEY).toBe(SECRET_KEY);
    expect(written.CFS3_BUCKET).toBe(BUCKET);
    expect(written.CFR2_PUBLIC_URL).toBe('https://r2.example/samples');
    // Der Server-Resolver akzeptiert genau das Ergebnis (Round-Trip).
    const resolved = resolveR2Config({ ...written, CFS3_ENDPOINT: `https://${written.CFR2_ACCOUNT_ID}.r2.cloudflarestorage.com` });
    expect(resolved.configured).toBe(true);
    expect(resolved.accessKeyId).toBe(ACCESS_KEY);
    expect(resolved.secretAccessKey).toBe(SECRET_KEY);
    expect(resolved.bucket).toBe(BUCKET);
    expect(resolved.deviation).toEqual([]);
  });

  it('meldet widersprüchliche Portal-Quellen statt still zu priorisieren', () => {
    const lines = worker.r2EnvLines({
      CFS3_ACCESS_KEY: ACCESS_KEY,
      CFR2_ACCESS_KEY_ID: 'c'.repeat(32),
      CFS3_SECRET_KEY: SECRET_KEY,
      CFR2_SECRET_ACCESS_KEY: 'd'.repeat(64),
      CFR2_ACCOUNT_ID: 'acct123',
      CFS3_BUCKET: BUCKET,
    });
    // Geschrieben wird die kanonische Familie (kein Mischmasch im Knoten) …
    expect(linesToEnv(lines).CFS3_ACCESS_KEY).toBe(ACCESS_KEY);
    // … der Widerspruch ist aber sichtbar und wird für das Wake-Ergebnis gemeldet.
    const summary = worker.r2Summary({
      CFS3_ACCESS_KEY: ACCESS_KEY,
      CFR2_ACCESS_KEY_ID: 'c'.repeat(32),
      CFS3_SECRET_KEY: SECRET_KEY,
      CFR2_SECRET_ACCESS_KEY: 'd'.repeat(64),
      CFR2_ACCOUNT_ID: 'acct123',
      CFS3_BUCKET: BUCKET,
    });
    expect(summary.deviationCount).toBe(2);
    expect(summary.ok).toBe(false);
    expect(summary.message).toContain('SignatureDoesNotMatch');
    expect(JSON.stringify(summary)).not.toContain(ACCESS_KEY);
    const config = worker.portalR2Config({ CFS3_ACCESS_KEY: ACCESS_KEY, CFR2_ACCESS_KEY_ID: 'c'.repeat(32) });
    expect(config.deviation[0].field).toBe('accessKeyId');
    expect(config.deviation[0].names).toEqual(['CFS3_ACCESS_KEY', 'CFR2_ACCESS_KEY_ID']);
  });

  it('meldet fehlende R2-Werte als nicht konfiguriert (statt einen halben Satz zu schreiben)', () => {
    expect(worker.r2EnvLines({ CFS3_ACCESS_KEY: ACCESS_KEY })).toEqual([]);
    const summary = worker.r2Summary({});
    expect(summary.configured).toBe(false);
    expect(summary.ok).toBe(false);
    expect(summary.message).toContain('ohne Cloud-Speicher');
  });
});
