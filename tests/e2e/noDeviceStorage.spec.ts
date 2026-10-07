import { test, expect } from '@playwright/test';
import { entryButton, switchPluginOn } from './helpers/studioNav';
import { resetSession, studioBaseUrl, studioToken } from './helpers/studioAuth';

/**
 * Betreiber 2026-10-06: „NICHTS wird auf den Geräten der Nutzer gespeichert.
 * Keine Sounds, keine Audio, nichts."
 * Nach dem Benutzen des Studios ist der Browser-Speicher leer, es gibt keine
 * Browser-Datenbank und keine Dateien im Gerät – die Daten liegen auf dem Server.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'nur Chromium: indexedDB.databases + OPFS');

test.beforeEach(async () => {
  await resetSession();
});

test('nach dem Benutzen liegt nichts auf dem Gerät – die Daten liegen auf dem Server', async ({ page }) => {
  // Altbestand aus früheren Versionen simulieren: muss übernommen und gelöscht werden.
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('audiomonastry_library_favorites', JSON.stringify({ ids: ['alt-1'] })));
  await page.reload();

  await entryButton(page).click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

  // Etwas tun, das früher im Browser landete: Plugin-Stand + Stream-Einstellung.
  await switchPluginOn(page, 'eq', 'eqMONK');
  await page.getByLabel('Visual-Liveshow öffnen').click();
  await page.getByLabel('Stream-Auflösung').selectOption('720p');
  await page.keyboard.press('Escape');

  const device = await page.evaluate(async () => {
    const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    let files = 0;
    try {
      const root = await navigator.storage.getDirectory();
      // @ts-expect-error entries ist nicht in allen Typen enthalten
      for await (const _ of root.entries()) files += 1;
    } catch { /* kein OPFS */ }
    return { local: localStorage.length, session: sessionStorage.length, dbs: dbs.length, files };
  });
  expect(device).toEqual({ local: 0, session: 0, dbs: 0, files: 0 });

  // Auf dem Server: Stream-Einstellung und der übernommene Altbestand.
  await expect.poll(async () => {
    const res = await fetch(`${studioBaseUrl()}/api/store`, { headers: { 'x-studio-token': studioToken() } });
    const body = (await res.json()) as { entries?: Record<string, string> };
    return Object.keys(body.entries ?? {}).sort();
  }, { timeout: 10_000 }).toEqual(expect.arrayContaining(['am.visualStream.settings', 'audiomonastry_library_favorites']));
});
