/**
 * Live-Beweis VISUAL-P1-001 (Teil 2): KOMMT TON am PA-Zuschauer an?
 * =====================================================================
 * Bisher war der PA-Teil "braucht ein Geraet". Der Klang am Lautsprecher ist
 * tatsaechlich ein Vor-Ort-Thema - der AUDIOWEG dorthin aber ist messbar: ein
 * DJ-Browser speist ueber ein Chromium-**Fake-Audiogeraet** ein, ein zweiter
 * Browser dockt als Ghostuser 5 unter `/master-out` an, und dort wird der
 * empfangene Strom mit einem AnalyserNode gemessen (RMS). Ein nicht-stiller
 * Pegel beweist: der Ton laeuft bis zum Zuschauer durch.
 *
 * Aufruf (lokaler Produktions-Build oder echte Instanz):
 *   E2E_BASE_URL=http://localhost:8080 node scripts/master-out-audio-proof.mjs
 *
 * BEFUND 2026-09-18 (ehrlich, nicht gruen geredet): in diesem Headless-Aufbau
 * kam KEIN Track am PA an. Die Ursache ist die VORBEDINGUNG der Kette, nicht der
 * Transport: der DJ sendet den Master-Stream nur als **Main-Out-Halter**
 * (`src/App.tsx`: `if (webRTCManager.isMainOutOwner) startHostMain()` ->
 * `createMasterStreamDestination()` -> `startMainStream()`). Die Rolle wird
 * serverseitig vergeben und haengt am mixerMONK-Lock; im Beweislauf liess sich
 * das Rack-Menue (`getByLabel('mixerMONK Menü')`, im dev-Modus der collab-Spec
 * erfolgreich) headless nicht erreichen - der Audit zeigt nur `JOIN_SESSION` und
 * `JOIN_MASTER_OUT`, aber keinen Halterwechsel. Wer den Halter-Schritt hinbekommt
 * (Geraet oder stabilerer Selektor), bekommt mit diesem Skript die RMS-Messung
 * am Zuschauer; alles andere im Skript ist fertig und gemessen (Fake-Gerade
 * wird erkannt: 3 audioinputs, AudioContext laeuft, Transport startet).
 */
import { readFileSync } from 'node:fs';
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

