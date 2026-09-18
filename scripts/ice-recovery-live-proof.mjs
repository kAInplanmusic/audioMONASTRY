/**
 * Live-Beweis: ICE-Ausfall und Wiederherstellung mit echtem TURN-Ausfall
 * =====================================================================
 * COLLAB-P0-003 liess genau das offen: „die Main-Stream-Wiederherstellung nach
 * echtem ICE-Fail ist nur verdrahtet, nicht live gemessen". Die Zustandsmaschine
 * war unit-getestet — aber nie gegen einen ECHTEN Ausfall der Transportstrecke.
 *
 * Hier wird genau das gemessen, mit dem ausgelieferten Modul (per Dev-Server
 * importiert, also kein Nachbau):
 *
 *   1. Zwei Peers verbinden sich **relay-only** ueber einen lokalen coturn.
 *   2. Der Relay wird WAEHREND der Verbindung abgeschaltet (docker stop coturn)
 *      -> echtes ICE-Fail, kein simuliertes Event.
 *   3. Auf jedes echte ICE-/Connection-Event laeuft
 *      `src/core/transport/connectionRecovery.ts` (das Modul der App) und liefert
 *      seine Entscheidung; 'restart-ice' wird als echter ICE-Restart ausgefuehrt
 *      (neues Offer mit iceRestart: true).
 *   4. Der Relay kommt zurueck (docker start coturn) -> die Verbindung muss von
 *      selbst wieder 'connected' werden. Das ist die Messung.
 *
 * Voraussetzungen (sonst bricht das Skript mit Grund ab): laufender Dev-Server mit
 * TURN-Konfiguration, laufender coturn-Container namens `am-coturn`, Docker-Zugriff.
 *
 * Aufruf:
 *   APP_URL=http://127.0.0.1:8080 STUDIO_TOKEN=... node scripts/ice-recovery-live-proof.mjs
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const STUDIO_TOKEN = process.env.STUDIO_TOKEN || '';
const CONTAINER = process.env.TURN_CONTAINER || 'am-coturn';
const FAIL_TIMEOUT_MS = Number(process.env.FAIL_TIMEOUT_MS || 90_000);
const RECOVER_TIMEOUT_MS = Number(process.env.RECOVER_TIMEOUT_MS || 90_000);

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

const probe = async ({ servers, failTimeoutMs, recoverTimeoutMs, policy }) => {
  // page.exposeFunction('__phase') stellt window.__phase bereit.
  const report = (name) => { try { window.__phase?.(name); } catch { /* Bindung fehlt */ } };
  const recoveryModule = await import('/src/core/transport/connectionRecovery.ts');

  const pcA = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
  const pcB = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
  pcA.createDataChannel('probe');
  const merge = (pc, offer) => pc.setRemoteDescription(offer);

  const negotiate = async (iceRestart) => {
    const offer = await pcA.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pcA.setLocalDescription(offer);
    await new Promise((r) => (pcA.iceGatheringState === 'complete' ? r() : (pcA.onicegatheringstatechange = () => pcA.iceGatheringState === 'complete' && r())));
    await merge(pcB, pcA.localDescription);
    const answer = await pcB.createAnswer();
    await pcB.setLocalDescription(answer);
    await new Promise((r) => (pcB.iceGatheringState === 'complete' ? r() : (pcB.onicegatheringstatechange = () => pcB.iceGatheringState === 'complete' && r())));
    await merge(pcA, pcB.localDescription);
  };

  // Diagnose: welche Kandidaten fallen je Versuch an? Ohne diese Zahlen ist
  // "erholt sich nicht" nicht von "hat gar keinen Relay mehr bekommen" zu trennen.
  const candidateLog = [];
  let candidateBatch = [];
  pcA.onicecandidate = (e) => {
    if (e.candidate) {
      candidateBatch.push(`A:${e.candidate.type}@${e.candidate.address ?? ''}:${e.candidate.port ?? ''}`);
    } else if (candidateBatch.length > 0) {
      candidateLog.push(candidateBatch.join(' | '));
      candidateBatch = [];
    }
  };

  let state = recoveryModule.createRecoveryState();
  const timeline = [];
  let disconnectedSince = null;
  let failedSeen = false;
  let recovered = false;
  let iceRestarts = 0;

  const handle = () => {
    const ice = pcA.iceConnectionState;
    const connection = pcA.connectionState;
    if (ice === 'disconnected' || connection === 'disconnected') {
      if (disconnectedSince === null) disconnectedSince = Date.now();
    } else {
      disconnectedSince = null;
    }
    const input = {
      ice,
      connection,
      disconnectedForMs: disconnectedSince === null ? 0 : Date.now() - disconnectedSince,
    };
    const decision = recoveryModule.nextRecoveryDecision(state, input, policy);
    state = decision.state;
    timeline.push({ t: Date.now(), ice, connection, action: decision.action, reason: decision.reason, attempt: state.attempts });

    if (decision.action === 'restart-ice' || decision.action === 'reconnect') {
      iceRestarts += 1;
      report(`restart-ice#${iceRestarts}`);
      void negotiate(true).catch(() => { /* best effort */ });
    }
    if (decision.action === 'gave-up') report('gave-up');
    if ((ice === 'failed' || connection === 'failed') && !failedSeen) {
      failedSeen = true;
      report('failed');
    }
    if (failedSeen && (ice === 'connected' || ice === 'completed')) {
      recovered = true;
      report('recovered');
    }
    if (ice === 'connected' && !failedSeen) report('connected');
  };

  pcA.oniceconnectionstatechange = handle;
  pcA.onconnectionstatechange = handle;
  pcB.oniceconnectionstatechange = handle;

  await negotiate(false);
  const started = Date.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (recovered) { clearInterval(timer); resolve(); }
      if (Date.now() - started > failTimeoutMs + recoverTimeoutMs) { clearInterval(timer); resolve(); }
    }, 500);
  });

  pcA.close();
  pcB.close();
  return {
    recovered,
    iceRestarts,
    failedSeen,
    candidateLog,
    finalIce: '',
    timeline: timeline.map((e) => ({ ...e, tRel: e.t - timeline[0].t })),
  };
};

