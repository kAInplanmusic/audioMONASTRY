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
 *   3. Phase A (Strom-Vertrag): eine nackte Seite liest den Strom mit
 *      `<img src=".../visual-stream/mjpeg?ticket=...">` (nur so - ein `<img>`
 *      kann keine Header setzen). Das Ticket ist kurzlebig und einmal
 *      verwendbar und wird auf der authentifizierten Route
 *      `/api/visual/mjpeg-ticket` geholt (AUDIT-2026-10-30-P1-006: dort steht
 *      nie der Studio-Master-Token).
 *   4. Phase B (UI-2026-11-06-002, der eigentliche Ticket-Beweis): die ECHTE
 *      Seite `/visual-out` wird geladen. Nach dem 6-s-WebRTC-Fallback holt sie
 *      ihr Ticket selbst und haengt ein `<img>` an den Strom. Ueber 10 s werden
 *      laufend Frames eingespeist; gemessen wird per CDP (`Network.dataReceived`)
 *      und per Screenshot-Pixel, dass WEITERE Frames ankommen und das Bild
 *      wechselt - nicht nur der erste.
 *   5. Gegenbeweis (`PROOF_LEGACY_UNMOUNT=1`): genau der alte Fehler wird im
 *      Browser nachgestellt (das `<img>` wird beim ersten `load` entfernt).
 *      Dann muss der Datenstrom versiegen - sonst misst dieser Beweis den
 *      Fehler nicht und waere wertlos.
 *
 * Aufruf: npm run proof:mjpeg   (startet den Server selbst; Port muss frei sein)
 *         PROOF_LEGACY_UNMOUNT=1 npm run proof:mjpeg   (Gegenbeweis)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { portIsFree, sleep, startDevServer, waitForHealth } from './lib/proof-server.mjs';

const PORT = Number(process.env.PROOF_PORT || 8096);
const TOKEN = process.env.PROOF_TOKEN || 'mjpeg-proof-token';
const APP_URL = `http://127.0.0.1:${PORT}`;
const workdir = mkdtempSync(path.join(tmpdir(), 'am-mjpeg-'));

/** Gegenbeweis: den alten Fehler (Element-Abbau bei onLoad) im Browser nachstellen. */
const LEGACY_UNMOUNT = process.env.PROOF_LEGACY_UNMOUNT === '1';
/** Messfenster der Phase B. */
const MEASURE_MS = Number(process.env.PROOF_MEASURE_MS || 10_000);

const makeJpeg = (color, file) => {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', file,
  ]);
  return readFileSync(file);
};

let server = null;

