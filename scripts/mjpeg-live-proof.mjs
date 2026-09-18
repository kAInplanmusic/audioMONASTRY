/**
 * Live-Beweis: MJPEG-Fallback auf einem echten Beamer-Bild (VISUAL-P1-001)
 * =====================================================================
 * Der Fallback ist nur so viel wert wie das Bild, das am Beamer ankommt.
 * Gemessen wird deshalb NICHT `img.naturalWidth` (bleibt bei
 * `multipart/x-mixed-replace` in Chromium 0, weil der Strom nie endet - ein
 * Beweis darauf waere wertlos), sondern **das gerenderte Bild**: Screenshot der
 * Seite, Pixelauslesung mit ffmpeg.
 *
 * Ablauf:
 *   1. Echte JPEG-Frames per ffmpeg (rot, gruen, blau).
 *   2. Sie werden per `POST /api/visual/frame` eingespeist - wie es das Studio
 *      aus dem Canvas tut.
 *   3. Eine Browser-Seite liest den Strom mit `<img src=".../api/visual/mjpeg?token=...">`
 *      (nur so - ein `<img>` kann keine Header setzen).
 *   4. Nach jedem Frame wird geprueft, dass der Beamer-Pixel die jeweilige Farbe
 *      zeigt: das beweist Empfang UND dass das Bild wechselt (kein Standbild).
 *   5. Zusatzpruefung: der Beamer taucht im Status als Zuschauer auf - davon
 *      haengt ab, ob das Studio ueberhaupt Frames enkodiert.
 *
 * Aufruf: npm run proof:mjpeg   (startet den Server selbst; Port muss frei sein)
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = Number(process.env.PROOF_PORT || 8096);
const TOKEN = process.env.PROOF_TOKEN || 'mjpeg-proof-token';
const APP_URL = `http://127.0.0.1:${PORT}`;
const workdir = mkdtempSync(path.join(tmpdir(), 'am-mjpeg-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const makeJpeg = (color, file) => {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', file,
  ]);
  return readFileSync(file);
};

/** Ist der Port frei? Sonst wuerde der Beweis einen FREMDEN (alten) Server messen. */
const portIsFree = (port) => new Promise((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, '127.0.0.1');
});

