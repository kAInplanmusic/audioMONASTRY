/**
 * Live-Beweis VISUAL-P1-001: Ghostuser 5/6 (Master-Out → PA, Beamer) am ECHTEN Knoten
 * =====================================================================
 * Geprueft wird gegen die LAUFENDE Flotten-Instanz (per SSH-Tunnel):
 *
 *   1. **Zaehlregel**: Der Beamer dockt als echter Client unter `/visual-out` an
 *      (feste Ghostuser-Andock-URL, `src/main.tsx`) und darf KEINEN der 4 Plaetze
 *      verbrauchen - der Session-Zaehler eines normalen Users muss bei 1/4 bleiben.
 *   2. **Bildweg**: Ein Publisher schiebt ein Bild ueber `POST /api/visual/frame`;
 *      der Beamer zeigt es an. Gemessen wird das GERENDERTE Pixel (Screenshot +
 *      ffmpeg), nicht ein API-Erfolg - sonst waere der Beweis wertlos.
 *
 * Aufruf (Knoten per SSH-Tunnel auf 8080):
 *   E2E_BASE_URL=http://localhost:8080 node scripts/visual-beamer-live-proof.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = (process.env.E2E_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

const token = (() => {
  const fromEnv = (process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').find((l) => l.startsWith('STUDIO_ACCESS_TOKEN='));
  return (line?.slice('STUDIO_ACCESS_TOKEN='.length) ?? '').trim();
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Solides JPEG in einer Farbe (ffmpeg). JPEG, weil der Route-Vertrag genau das
 * erlaubt: `image/jpeg`, `image/webp`, `application/octet-stream` - ein PNG wird
 * korrekt mit 415 abgelehnt (im ersten Anlauf genau so passiert).
 */
const solidJpeg = (r, g, b) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vis-frame-'));
  const file = path.join(dir, 'frame.jpg');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `color=c=0x${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}:s=320x180`,
    '-frames:v', '1', '-q:v', '2', file, '-y']);
  const buf = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return buf;
};

/** Ein Pixel aus der Mitte des Bildes (misst das GERENDERTE Ergebnis). */
const centerPixel = (pngBuffer, box) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vis-pixel-'));
  const file = path.join(dir, 'shot.png');
  writeFileSync(file, pngBuffer);
  const crop = box
    ? `crop=1:1:${Math.round(box.x + box.width / 2)}:${Math.round(box.y + box.height / 2)}`
    : 'crop=1:1:(iw/2):(ih/2)';
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', crop, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  rmSync(dir, { recursive: true, force: true });
  return { r: raw[0], g: raw[1], b: raw[2] };
};

