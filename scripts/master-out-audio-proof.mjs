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
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { BASE, sleep, token } from './lib/proof-browser.mjs';

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
    // Der Kanal-Gate verlangt PRO **und** den SERVER-Lock auf 'mixer' mit eigener
    // userId (src/App.tsx). Der Lock kommt per Socket - deshalb hier warten und
    // den Rack-Zustand protokollieren, statt zu raten.
    await sleep(6_000);
    const rack = await pageA.locator('#rack-mixer').innerText().catch(() => '');
    console.log('Rack-Zustand:', JSON.stringify(rack.replace(/\s+/g, ' ').slice(0, 120)));
  } else {
    console.log('Kein mixerMONK-Menue gefunden - Halter konnte nicht gesetzt werden.');
  }

  // Sample auf einen Kanal legen - DAS ist der Ausloeser fuer den V2-Sink.
  //
  // Warum ein EIGENER Upload: die Library-Presets ("TR-909 Classic Kick") haben in
  // dieser Umgebung keine Audio-URL, der Menuepunkt "Send to Track" ist dann
  // korrekt mit dem Hinweis "kein Audio-URL" gesperrt (gemessen). Ein lokaler
  // Upload bekommt eine Blob-URL und ist damit sendbar. Der Kanal selbst ist nur
  // fuer den Halter frei ("nur DJ / Freigabe") - den haben wir oben gesetzt.
  let sampleAssigned = false;
  try {
    const wav = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-af', 'volume=0.5', '-ar', '48000', '-ac', '2',
      '-f', 'wav', 'pipe:1',
    ], { maxBuffer: 64 * 1024 * 1024 });
    await pageA.locator('nav[aria-label="Studio-Navigation"]').getByTitle('biblioMONK').first().click({ timeout: 10_000 });
    const fileInput = pageA.locator('input[type="file"]:visible').first();
    await fileInput.setInputFiles({ name: 'pa-beweis.wav', mimeType: 'audio/wav', buffer: wav });
    await sleep(4_000);
    await pageA.getByPlaceholder('Suche Samples & Musik…').fill('pa-beweis').catch(() => {});
    const sample = pageA.getByRole('heading', { name: /pa-beweis/ }).first();
    await sample.waitFor({ timeout: 20_000 });
    await sample.click();
    const menu = pageA.getByRole('menu', { name: 'Audio-Aktionen' });
    await menu.waitFor({ timeout: 10_000 });
    const sendItem = menu.getByRole('menuitem', { name: /Send to Track/ });
    if (await sendItem.isDisabled()) {
      console.log('Send to Track ist gesperrt (Hinweis:', await sendItem.textContent().then((t) => String(t).trim()).catch(() => '?'), ')');
    } else {
      await sendItem.click();
      const target = menu.getByRole('menuitem', { name: /CH 1 · KICK/ }).first();
      await target.waitFor({ timeout: 10_000 });
      if (await target.isDisabled()) {
        console.log('Kanal CH 1 · KICK ist GESPERRT (Halter gesetzt!) - Befund.');
      } else {
        await target.click();
        sampleAssigned = true;
        console.log('Upload-Sample auf CH 1 · KICK gelegt (V2-Sink sollte verbinden).');
      }
    }
  } catch (e) {
    console.log('Sample-Zuweisung nicht moeglich:', String(e.message).slice(0, 200).replace(/\n/g, ' '));
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
  console.log('Sample auf Kanal gelegt:', sampleAssigned ? 'JA' : 'NEIN');

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