const main = async () => {
  docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

  const phases = [];
  await page.exposeFunction('__phase', (name) => { phases.push({ name, at: Date.now() }); });

  const config = await page.evaluate(async ({ appUrl, token }) => {
    const res = await fetch(`${appUrl}/api/webrtc-config`, { headers: token ? { 'x-studio-token': token } : {} });
    return res.json();
  }, { appUrl: APP_URL, token: STUDIO_TOKEN });
  const iceServers = config.iceServers ?? [];

  // Die Policy wird fuer das Messfenster gesetzt (mehr Versuche, kuerzere
  // Abstaende), die ENTSCHEIDUNGSLOGIK bleibt die des ausgelieferten Moduls.
  const policy = {
    maxAttempts: Number(process.env.PROOF_MAX_ATTEMPTS || 8),
    baseDelayMs: 500,
    maxDelayMs: 4_000,
    disconnectGraceMs: 2_000,
    restartIceOnFirstFailure: true,
  };
  const probePromise = page.evaluate(probe, {
    servers: iceServers,
    failTimeoutMs: FAIL_TIMEOUT_MS,
    recoverTimeoutMs: RECOVER_TIMEOUT_MS,
    policy,
  }).catch((e) => ({ error: String(e) }));

  // Warten auf 'connected', dann den Relay abschalten (echter Ausfall).
  const waitFor = async (name, timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (phases.some((p) => p.name === name || p.name.startsWith(name))) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  const connected = await waitFor('connected', 30_000);
  console.log(`Verbindung ueber Relay aufgebaut: ${connected ? 'JA' : 'NEIN'}`);
  if (!connected) {
    console.log('Phasen:', JSON.stringify(phases));
    await browser.close();
    process.exit(2);
  }

  console.log(`coturn abschalten (echter ICE-Ausfall) ...`);
  docker(['stop', CONTAINER]);
  const failed = await waitFor('failed', FAIL_TIMEOUT_MS);
  console.log(`ICE-Ausfall beobachtet: ${failed ? 'JA' : 'NEIN'}`);
  const restarted = await waitFor('restart-ice', 30_000);
  console.log(`ICE-Restart durch die Zustandsmaschine: ${restarted ? 'JA' : 'NEIN'}`);

  console.log(`coturn wieder starten ...`);
  docker(['start', CONTAINER]);
  await new Promise((r) => setTimeout(r, 3_000));
  console.log(`coturn-Status nach dem Start: ${docker(['inspect', '-f', '{{.State.Running}}', CONTAINER])}`);
  const recovered = await waitFor('recovered', RECOVER_TIMEOUT_MS);
  console.log(`Verbindung wiederhergestellt: ${recovered ? 'JA' : 'NEIN'}`);

  const result = await probePromise;
  await browser.close();

  console.log('\nPhasen:', JSON.stringify(phases.map((p) => p.name)));
  if (result && result.candidateLog) {
    console.log('Kandidaten je Sammellauf (A = pcA):');
    for (const line of result.candidateLog) console.log('  ', line);
  }
  if (result && result.timeline) {
    console.log('Zeitachse (ms relativ, echte ICE-Events):');
    for (const e of result.timeline) {
      console.log(`  +${String(e.tRel).padStart(6)} ms  ice=${e.ice.padEnd(12)} conn=${e.connection.padEnd(12)} -> ${e.action} (${e.reason})`);
    }
  }
  console.log('\nErgebnis:');
  console.log(`  Relay-Verbindung:        ${connected ? 'JA' : 'NEIN'}`);
  console.log(`  Echter ICE-Ausfall:      ${failed ? 'JA' : 'NEIN'}`);
  console.log(`  ICE-Restart ausgefuehrt: ${result?.iceRestarts ?? 0}x`);
  console.log(`  Selbsttaugliche Wiederherstellung: ${recovered ? 'JA' : 'NEIN'}`);
  process.exit(connected && failed && recovered ? 0 : 1);
};

main().catch(async (e) => {
  console.error('Probe fehlgeschlagen:', e);
  try { docker(['start', CONTAINER]); } catch { /* nichts */ }
  process.exit(1);
});
