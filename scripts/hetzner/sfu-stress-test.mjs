#!/usr/bin/env node
// =============================================================================
// sfu-stress-test.mjs – sampleMONK SFU/Mediasoup-Lasttest (Signaling-Ebene)
// -----------------------------------------------------------------------------
// Testet gegen eine Instanz mit ENABLE_SFU=1:
//   * N parallele Socket.io-Clients auf /sfu-signaling
//   * getRouterRtpCapabilities  -> Router-Erstellung je Session messen
//   * createTransport           -> WebRtcTransport-Erstellung messen (teuer)
//   * connectTransport (fake)   -> muss sauber mit error antworten
//   * Aufraeumen: disconnect schliesst Transports serverseitig
//
// Hinweis: Ein echter Medienpfad (DTLS/ICE/RTP) ist in reinem Node nicht ohne
// WebRTC-Stack (wrtc/werift) moeglich – hier wird die Server-/Worker-Last der
// SFU-Signalisierung und Transport-Allokation gemessen.
//
// Aufruf:
//   BASE_URL=http://49.13.65.150 node scripts/hetzner/sfu-stress-test.mjs
//   BASE_URL=... SFU_CLIENTS=40 SFU_TRANSPORTS=5 SFU_SESSIONS=10 node scripts/hetzner/sfu-stress-test.mjs
// =============================================================================
import { io } from 'socket.io-client';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const SFU_CLIENTS = Number(process.env.SFU_CLIENTS || 30);
const SFU_TRANSPORTS = Number(process.env.SFU_TRANSPORTS || 3);
const SFU_SESSIONS = Number(process.env.SFU_SESSIONS || 6);
const TIMEOUT_MS = Number(process.env.SFU_TIMEOUT_MS || 20_000);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function summarize(name, samples, totalMs) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    count: sorted.length,
    totalMs: Math.round(totalMs),
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function emitAck(socket, event, data = {}, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: 'timeout' }), timeoutMs);
    socket.emit(event, data, (resp) => {
      clearTimeout(timer);
      resolve(resp ?? {});
    });
  });
}

async function clientRun(id) {
  const sessionId = `stress-${id % SFU_SESSIONS}`;
  const t0 = Date.now();
  const socket = io(BASE_URL, {
    path: '/sfu-signaling',
    transports: ['websocket'],
    reconnection: false,
    timeout: 10_000,
    query: { sessionId },
  });
  const result = {
    id,
    sessionId,
    connectMs: 0,
    rtpCapMs: 0,
    rtpCapOk: false,
    transports: [],
    transportErrors: 0,
    connectErrors: 0,
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 12_000);
      socket.on('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('connect_error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
    });
    result.connectMs = Date.now() - t0;

    // Router je Session anlegen (einmal je Client)
    const t1 = Date.now();
    const rtp = await emitAck(socket, 'getRouterRtpCapabilities');
    result.rtpCapMs = Date.now() - t1;
    result.rtpCapOk = !!rtp.rtpCapabilities;
    if (rtp.error) result.transportErrors++;

    // WebRtcTransports allokieren (Worker-Last)
    for (let i = 0; i < SFU_TRANSPORTS; i++) {
      const t2 = Date.now();
      const tr = await emitAck(socket, 'createTransport');
      const ms = Date.now() - t2;
      if (tr.id && tr.iceParameters && tr.dtlsParameters) {
        result.transports.push(ms);
        // Fake-DTLS-Connect: muss sauber mit error antworten (kein Absturz)
        const cn = await emitAck(socket, 'connectTransport', { dtlsParameters: { role: 'client', fingerprints: [] } });
        if (cn.error) result.connectErrors++;
      } else {
        result.transportErrors++;
      }
    }
  } catch (e) {
    result.transportErrors++;
    result.error = e.message;
  } finally {
    socket.disconnect();
  }
  return result;
}

async function main() {
  console.log(`[sfu-stress] Ziel: ${BASE_URL}  (clients=${SFU_CLIENTS}, transports=${SFU_TRANSPORTS}, sessions=${SFU_SESSIONS})`);
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: SFU_CLIENTS }, (_, i) => clientRun(i)));
  const totalMs = Date.now() - started;

  const connect = results.map((r) => r.connectMs);
  const rtpCap = results.filter((r) => r.rtpCapOk).map((r) => r.rtpCapMs);
  const transports = results.flatMap((r) => r.transports);
  const okTransports = transports.length;
  const requestedTransports = SFU_CLIENTS * SFU_TRANSPORTS;
  const transportErrors = results.reduce((s, r) => s + r.transportErrors, 0);
  const connectErrors = results.reduce((s, r) => s + r.connectErrors, 0);

  const summary = {
    baseUrl: BASE_URL,
    clients: SFU_CLIENTS,
    sessions: SFU_SESSIONS,
    transportsRequested: requestedTransports,
    transportsCreated: okTransports,
    transportErrors,
    fakeConnectErrors: connectErrors,
    rtpCapOk: results.filter((r) => r.rtpCapOk).length,
    durationMs: Math.round(totalMs),
    transportRate: totalMs > 0 ? Math.round((okTransports / totalMs) * 1000) : 0,
    connect: summarize('sfu-connect', connect, totalMs),
    rtpCapabilities: summarize('sfu-rtpCapabilities', rtpCap, totalMs),
    createTransport: summarize('sfu-createTransport', transports, totalMs),
    errors: results.filter((r) => r.error).slice(0, 5).map((r) => `${r.id}: ${r.error}`),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(okTransports === requestedTransports && transportErrors === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[sfu-stress] Fatal:', e);
  process.exit(2);
});