const main = async () => {
  const frames = {
    rot: makeJpeg('red', path.join(workdir, 'rot.jpg')),
    gruen: makeJpeg('green', path.join(workdir, 'gruen.jpg')),
    blau: makeJpeg('blue', path.join(workdir, 'blau.jpg')),
  };
  const frameCycle = [frames.rot, frames.gruen, frames.blau];

  // Genau dieser Fall ist passiert: ein verwaister Server aus einem abgebrochenen
  // Lauf hielt den Port, der Beweis lief gegen ALTE Software und lieferte ein
  // falsches Ergebnis. Ein Beweis, der den falschen Prozess messen kann, ist
  // wertlos - deshalb hier hart abbrechen.
  if (!(await portIsFree(PORT))) {
    console.error(`ABBRUCH: Port ${PORT} ist belegt - dort laeuft ein fremder Server. PROOF_PORT setzen.`);
    process.exit(3);
  }

  // Start (detached, killt die Prozessgruppe) und Health-Warten liegen in
  // scripts/lib/proof-server.mjs - dieselben Bausteine wie im WebGPU-Beweis.
  const started = startDevServer({
    port: PORT,
    extraEnv: {
      STUDIO_ACCESS_TOKEN: TOKEN,
      // Der Beweis speist ueber 10 s ~65 Frames ein; das Standardbudget
      // (60/min) bremste ihn mit 429 und liess den STROM versiegen - ein
      // Messartefakt, das wie der Fehler aussieht. Deshalb eigenes Budget.
      API_RATE_LIMIT_MAX: '10000',
      API_EXPENSIVE_RATE_LIMIT_MAX: '10000',
    },
  });
  server = started.server;
  const log = started.log;
  globalThis.__proofLog = log;
  server.on('exit', (code, signal) => {
    console.log(`[proof] Server-Prozess beendet: code=${code} signal=${signal}`);
  });

  if (!(await waitForHealth(APP_URL, 60_000))) {
    console.error('Server nicht gestartet:', log.join('').slice(-800));
    process.exit(2);
  }

  const post = async (buffer) => {
    const res = await fetch(`${APP_URL}/api/visual/frame`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN, 'Content-Type': 'image/jpeg' },
      body: buffer,
    });
    return res.status;
  };
  const status = async () => (await fetch(`${APP_URL}/api/visual/status`, {
    headers: { 'x-studio-token': TOKEN },
  })).json();
  /** AUDIT-2026-10-30-P1-006: Der <img>-Strom traegt ein Einmal-Ticket, nie den Token. */
  const beamerTicket = async () => {
    const res = await fetch(`${APP_URL}/api/visual/mjpeg-ticket`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN },
    });
    if (!res.ok) throw new Error(`Ticket-Ausstellung: HTTP ${res.status}`);
    const body = await res.json();
    if (!body?.ticket) throw new Error('Ticket-Ausstellung: leere Antwort');
    return body.ticket;
  };

  /** Was der Beamer SIEHT: Screenshot + Pixelauslesung (ffmpeg, Mitte des Bildes). */
  const centerPixel = async (page, width, height) => {
    const shot = await page.screenshot({ type: 'png' });
    const raw = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vf', `crop=1:1:${Math.floor(width / 2)}:${Math.floor(height / 2)}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { input: shot, maxBuffer: 1024 * 1024 });
    return { r: raw[0], g: raw[1], b: raw[2] };
  };
  const colorName = (p) => {
    if (p.r > 120 && p.g < 110 && p.b < 110) return 'rot';
    if (p.g > 120 && p.r < 110) return 'gruen';
    if (p.b > 120 && p.r < 110) return 'blau';
    return 'schwarz/anders';
  };

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  let ok = true;

  // ---------------------------------------------------------------------------
  // Phase A: nacktes <img> gegen den Strom - Vertrag von Route und Multipart.
  // ---------------------------------------------------------------------------
  {
    const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
    await page.setContent(
      '<!doctype html><html><body style="margin:0;background:#000">'
      + '<img id="beamer" style="width:400px;height:240px;object-fit:contain" />'
      + '</body></html>',
      { waitUntil: 'domcontentloaded' },
    );
    await page.evaluate((url) => { document.getElementById('beamer').src = url; },
      `${APP_URL}/visual-stream/mjpeg?ticket=${encodeURIComponent(await beamerTicket())}`);

    const beforeViewer = await status();
    console.log('Phase A · Status vor dem Beamer:', JSON.stringify(beforeViewer));

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
      console.log(`Frame ${name.padEnd(6)} -> HTTP ${await post(buffer)}`);
      await sleep(250);
      await post(buffer);
      let pixel = { r: 0, g: 0, b: 0 };
      for (let i = 0; i < 25; i += 1) {
        await sleep(300);
        pixel = await centerPixel(page, 400, 240);
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
    console.log('Phase A · Status nach den Frames:', JSON.stringify(afterViewer));
    await page.close();

    const rotOk = pixelRot.r > 120 && pixelRot.g < 110 && pixelRot.b < 110;
    const gruenOk = pixelGruen.g > 120 && pixelGruen.r < 110;
    const blauOk = pixelBlau.b > 120 && pixelBlau.r < 110 && pixelBlau.g < 160;
    const viewerOk = Number(afterViewer.viewers) >= 1;

    console.log('\nPhase A · Ergebnis:');
    console.log(`  Beamer zeigt Frame 1 (rot):             ${rotOk ? 'JA' : 'NEIN'} ${JSON.stringify(pixelRot)}`);
    console.log(`  Beamer zeigt Frame 2 (gruen, wechselt): ${gruenOk ? 'JA' : 'NEIN'} ${JSON.stringify(pixelGruen)}`);
    console.log(`  Beamer zeigt Frame 3 (blau, wechselt):  ${blauOk ? 'JA' : 'NEIN'} ${JSON.stringify(pixelBlau)}`);
    console.log(`  Beamer ist als Zuschauer registriert:   ${viewerOk ? 'JA' : 'NEIN'} (${afterViewer.viewers})`);
    ok = ok && rotOk && gruenOk && blauOk && viewerOk;
  }

  // ---------------------------------------------------------------------------
  // Phase B: die ECHTE Seite /visual-out - genau der gemeldete Fehler.
  // ---------------------------------------------------------------------------
  const context = await browser.newContext({ viewport: { width: 800, height: 450 } });
  // Die Seite holt das Ticket mit dem Studio-Token aus dem Cookie.
  await context.addCookies([{ name: 'studio', value: TOKEN, url: APP_URL }]);
  const page = await context.newPage();

  if (LEGACY_UNMOUNT) {
    // Gegenbeweis: der alte Code baute das <img> beim ersten onLoad ab.
    await page.addInitScript(() => {
      document.addEventListener('load', (event) => {
        const target = event.target;
        if (target && target.tagName === 'IMG' && target.alt === 'Visual-Fallback (MJPEG)') {
          target.remove();
        }
      }, true);
    });
  }

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const streamRequests = new Set();
  const streamFinished = new Set();
  const net = { chunks: 0, bytes: 0, lastAt: 0, status: 0, contentType: '', finished: 0, failed: 0 };
  cdp.on('Network.responseReceived', (event) => {
    if (!String(event.response.url).includes('/visual-stream/mjpeg')) return;
    streamRequests.add(event.requestId);
    net.status = event.response.status;
    net.contentType = event.response.headers['content-type'] || event.response.headers['Content-Type'] || '';
  });
  cdp.on('Network.dataReceived', (event) => {
    if (!streamRequests.has(event.requestId)) return;
    net.chunks += 1;
    net.bytes += event.dataLength;
    net.lastAt = Date.now();
  });
  cdp.on('Network.loadingFinished', (event) => {
    if (!streamRequests.has(event.requestId)) return;
    streamFinished.add(event.requestId);
    net.finished += 1;
  });
  cdp.on('Network.loadingFailed', (event) => {
    if (!streamRequests.has(event.requestId)) return;
    streamFinished.add(event.requestId);
    net.failed += 1;
  });

  await page.goto(`${APP_URL}/visual-out`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('\nPhase B · /visual-out geladen - warte auf den MJPEG-Fallback (6 s) …');
  // Der Fallback-Timer der Seite laeuft nach 6 s; danach Ticket + erster Frame.
  await sleep(9_000);

  const imgSelector = 'img[alt="Visual-Fallback (MJPEG)"]';
  const imgInfoAtStart = await page.evaluate((selector) => {
    const img = document.querySelector(selector);
    return img ? { src: img.getAttribute('src'), connected: img.isConnected } : null;
  }, imgSelector);
  console.log(`Phase B · <img> nach dem Fallback: ${imgInfoAtStart ? `${imgInfoAtStart.src} (im DOM: ${imgInfoAtStart.connected})` : 'FEHLT'}`);

  const snapshots = [];
  const postCodes = new Map();
  const startedAt = Date.now();
  let posted = 0;
  let accepted = 0;
  let nextSample = 0;
  let colorIndex = 0;
  while (Date.now() - startedAt < MEASURE_MS) {
    // Alle 600 ms die Farbe wechseln (4 Frames bei 150 ms).
    if (posted % 4 === 0) colorIndex = (colorIndex + 1) % frameCycle.length;
    const statusCode = await post(frameCycle[colorIndex]);
    postCodes.set(statusCode, (postCodes.get(statusCode) ?? 0) + 1);
    posted += 1;
    if (statusCode === 200) accepted += 1;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= nextSample) {
      const pixel = await centerPixel(page, 800, 450);
      snapshots.push({ ms: elapsed, bytes: net.bytes, chunks: net.chunks, color: colorName(pixel), pixel });
      nextSample = elapsed + 1_000;
    }
    await sleep(150);
  }
  // Nachlauf: letzter Frame braucht einen Nachfolger, damit Chromium ihn zeigt.
  await post(frameCycle[colorIndex]);
  await sleep(500);

  const imgInfoAtEnd = await page.evaluate((selector) => {
    const img = document.querySelector(selector);
    return img ? { src: img.getAttribute('src'), connected: img.isConnected } : null;
  }, imgSelector);
  const endStatus = await status();
  const colorsSeen = [...new Set(snapshots.map((s) => s.color))].filter((c) => c !== 'schwarz/anders');
  const lastSnap = snapshots[snapshots.length - 1] ?? { ms: 0, bytes: 0, chunks: 0 };
  const bytesGrowth = lastSnap.bytes - (snapshots[0]?.bytes ?? 0);
  const chunksGrowth = lastSnap.chunks - (snapshots[0]?.chunks ?? 0);
  const silentMs = net.lastAt ? Date.now() - net.lastAt : Number.POSITIVE_INFINITY;
  // Chromium meldet fuer einen multipart-Strom `loadingFinished` schon waehrend
  // weiter Daten fliessen - "finished" taugt NICHT als Abbruch-Signal. Massgeblich
  // ist, ob im SPAETEN Fenster (letzte 40 %) noch Bytes dazukommen.
  const openStreams = [...streamRequests].filter((id) => !streamFinished.has(id)).length;
  const lateRef = [...snapshots].reverse().find((s) => s.ms <= MEASURE_MS * 0.6) ?? snapshots[0] ?? lastSnap;
  const lateBytes = lastSnap.bytes - lateRef.bytes;
  const lateChunks = lastSnap.chunks - lateRef.chunks;

  console.log(`\nPhase B · Messung ueber ${MEASURE_MS} ms:`);
  console.log(`  eingespeiste Frames (HTTP 200):        ${accepted}/${posted}`);
  console.log(`  HTTP-Codes der Einspeisung:            ${[...postCodes.entries()].map(([code, count]) => `${code}×${count}`).join(', ')}`);
  console.log(`  Stream-Antwort:                        HTTP ${net.status} · ${net.contentType}`);
  console.log(`  CDP Network.dataReceived:              ${net.chunks} Chunks · ${net.bytes} Bytes`);
  console.log(`  Zuwachs im Messfenster:                ${chunksGrowth} Chunks · ${bytesGrowth} Bytes`);
  console.log(`  Zuwachs im SPAETEN Fenster:            ${lateChunks} Chunks · ${lateBytes} Bytes (ab t=${lateRef.ms} ms)`);
  console.log(`  Stille seit dem letzten Datenpaket:    ${Number.isFinite(silentMs) ? `${silentMs} ms` : 'seit Beginn keine Daten'}`);
  console.log(`  Stream-Ende gemeldet:                  finished=${net.finished} failed=${net.failed} · offen=${openStreams} von ${streamRequests.size}`);
  console.log(`  <img> am Ende:                         ${imgInfoAtEnd ? `im DOM=${imgInfoAtEnd.connected}, src unveraendert=${imgInfoAtEnd.src === imgInfoAtStart?.src}` : 'FEHLT'}`);
  console.log(`  Zuschauer im Hub:                      ${JSON.stringify(endStatus)}`);
  console.log(`  Beamer-Farben im Messfenster:          ${colorsSeen.join(', ') || '(keine)'}`);
  for (const snap of snapshots) {
    console.log(`    t=${String(snap.ms).padStart(5)} ms · ${String(snap.bytes).padStart(7)} Bytes · ${String(snap.chunks).padStart(3)} Chunks · Pixel ${snap.color} ${JSON.stringify(snap.pixel)}`);
  }

  if (LEGACY_UNMOUNT) {
    // Der nachgestellte Fehler MUSS messbar sein: Element weg und Bild steht
    // still. Sonst ist dieser Beweis blind.
    //
    // BEFUND (gemessen): Chromium zieht die Bytes auch weiter, nachdem das
    // <img> aus dem DOM entfernt wurde - die Verbindung allein ist also KEIN
    // Beweis fuer ein Bild. Entscheidend ist der Pixel: ohne Element dekodiert
    // niemand mehr, der Beamer bleibt schwarz.
    const imgGone = imgInfoAtEnd === null;
    const pictureFrozen = colorsSeen.length <= 1;
    const streamStalled = lateChunks === 0 || silentMs > 2_500;
    console.log('\nGegenbeweis · alter Fehler (Abbau bei onLoad) nachgestellt:');
    console.log(`  <img> nach onLoad entfernt:            ${imgGone ? 'JA' : 'NEIN'}`);
    console.log(`  Strom versiegt (kein Zuwachs):         ${streamStalled ? 'JA' : 'NEIN'} (${lateChunks} Chunks spaet, ${silentMs} ms still)`);
    console.log(`  Bild steht still (nur eine Farbe):     ${pictureFrozen ? 'JA' : 'NEIN'} (${colorsSeen.join(', ') || 'keine'})`);
    ok = imgGone && pictureFrozen;
    console.log(`\n  => Messung erkennt den alten Fehler:   ${ok ? 'JA' : 'NEIN - Beweis waere blind'}`);
  } else {
    const imgKept = !!imgInfoAtEnd?.connected && imgInfoAtEnd.src === imgInfoAtStart?.src;
    const moreThanOneFrame = chunksGrowth > 0 && net.chunks > 3;
    const streamAlive = lateChunks > 0 && silentMs < 2_500;
    const pictureChanges = colorsSeen.length >= 2;
    console.log('\nPhase B · Ergebnis (UI-2026-11-06-002):');
    console.log(`  <img> bleibt nach onLoad im DOM:       ${imgKept ? 'JA' : 'NEIN'}`);
    console.log(`  weitere Frames nach dem ersten:        ${moreThanOneFrame ? 'JA' : 'NEIN'} (+${chunksGrowth} Chunks)`);
    console.log(`  Strom laeuft am Ende noch:             ${streamAlive ? 'JA' : 'NEIN'} (${lateChunks} Chunks spaet, ${silentMs} ms still)`);
    console.log(`  Bild wechselt (kein Standbild):        ${pictureChanges ? 'JA' : 'NEIN'} (${colorsSeen.join(', ') || 'keine'})`);
    ok = ok && imgKept && moreThanOneFrame && streamAlive && pictureChanges;
  }

  await context.close();
  await browser.close();

  if (!ok) {
    console.log('\nServer-Log (letzte Zeilen):');
    console.log(log.join('').split('\n').slice(-40).join('\n'));
  }
  console.log(`\nGesamt: ${ok ? 'BESTANDEN' : 'FEHLGESCHLAGEN'}`);
  process.exitCode = ok ? 0 : 1;
};

main()
  .catch((e) => {
    console.error('Probe fehlgeschlagen:', e);
    if (server) {
      try {
        console.error('\nServer-Log bis zum Abbruch:');
        console.error(String((globalThis.__proofLog ?? []).join('')).split('\n').slice(-40).join('\n'));
      } catch { /* egal */ }
    }
    process.exitCode = 1;
  })
  .finally(() => {
    if (server?.pid) {
      try {
        server.kill('SIGTERM');
        // Prozessgruppe mitnehmen (npx -> tsx -> node -> vite).
        process.kill(-server.pid, 'SIGTERM');
      } catch { /* schon weg */ }
    }
    rmSync(workdir, { recursive: true, force: true });
    // Dem Serverkind Zeit zum Beenden geben, dann hart aussteigen. Bleibt es
    // hartnaeckig, wird die Gruppe nachgeschickt - ein verwaister Dev-Server
    // blockiert sonst HMR-Port 24678 und sabotiert andere E2E-Laeufe.
    setTimeout(() => {
      if (server?.pid) {
        try { process.kill(-server.pid, 'SIGKILL'); } catch { /* weg */ }
      }
      process.exit(process.exitCode ?? 0);
    }, 1_500);
  });