const waitForHealth = async (timeoutMs = 60_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${APP_URL}/api/health`);
      if (res.ok) return true;
    } catch { /* noch nicht bereit */ }
    await sleep(500);
  }
  return false;
};

let server = null;

const main = async () => {
  const frames = {
    rot: makeJpeg('red', path.join(workdir, 'rot.jpg')),
    gruen: makeJpeg('green', path.join(workdir, 'gruen.jpg')),
    blau: makeJpeg('blue', path.join(workdir, 'blau.jpg')),
  };

  // Genau dieser Fall ist passiert: ein verwaister Server aus einem abgebrochenen
  // Lauf hielt den Port, der Beweis lief gegen ALTE Software und lieferte ein
  // falsches Ergebnis. Ein Beweis, der den falschen Prozess messen kann, ist
  // wertlos - deshalb hier hart abbrechen.
  if (!(await portIsFree(PORT))) {
    console.error(`ABBRUCH: Port ${PORT} ist belegt - dort laeuft ein fremder Server. PROOF_PORT setzen.`);
    process.exit(3);
  }

  server = spawn('npx', ['tsx', 'server.ts'], {
    env: { ...process.env, PORT: String(PORT), STUDIO_ACCESS_TOKEN: TOKEN, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  server.stdout.on('data', (d) => log.push(String(d)));
  server.stderr.on('data', (d) => log.push(String(d)));

  if (!(await waitForHealth())) {
    console.error('Server nicht gestartet:', log.join('').slice(-800));
    process.exit(2);
  }

  const post = async (buffer, name) => {
    const res = await fetch(`${APP_URL}/api/visual/frame`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN, 'Content-Type': 'image/jpeg' },
      body: buffer,
    });
    return { name, status: res.status, body: await res.json().catch(() => null) };
  };
  const status = async () => (await fetch(`${APP_URL}/api/visual/status`, {
    headers: { 'x-studio-token': TOKEN },
  })).json();

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
  // Bewusst OHNE Studio-SPA: geprueft wird genau der Beamer-Fall - ein <img> auf
  // den Strom, sonst nichts.
  await page.setContent(
    '<!doctype html><html><body style="margin:0;background:#000">'
    + '<img id="beamer" style="width:400px;height:240px;object-fit:contain" />'
    + '</body></html>',
    { waitUntil: 'domcontentloaded' },
  );
  await page.evaluate((url) => { document.getElementById('beamer').src = url; },
    `${APP_URL}/api/visual/mjpeg?token=${encodeURIComponent(TOKEN)}`);

  const beforeViewer = await status();
  console.log('Status vor dem Beamer:', JSON.stringify(beforeViewer));

  /** Was der Beamer SIEHT: Screenshot + Pixelauslesung (ffmpeg, Mitte des Bildes). */
  const centerPixel = async () => {
    const shot = await page.screenshot({ type: 'png' });
    const raw = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vf', 'crop=1:1:200:120', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { input: shot, maxBuffer: 1024 * 1024 });
    return { r: raw[0], g: raw[1], b: raw[2] };
  };

  /**
   * Einen Frame senden und pruefen, dass der Beamer ihn zeigt.
   *
   * WICHTIG (im Beweis gemessen): Chromium uebernimmt bei
   * `multipart/x-mixed-replace` den n-ten Teil erst, wenn der (n+1)-te ankommt -
   * ohne das Nachsendend zeigt der Beamer immer den VORIGEN Frame. Deshalb wird
   * jeder Frame zweimal gesendet (das zweite Send flusht den ersten); genau so
   * verhaelt sich auch der Studio-Publisher, der laufend frames schickt.
   */
  const showFrame = async (buffer, name, isDone) => {
    const result = await post(buffer, name);
    console.log(`Frame ${name.padEnd(6)} ->`, JSON.stringify(result));
    await sleep(250);
    await post(buffer, name);
    let pixel = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < 25; i += 1) {
      await sleep(300);
      pixel = await centerPixel();
      if (isDone(pixel)) break;
    }
    console.log(`  Beamer-Pixel: ${JSON.stringify(pixel)}`);
    return pixel;
  };

  const pixelRot = await showFrame(frames.rot, 'rot', (p) => p.r > 120);
  await sleep(200);
  const pixelGruen = await showFrame(frames.gruen, 'gruen', (p) => p.g > 120);
  await sleep(200);
  const pixelBlau = await showFrame(frames.blau, 'blau', (p) => p.b > 120);

  const afterViewer = await status();
  console.log('Status nach den Frames:', JSON.stringify(afterViewer));
  await browser.close();

  const rotOk = pixelRot.r > 120 && pixelRot.g < 110 && pixelRot.b < 110;
  const gruenOk = pixelGruen.g > 120 && pixelGruen.r < 110;
  const blauOk = pixelBlau.b > 120 && pixelBlau.r < 110 && pixelBlau.g < 160;
  const viewerOk = Number(afterViewer.viewers) >= 1;

  console.log('\nErgebnis:');
  console.log(`  Beamer zeigt Frame 1 (rot):             ${rotOk ? 'JA' : 'NEIN'} ${JSON.stringify(pixelRot)}`);
  console.log(`  Beamer zeigt Frame 2 (gruen, wechselt): ${gruenOk ? 'JA' : 'NEIN'} ${JSON.stringify(pixelGruen)}`);
  console.log(`  Beamer zeigt Frame 3 (blau, wechselt):  ${blauOk ? 'JA' : 'NEIN'} ${JSON.stringify(pixelBlau)}`);
  console.log(`  Beamer ist als Zuschauer registriert:   ${viewerOk ? 'JA' : 'NEIN'} (${afterViewer.viewers})`);
  process.exitCode = rotOk && gruenOk && blauOk ? 0 : 1;
};

main()
  .catch((e) => {
    console.error('Probe fehlgeschlagen:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.kill('SIGTERM');
    rmSync(workdir, { recursive: true, force: true });
    // Dem Serverkind Zeit zum Beenden geben, dann hart aussteigen.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