const main = async () => {
  console.log(`Ziel: ${BASE}`);
  console.log('Instanz:', JSON.stringify(await (await fetch(`${BASE}/api/health`)).json()));

  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      // Fake-Mikrofon liefert einen Testton -> ohne echtes Geraet messbar.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  // --- DJ: Studio mit Tonquelle -------------------------------------------
  const dj = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
  if (token) await dj.addCookies([{ name: 'studio', value: token, url: BASE }]);
  const pageA = await dj.newPage();
  pageA.on('pageerror', (e) => console.log('[DJ] pageerror:', e.message.slice(0, 100)));
  pageA.on('console', (m) => {
    const t = m.text();
    if (/webrtc|signaling|audio|track|peer/i.test(t)) console.log('[DJ console]', t.slice(0, 160));
  });
  await pageA.goto(BASE, { waitUntil: 'domcontentloaded' });
  const startBtn = pageA.getByLabel('audioMONASTRY starten');
  if (await startBtn.count()) await startBtn.first().click();
  await pageA.getByTitle('mixerMONK').first().waitFor({ timeout: 30_000 }).catch(() => {});

  // Der DJ muss den mixerMONK UEBERNEHMEN: nur der Main-Out-Halter sendet den
  // Master-Stream (src/App.tsx: startHostMain() prueft isMainOutOwner). Ohne
  // diesen Schritt bleibt der PA stumm - real gemessen im ersten Anlauf.
  // Halter werden: das ⋮-Menue im Rack (NICHT ueber das Kopf-Icon - das Rack ist
  // fest sichtbar, ein Nav-Klick schaltet es sonst zu). Genau wie in der
  // collab-Spec, dort funktioniert es im dev-Modus.
  const mixerMenu = pageA.getByLabel('mixerMONK Menü');
  await mixerMenu.first().waitFor({ timeout: 25_000 }).catch(() => {});
  if (await mixerMenu.count()) {
    await mixerMenu.first().click().catch((e) => console.log('Menue-Klick:', e.message.slice(0, 80)));
    // Bestaetigung abwarten: PRO erscheint nur beim Halter.
    const pro = pageA.locator('#rack-mixer').getByText('PRO').first();
    const hatPro = await pro.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    console.log(`mixerMONK uebernommen (PRO sichtbar: ${hatPro ? 'JA' : 'NEIN'}).`);
    await sleep(2_000);
  } else {
    console.log('Kein mixerMONK-Menue gefunden - Halter konnte nicht gesetzt werden.');
  }

  // Transport starten (der Halter = einziger User darf das). WICHTIG: auf den
  // Knopf WARTEN - im ersten Anlauf war der DOM noch nicht so weit und der Lauf
  // meldete faelschlich "kein PLAY" (real passiert).
  const play = pageA.getByRole('button', { name: /PLAY/i }).first();
  await play.waitFor({ timeout: 20_000 }).catch(() => {});
  if (await play.count()) {
    await play.click().catch((e) => console.log('PLAY-Klick:', e.message.slice(0, 80)));
    console.log('Transport gestartet (PLAY).');
  } else {
    console.log('Kein PLAY-Knopf gefunden - nur der Mikrofonpfad bleibt als Quelle.');
  }
  await sleep(3_000);

  // --- Ghostuser 5: PA-Zuhoerer -------------------------------------------
  const paCtx = await browser.newContext({ viewport: { width: 800, height: 480 } });
  if (token) await paCtx.addCookies([{ name: 'studio', value: token, url: BASE }]);
  const pa = await paCtx.newPage();
  pa.on('pageerror', (e) => console.log('[PA] pageerror:', e.message.slice(0, 100)));
  pa.on('console', (m) => {
    const t = m.text();
    if (/webrtc|signaling|audio|track|peer|main/i.test(t)) console.log('[PA console]', t.slice(0, 160));
  });
  await pa.goto(`${BASE}/master-out`, { waitUntil: 'domcontentloaded' });

  // Auf einen echten Audio-Track warten (max. 30 s).
  let trackInfo = null;
  for (let i = 0; i < 30; i += 1) {
    trackInfo = await pa.evaluate(() => {
      const el = document.querySelector('audio');
      const stream = el?.srcObject;
      const track = stream instanceof MediaStream ? stream.getAudioTracks()[0] : null;
      return track
        ? { hasTrack: true, readyState: track.readyState, enabled: track.enabled, muted: track.muted, label: track.label }
        : { hasTrack: false };
    });
    if (trackInfo?.hasTrack && trackInfo.readyState === 'live') break;
    await sleep(1_000);
  }
  console.log('PA-Track:', JSON.stringify(trackInfo));

  // RMS im Zuschauer messen: AnalyserNode am empfangenen Strom.
  const rms = await pa.evaluate(async () => {
    const el = document.querySelector('audio');
    const stream = el?.srcObject;
    if (!(stream instanceof MediaStream) || stream.getAudioTracks().length === 0) return null;
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    let sum = 0;
    let samples = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 2_500) {
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
      samples += buf.length;
      await new Promise((r) => setTimeout(r, 50));
    }
    const result = { rms: Math.sqrt(sum / Math.max(1, samples)), peak, audioContextState: ctx.state };
    await ctx.close();
    return result;
  });
  console.log('PA-Messung:', JSON.stringify(rms));

  // Gegenprobe: hat der DJ ueberhaupt eine Quelle? Der Mikrofon-Strom liegt im
  // Manager, NICHT zwingend in einem DOM-Element - deshalb zusaetzlich die
  // Geraete-/Capture-Sicht abfragen.
  const djState = await pageA.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const ctxs = [];
    // AudioContext-Zustand ist ein guter Indikator fuer "Engine laeuft".
    if (typeof AudioContext !== 'undefined') ctxs.push('AudioContext vorhanden');
    return {
      audioInputs: devices.filter((d) => d.kind === 'audioinput').length,
      audioOutputs: devices.filter((d) => d.kind === 'audiooutput').length,
      domMedia: Array.from(document.querySelectorAll('audio,video')).length,
      ctxs,
    };
  });
  console.log('DJ-Umgebung:', JSON.stringify(djState));

  // Publisher-Seite produktionssichtbar pruefen: existiert der Main-Out-Stream
  // ueberhaupt? (data-main-stream wird gesetzt, sobald startMainStream lief.)
  const mainStreamState = await pageA.evaluate(() => document.body.dataset.mainStream ?? 'unbekannt');
  console.log('DJ-Marker data-main-stream:', mainStreamState);

  // Serverseitige Sicht: wer ist beigetreten?
  const audit = await fetch(`${BASE}/api/audit`, { headers: { 'x-studio-token': token } }).then((r) => r.json()).catch(() => ({}));
  const joins = (audit.entries ?? []).filter((e) => String(e.action ?? '').startsWith('JOIN_')).map((e) => e.action);
  console.log('Server-Audit JOINs:', JSON.stringify(joins.slice(0, 6)));

  await browser.close();

  const hörbar = Boolean(rms) && rms.rms > 0.001;
  console.log('\nErgebnis:');
  console.log(`  PA hat einen lebenden Audio-Track: ${trackInfo?.hasTrack && trackInfo.readyState === 'live' ? 'JA' : 'NEIN'}`);
  console.log(`  Pegel am Zuschauer (RMS):          ${rms ? rms.rms.toFixed(4) : 'keine Messung'} · Peak ${rms ? rms.peak.toFixed(3) : '-'}`);
  console.log(`  Ton laeuft bis zum PA durch:       ${hörbar ? 'JA' : 'NEIN'}`);
  process.exitCode = hörbar ? 0 : 1;
  process.exit(process.exitCode);
};

main().catch((e) => {
  console.error('Beweis fehlgeschlagen:', e.message);
  process.exit(1);
});