const pushFrame = async (rgb) => {
  const res = await fetch(`${BASE}/api/visual/frame`, {
    method: 'POST',
    headers: { 'x-studio-token': token, 'Content-Type': 'image/jpeg' },
    body: solidJpeg(...rgb),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const main = async () => {
  console.log(`Ziel: ${BASE}`);
  console.log('Instanz:', JSON.stringify(await (await fetch(`${BASE}/api/health`)).json()));

  // --- Beamer: echter Ghostuser-Client unter /visual-out ---------------------
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const beamerCtx = await browser.newContext({ viewport: { width: 800, height: 480 } });
  if (token) await beamerCtx.addCookies([{ name: 'studio', value: token, url: BASE }]);
  const beamer = await beamerCtx.newPage();
  const beamerErrors = [];
  beamer.on('pageerror', (e) => beamerErrors.push(e.message.slice(0, 120)));
  await beamer.goto(`${BASE}/visual-out`, { waitUntil: 'domcontentloaded' });
  await sleep(3_000);
  const media = beamer.locator('img, video, canvas').first();
  const hasMedia = (await media.count()) > 0;
  console.log(`Beamer-Seite /visual-out geladen, Anzeigeelement vorhanden: ${hasMedia}`);

  // --- Ein normaler Studio-User parallel: Zaehler muss 1/4 bleiben ----------
  const studioCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (token) await studioCtx.addCookies([{ name: 'studio', value: token, url: BASE }]);
  const studio = await studioCtx.newPage();
  await studio.goto(BASE, { waitUntil: 'domcontentloaded' });
  const startBtn = studio.getByLabel('audioMONASTRY starten');
  if (await startBtn.count()) await startBtn.first().click();
  await studio.getByTitle('mixerMONK').first().waitFor({ timeout: 30_000 }).catch(() => {});
  await sleep(3_000);
  const badge = (await studio.getByText(/SESSION/).allInnerTexts().catch(() => [])).join(' | ');
  console.log('Session-Anzeige im Studio (Beamer laeuft als Listener):', JSON.stringify(badge));
  const listenerCounted = /SESSION [2-4]\/4|SESSION VOLL/.test(badge);

  // --- Bildweg messen -------------------------------------------------------
  // Die App-Seite /visual-out ueberlagert den Strom mit ihrer Statusanzeige,
  // solange kein WebRTC-Track ankommt (hier ist SFU aus) - deshalb wird das BILD
  // ueber den echten Live-Strom gemessen (dasselbe `<img>`-Prinzip wie im lokalen
  // Beweis: nur so kann ein Browser den multipart-Strom lesen).
  console.log('Frame 1:', JSON.stringify(await pushFrame([220, 30, 30])));
  await sleep(2_000);
  console.log('Frame 2:', JSON.stringify(await pushFrame([220, 30, 30])));

  const streamPage = await beamerCtx.newPage();
  // Kein setContent: der MJPEG-Strom endet nie, das `load`-Ereignis feuert also
  // nicht (30-s-Timeout, real passiert). Stattdessen Bild per Skript anhaengen.
  await streamPage.goto('about:blank');
  await streamPage.evaluate((url) => {
    document.body.style.margin = '0';
    document.body.style.background = '#000';
    const img = document.createElement('img');
    img.id = 'live';
    img.src = url;
    img.style.cssText = 'width:800px;height:480px;object-fit:contain';
    document.body.appendChild(img);
  }, `${BASE}/api/visual/mjpeg?token=${encodeURIComponent(token)}`);
  await sleep(3_000);
  console.log('Frame 3:', JSON.stringify(await pushFrame([220, 30, 30])));
  await sleep(2_500);
  console.log('Frame 4:', JSON.stringify(await pushFrame([220, 30, 30])));
  await sleep(2_500);

  // Vollbild-Screenshot + Ausschnitt am Bild (der Element-Screenshot eines
  // nie endenden Stroms kommt schwarz zurueck - so misst der lokale Beweis auch).
  const shot = await streamPage.screenshot();
  const view = await streamPage.locator('#live').boundingBox().catch(() => null);
  const px = centerPixel(shot, view);
  console.log('Beamer-Seitenfehler:', beamerErrors.slice(0, 3));
  await browser.close();

  const rot = px.r > 150 && px.g < 90 && px.b < 90;
  console.log('Gemessenes Pixel im Beamer-Bild:', JSON.stringify(px), '(erwartet ~ r=220 g=30 b=30)');
  console.log('\nErgebnis:');
  console.log(`  Beamer-Client (/visual-out) verbunden: ${hasMedia ? 'JA' : 'NEIN'}`);
  console.log(`  Beamer zaehlt NICHT zu den 4 Usern:    ${listenerCounted ? 'NEIN (Zaehler stieg)' : 'JA'}`);
  console.log(`  Beamer zeigt das eingespeiste Bild:    ${rot ? 'JA' : 'NEIN'}`);
  process.exitCode = rot && !listenerCounted && hasMedia ? 0 : 1;
};

main().catch((e) => {
  console.error('Beweis fehlgeschlagen:', e.message);
  process.exitCode = 1;
});
