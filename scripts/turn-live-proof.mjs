/**
 * Live-Beweis: TURN-Relay + Server-Credentials (COLLAB-P0-003)
 * =====================================================================
 * Bisher war der TURN-Pfad nur verdrahtet, nicht nachgewiesen: „echtes
 * TURN-Relay nicht nachweisbar" (TURN_URLS/TURN_STATIC_AUTH_SECRET fehlten in der
 * Umgebung). Dieses Skript schliesst die Luecke lokal, mit einem echten
 * coturn-Server:
 *
 *   1. Es holt die ICE-Konfiguration von der App (`/api/webrtc-config`) —
 *      dieselben kurzlebigen coturn-REST-Credentials, die der Client bekommt.
 *   2. Es verbindet zwei PeerConnections mit **iceTransportPolicy: 'relay'** —
 *      eine Verbindung ist damit NUR ueber den Relay moeglich, nicht per
 *      Host-/Server-Reflexive-Kandidat.
 *   3. Es prueft per getStats, dass der AUSGEWAEHLTE Kandidatenpfad wirklich
 *      `relay` ist (nicht nur „verbunden").
 *   4. GEGENPROBE: mit manipuliertem Credential muss die Verbindung scheitern —
 *      sonst waere die Rechtepruefung des TURN-Servers wirkungslos und der
 *      Beweis wertlos.
 *
 * Aufruf (coturn laeuft lokal, App laeuft mit denselben Werten):
 *   TURN_URLS=turn:127.0.0.1:3478 TURN_STATIC_AUTH_SECRET=... npx tsx server.ts
 *   APP_URL=http://127.0.0.1:8080 STUDIO_TOKEN=... node scripts/turn-live-proof.mjs
 */
import { chromium } from 'playwright';

const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const STUDIO_TOKEN = process.env.STUDIO_TOKEN || '';
const EXPECT_TURN = process.env.EXPECT_TURN !== '0';

/**
 * Der Probelauf selbst — laeuft IM BROWSER (nur dort gibt es RTCPeerConnection).
 * Zwei Peers in einer Seite, SDP-Austausch direkt, ICE vollstaendig sammeln.
 */
const runRelayProbe = async ({ servers, timeoutMs }) => {
  const pcA = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
  const pcB = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
  const seen = [];
  pcA.onicecandidate = (e) => { if (e.candidate) seen.push(e.candidate.type); };
  pcB.onicecandidate = (e) => { if (e.candidate) seen.push(e.candidate.type); };
  pcA.createDataChannel('probe');

  const gather = (pc) => new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
  });
  const waitConnected = Promise.race([
    new Promise((resolve) => {
      const check = () => {
        if (pcA.connectionState === 'connected' && pcB.connectionState === 'connected') resolve('connected');
        else if (['failed', 'closed'].includes(pcA.connectionState) || ['failed', 'closed'].includes(pcB.connectionState)) {
          resolve(pcA.connectionState);
        }
      };
      pcA.onconnectionstatechange = check;
      pcB.onconnectionstatechange = check;
    }),
    new Promise((resolve) => setTimeout(() => resolve(`timeout:${pcA.connectionState}/${pcB.connectionState}`), timeoutMs)),
  ]);

  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  await gather(pcA);
  await pcB.setRemoteDescription(pcA.localDescription);
  const answer = await pcB.createAnswer();
  await pcB.setLocalDescription(answer);
  await gather(pcB);
  await pcA.setRemoteDescription(pcB.localDescription);

  const outcome = await waitConnected;
  let selected = null;
  try {
    const stats = await pcA.getStats();
    const pairs = [...stats.values()].filter((s) => s.type === 'candidate-pair' && s.state === 'succeeded');
    const pair = pairs.find((p) => p.nominated) ?? pairs[0];
    if (pair) {
      const local = [...stats.values()].find((s) => s.id === pair.localCandidateId);
      const remote = [...stats.values()].find((s) => s.id === pair.remoteCandidateId);
      selected = {
        localType: local?.candidateType ?? 'unbekannt',
        remoteType: remote?.candidateType ?? 'unbekannt',
        localAddress: local?.address ?? '',
        protocol: local?.protocol ?? '',
      };
    }
  } catch { /* ohne Stats bleibt selected null */ }
  pcA.close();
  pcB.close();
  return { outcome, selected, candidatesSeen: [...new Set(seen)].sort() };
};

const main = async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

  const config = await page.evaluate(async ({ appUrl, token }) => {
    const res = await fetch(`${appUrl}/api/webrtc-config`, { headers: token ? { 'x-studio-token': token } : {} });
    return { status: res.status, body: await res.json() };
  }, { appUrl: APP_URL, token: STUDIO_TOKEN });

  const iceServers = config.body?.iceServers ?? [];
  console.log('GET /api/webrtc-config ->', config.status);
  console.log('ICE-Server:', JSON.stringify(iceServers.map((s) => ({
    urls: s.urls,
    hasCredential: Boolean(s.credential),
    username: s.username ? `${String(s.username).slice(0, 12)}…` : undefined,
  }))));

  const hasTurn = iceServers.some((s) => JSON.stringify(s.urls).includes('turn:'));
  if (!hasTurn) {
    console.error('ABBRUCH: keine TURN-Server in der Konfiguration (TURN_URLS/TURN_STATIC_AUTH_SECRET gesetzt?)');
    await browser.close();
    process.exit(2);
  }

  const relay = await page.evaluate(runRelayProbe, { servers: iceServers, timeoutMs: 20_000 });
  console.log('Relay-Probe:', JSON.stringify(relay));

  const tampered = iceServers.map((s) => (s.credential ? { ...s, credential: `${s.credential}x` } : s));
  const negative = await page.evaluate(runRelayProbe, { servers: tampered, timeoutMs: 15_000 });
  console.log('Gegenprobe (Credential manipuliert):', JSON.stringify(negative));

  await browser.close();

  const relayOk = relay.outcome === 'connected' && relay.selected?.localType === 'relay'
    && relay.selected?.remoteType === 'relay';
  const negativeOk = negative.outcome !== 'connected' || negative.selected?.localType !== 'relay';

  console.log('\nErgebnis:');
  console.log(`  Verbindung ausschliesslich ueber TURN-Relay: ${relayOk ? 'JA' : 'NEIN'}`);
  console.log(`  Manipuliertes Credential wird abgelehnt:    ${negativeOk ? 'JA' : 'NEIN'}`);
  if (!EXPECT_TURN && !relayOk) {
    console.log('  (EXPECT_TURN=0: fehlendes Relay ist hier kein Fehler)');
    process.exit(0);
  }
  process.exit(relayOk && negativeOk ? 0 : 1);
};

main().catch((e) => {
  console.error('Probe fehlgeschlagen:', e);
  process.exit(1);
});
