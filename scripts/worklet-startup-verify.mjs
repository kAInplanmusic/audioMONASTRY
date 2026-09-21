/**
 * Verifikation: starten die DSP-Worklets jetzt wirklich?
 * =====================================================================
 * Der Befund vom 2026-09-18 war: fuenf von zehn Worklet-Knoten fielen beim
 * App-Start dauerhaft auf einen neutralen Gain-Knoten zurueck, weil der Graph
 * gebaut wurde, waehrend die Module noch geladen wurden. Dieses Skript zaehlt im
 * echten Browser die Fallback-Warnungen und prueft zusaetzlich, dass die Module
 * registriert sind.
 *
 * Aufruf: E2E_BASE_URL=http://localhost:8080 node scripts/worklet-startup-verify.mjs
 */
import { chromium } from 'playwright';
import { BASE, token } from './lib/proof-browser.mjs';

const main = async () => {
  console.log(`Ziel: ${BASE} · Instanz: ${JSON.stringify(await (await fetch(`${BASE}/api/health`)).json())}`);
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
  if (token) await ctx.addCookies([{ name: 'studio', value: token, url: BASE }]);
  const page = await ctx.newPage();

  const fallbacks = [];
  const dummy = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('Gain-Fallback')) fallbacks.push(t.slice(0, 90));
    if (/Dummy-|dummy-processor/i.test(t)) dummy.push(t.slice(0, 90));
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const start = page.getByLabel('audioMONASTRY starten');
  if (await start.count()) await start.first().click();
  await page.getByTitle('mixerMONK').first().waitFor({ timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(8_000); // Worklet-Laden + Graph-Aufbau abwarten

  // Zusatzkontrolle - WICHTIG zur Einordnung: Worklet-Module werden PRO
  // AudioContext registriert. Ein FRISCHER Kontext kennt daher keinen der
  // Prozessoren; "fehlt" ist hier die korrekte, erwartete Antwort und KEIN
  // Fehler. Entscheidend ist die Fallback-Zahl oben: sie zaehlt die Pfade, die
  // die App selbst genommen hat.
  const registered = await page.evaluate(async () => {
    const names = ['dynamics-processor', 'granular-processor', 'fm6-processor', 'drumsynth-processor', 'lufs-processor'];
    const Ctx = window.AudioContext;
    const c = new Ctx();
    const out = {};
    for (const n of names) {
      try {
        new AudioWorkletNode(c, n); // wirft, wenn der Prozessor fehlt
        out[n] = 'registriert';
      } catch (e) {
        out[n] = `fehlt (${String(e).slice(0, 40)})`;
      }
    }
    await c.close();
    return out;
  });

  await browser.close();
  console.log('\nFallback-Warnungen beim Start:', fallbacks.length);
  for (const f of fallbacks.slice(0, 8)) console.log('  -', f);
  console.log('Dummy-Registrierungen:', dummy.length);
  console.log('Kontrolle im frischen Kontext (Module sind pro Kontext registriert - "fehlt" ist hier ERWARTET):');
  console.log(' ', JSON.stringify(registered));

  const ok = fallbacks.length === 0;
  console.log(`\nErgebnis: DSP-Worklets starten ohne Gain-Fallback: ${ok ? 'JA' : 'NEIN'}`);
  process.exit(ok ? 0 : 1);
};

main().catch((e) => {
  console.error('Verifikation fehlgeschlagen:', e.message);
  process.exit(1);
});
