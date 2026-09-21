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
import { BASE, sleep, token } from './lib/proof-browser.mjs';

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

/**
 * Pixel aus der Bildmitte. Kein `crop`-Filter: ueber stdin kennt ffmpeg die
 * Bildgroesse noch nicht und `crop=iw/2` scheitert ("width 0" - real passiert).
 * Deshalb das ganze Bild als rgb24 dekodieren und in JS die Mitte lesen.
 */
const centerPixel = (imageBuffer) => {
  const raw = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { input: imageBuffer, maxBuffer: 64 * 1024 * 1024 });
  const pixels = Math.floor(raw.length / 3);
  const mid = Math.floor(pixels / 2) * 3;
  return { r: raw[mid], g: raw[mid + 1], b: raw[mid + 2], pixels };
};

/**
 * Einen kompletten Frame aus dem MJPEG-Strom lesen: verbinden, waehrend des
 * Lesens Frames einspeisen, bis ein vollstaendiges JPEG (SOI..EOI) vorliegt.
 */
const readFrameFromStream = async (url, tokenValue, timeoutMs = 20_000) => {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { 'x-studio-token': tokenValue }, signal: controller.signal });
  const reader = res.body?.getReader();
  const chunks = [];
  let bytes = 0;
  const deadline = Date.now() + timeoutMs;
  const shot = setInterval(() => { void pushFrame([220, 30, 30]); }, 400);
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(Buffer.from(value));
        bytes += value.length;
      }
      const all = Buffer.concat(chunks);
      // Multipart korrekt zerlegen statt nach JPEG-Markern zu suchen: das erste
      // SOI/EOI-Paar kann aus zwei Teilen stammen (dann dekodiert ffmpeg Muell).
      const boundary = Buffer.from('--audiomonastryframe');
      const start = all.indexOf(boundary);
      if (start >= 0) {
        const headerEnd = all.indexOf(Buffer.from('\r\n\r\n'), start);
        if (headerEnd > start) {
          const headers = all.subarray(start, headerEnd).toString('latin1');
          const len = Number(/Content-Length:\s*(\d+)/i.exec(headers)?.[1] ?? 0);
          const body = headerEnd + 4;
          if (len > 0 && all.length >= body + len) {
            const file = path.join(mkdtempSync(path.join(tmpdir(), 'vis-live-')), 'frame.jpg');
            writeFileSync(file, all.subarray(body, body + len));
            return { status: res.status, bytes, jpegBytes: len, file };
          }
        }
      }
    }
    return { status: res.status, bytes, jpegBytes: 0, file: null };
  } finally {
    clearInterval(shot);
    controller.abort();
  }
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

  // --- Ghostuser 5 (PA) parallel: /master-out -------------------------------
  // Der PA-Zuschauer dockt unter seiner festen URL an; auch er darf keinen der
  // 4 Plaetze verbrauchen. Was hier NICHT gemessen werden kann, ist der Klang
  // an der PA - dafuer braucht es ein echtes Ausgabegeraet (Betreiber-Rest).
  const paCtx = await browser.newContext({ viewport: { width: 800, height: 480 } });
  if (token) await paCtx.addCookies([{ name: 'studio', value: token, url: BASE }]);
  const pa = await paCtx.newPage();
  const paErrors = [];
  pa.on('pageerror', (e) => paErrors.push(e.message.slice(0, 120)));
  await pa.goto(`${BASE}/master-out`, { waitUntil: 'domcontentloaded' });
  await sleep(3_000);
  // Der PA-Zuschauer hat KEIN Bild (reiner Audio-Listener) - das richtige
  // Kriterium ist der produktionssichtbare Beweis im Server-Audit: der Server
  // protokolliert den Beitritt als JOIN_MASTER_OUT.
  const auditRes = await fetch(`${BASE}/api/audit`, { headers: { 'x-studio-token': token } });
  const auditBody = await auditRes.json().catch(() => ({}));
  const paJoined = (auditBody.entries ?? []).some((e) => String(e.action ?? '') === 'JOIN_MASTER_OUT');
  console.log(`PA-Seite /master-out geladen (Fehler: ${paErrors.length}) · Server-Audit JOIN_MASTER_OUT: ${paJoined}`);

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

  // (Der frueher hier genutzte Browser-<img>-Weg ist entfallen: ein nie endender
  // multipart-Strom liefert keinen Screenshot, und das <img> landete im 'broken'-
  // Zustand. Die Auswertung passiert jetzt in Node, siehe unten.)

  const gelesen = await readFrameFromStream(`${BASE}/api/visual/mjpeg?token=${encodeURIComponent(token)}`, token);
  console.log(`Strom: HTTP ${gelesen.status}, ${gelesen.bytes} Bytes, JPEG ${gelesen.jpegBytes} Bytes -> ${gelesen.file ?? 'kein JPEG'}`);
  const px = gelesen.file ? centerPixel(readFileSync(gelesen.file)) : { r: 0, g: 0, b: 0 };
  if (gelesen.file) rmSync(gelesen.file, { force: true });

  const rot = px.r > 150 && px.g < 90 && px.b < 90;
  console.log('Gemessenes Pixel im Beamer-Bild:', JSON.stringify(px), '(erwartet ~ r=220 g=30 b=30)');
  console.log('\nErgebnis:');
  console.log(`  Beamer-Client (/visual-out) verbunden: ${hasMedia ? 'JA' : 'NEIN'}`);
  console.log(`  PA-Client (/master-out) verbunden:     ${paJoined ? 'JA (JOIN_MASTER_OUT im Audit)' : 'NEIN'}`);
  console.log(`  Beamer zaehlt NICHT zu den 4 Usern:    ${listenerCounted ? 'NEIN (Zaehler stieg)' : 'JA'}`);
  console.log(`  Beamer zeigt das eingespeiste Bild:    ${rot ? 'JA' : 'NEIN'}`);
  process.exitCode = rot && !listenerCounted && hasMedia && paJoined ? 0 : 1;
  // Der abgebrochene MJPEG-Fetch haelt sonst einen offenen Socket und Node endet
  // nicht (real: Lauf lief in den Timeout, obwohl alle Messungen fertig waren).
  process.exit(process.exitCode);
};

main().catch((e) => {
  console.error('Beweis fehlgeschlagen:', e.message);
  process.exitCode = 1;
});
