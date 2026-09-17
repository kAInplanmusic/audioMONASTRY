import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, BrowserContextOptions } from '@playwright/test';

/**
 * Studio-Auth für E2E-Session-Tests.
 *
 * Der Signalisierungs-Server verlangt den Studio-Zugang: entweder das
 * `STUDIO_ACCESS_TOKEN` (Master) oder ein kurzlebiges, signiertes Session-Token -
 * im Betrieb setzt das Portal ein `studio`-Cookie. Ohne dieses Cookie weist der
 * Server jeden zweiten Browser-Kontext mit 401 „unauthorized" ab; genau daran
 * scheiterte `live2browser.spec.ts` (die Kontexte hatten kein Cookie), während
 * `collab.spec.ts` es richtig machte. Damit die Regel nicht in mehreren Specs
 * unterschiedlich gelebt wird, liegt sie hier zentral.
 *
 * Pfad-Hinweis: der Helfer liegt in tests/e2e/helpers/ - die .env also drei
 * Ebenen hoeher (../../../.env). Ein falscher Pfad faellt als 401 auf.
 *
 * Ohne konfigurierten Token (z. B. CI ohne `.env`) wird kein Cookie gesetzt -
 * der Server läuft dann im offenen Dev-Modus.
 */

/** Basis-URL der Suite (`E2E_BASE_URL` oder lokaler Dev-Server). */
export function studioBaseUrl(): string {
  return (process.env.E2E_BASE_URL ?? '').trim().replace(/\/$/, '') || 'http://localhost:8080';
}

/** Studio-Token: aus der Umgebung oder (lokal) aus der `.env`. */
export function studioToken(): string {
  const fromEnv = (process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const line = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('STUDIO_ACCESS_TOKEN='));
    return (line?.slice('STUDIO_ACCESS_TOKEN='.length) ?? '').trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

/**
 * Browser-Kontext mit `studio`-Cookie (vom Portal gesetzt): für `http://localhost`
 * ohne `secure`, für https mit `secure: true`. Zusätzliche Optionen (z. B.
 * `permissions: ['microphone']`) werden durchgereicht.
 */
export async function newStudioContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const ctx = await browser.newContext(options);
  const token = studioToken();
  if (token) {
    const url = new URL(studioBaseUrl());
    await ctx.addCookies([{
      name: 'studio',
      value: token,
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      httpOnly: false,
    }]);
  }
  return ctx;
}

/**
 * E2E-Isolation: setzt den serverautoritativen Session-State zurück. Die
 * In-Memory-Session lebt länger als ein einzelner Browser-Kontext; ohne Reset
 * würden Modul-States/Locks aus einem vorherigen Test in den nächsten bluten.
 * Der Hook ist dev-only (Production: 404) und verlangt den Studio-Token.
 */
export async function resetSession(): Promise<void> {
  const token = studioToken();
  const res = await fetch(`${studioBaseUrl()}/api/session/reset`, {
    method: 'POST',
    headers: token ? { 'x-studio-token': token } : {},
  });
  if (!res.ok) throw new Error(`session reset fehlgeschlagen: ${res.status} ${await res.text()}`);
}
