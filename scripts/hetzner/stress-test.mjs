#!/usr/bin/env node
// =============================================================================
// stress-test.mjs – sampleMONK Hetzner Stress-/Lasttest
// -----------------------------------------------------------------------------
// Testet gegen eine laufende Instanz (lokal oder Hetzner):
//   1. HTTP-Phase:  gemischte Endpunkte (health/cloud/master/compose/statisch)
//      mit N parallelen Clients -> RPS, Latenz-Perzentile, Fehlerrate.
//   2. Socket.io-Phase: viele parallele Signaling-Verbindungen, Session-Join
//      (max. 4), plugin-state-Relay-Latenz, session-full-Enforcement.
//
// Aufruf:
//   BASE_URL=http://49.13.65.150 node scripts/hetzner/stress-test.mjs
//   BASE_URL=... HTTP_CLIENTS=30 HTTP_REQUESTS=150 WS_CLIENTS=60 node scripts/hetzner/stress-test.mjs
// =============================================================================
import { io } from 'socket.io-client';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const HTTP_CLIENTS = Number(process.env.HTTP_CLIENTS || 20);
const HTTP_REQUESTS = Number(process.env.HTTP_REQUESTS || 100);
const WS_CLIENTS = Number(process.env.WS_CLIENTS || 40);
const WS_HOLD_MS = Number(process.env.WS_HOLD_MS || 10_000);

// --- kleine Statistik-Helfer -------------------------------------------------
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function summarize(name, samples, totalMs) {
  const sorted = [...samples].sort((a, b) => a - b);
  const ok = samples.length;
  return {
    name,
    count: ok,
    totalMs: Math.round(totalMs),
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// --- HTTP-Phase --------------------------------------------------------------
async function httpPhase() {
  const endpoints = [
    { method: 'GET', path: '/api/health', weight: 3 },
    { method: 'GET', path: '/api/master/health', weight: 1 },
    { method: 'GET', path: '/api/cloud/health', weight: 1 },
    { method: 'POST', path: '/api/ai/compose', weight: 2, body: { prompt: 'stress' } },
    { method: 'GET', path: '/', weight: 2 },
  ];
  const totalWeight = endpoints.reduce((s, e) => s + e.weight, 0);
  const pick = () => {
    let r = Math.random() * totalWeight;
    for (const e of endpoints) {
      r -= e.weight;
      if (r <= 0) return e;
    }
    return endpoints[0];
  };

  const perEndpoint = new Map();
  const record = (path, status, ms) => {
    if (!perEndpoint.has(path)) perEndpoint.set(path, { ok: 0, fail: 0, samples: [] });
    const rec = perEndpoint.get(path);
    if (status >= 200 && status < 400) { rec.ok++; rec.samples.push(ms); }
    else rec.fail++;
  };

  const started = Date.now();
  const errors = [];

  const REQUEST_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 15_000);

  async function client(id) {
    for (let i = 0; i < HTTP_REQUESTS; i++) {
      const ep = pick();
      const t0 = Date.now();
      try {
        const res = await fetch(BASE_URL + ep.path, {
          method: ep.method,
          headers: ep.body ? { 'content-type': 'application/json' } : undefined,
          body: ep.body ? JSON.stringify(ep.body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        record(ep.path, res.status, Date.now() - t0);
        await res.arrayBuffer().catch(() => {});
      } catch (e) {
        record(ep.path, 0, Date.now() - t0);
        if (errors.length < 5) errors.push(`${ep.method} ${ep.path}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: HTTP_CLIENTS }, (_, i) => client(i)));
  const totalMs = Date.now() - started;
  const totalOk = [...perEndpoint.values()].reduce((s, r) => s + r.ok, 0);
  const totalFail = [...perEndpoint.values()].reduce((s, r) => s + r.fail, 0);
  const allSamples = [...perEndpoint.values()].flatMap((r) => r.samples);

  return {
    clients: HTTP_CLIENTS,
    requestsPerClient: HTTP_REQUESTS,
    totalRequests: totalOk + totalFail,
    ok: totalOk,
    fail: totalFail,
    rps: totalMs > 0 ? Math.round((totalOk / totalMs) * 1000) : 0,
    durationMs: totalMs,
    overall: summarize('http-overall', allSamples, totalMs),
    perEndpoint: [...perEndpoint.entries()].map(([path, r]) => ({
      path,
      ok: r.ok,
      fail: r.fail,
      ...summarize('http', r.samples, totalMs),
    })),
    errors,
  };
}

// --- Socket.io-Phase ---------------------------------------------------------
function connectSocket(id) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const socket = io(BASE_URL, {
      path: '/webrtc-signaling',
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000,
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`connect timeout client ${id}`));
    }, 12_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve({ socket, connectMs: Date.now() - t0 });
    });
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error(`connect_error client ${id}: ${e.message}`));
    });
  });
}

function once(socket, event, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function socketPhase() {
  const connectLat = [];
  const sockets = [];
  const errors = [];

  // 1) Viele Verbindungen oeffnen
  const started = Date.now();
  for (let i = 0; i < WS_CLIENTS; i++) {
    try {
      const { socket, connectMs } = await connectSocket(i);
      connectLat.push(connectMs);
      sockets.push(socket);
    } catch (e) {
      errors.push(e.message);
    }
  }
  const connectMsTotal = Date.now() - started;
  const connected = sockets.length;

  // 2) Session-Join + Relay mit bis zu 4 Clients (Server-Limit)
  let joinLat = [];
  let relayLat = [];
  let sessionFullEnforced = false;
  if (connected >= 5) {
    const joiners = sockets.slice(0, 4);
    for (let i = 0; i < joiners.length; i++) {
      const s = joiners[i];
      const t0 = Date.now();
      try {
        s.emit('join-session', { userId: `stress-${i + 1}` });
        const data = await once(s, 'session-members', 10_000);
        joinLat.push(Date.now() - t0);
        if (!Array.isArray(data?.members)) errors.push(`join ${i + 1}: members nicht array`);
      } catch (e) {
        errors.push(`join ${i + 1}: ${e.message}`);
      }
    }

    // plugin-state-Relay zwischen Client 1 -> 2, 20 Runden
    const [a, b] = joiners;
    for (let r = 0; r < 20; r++) {
      const t0 = Date.now();
      try {
        const received = once(b, 'plugin-state', 5_000);
        a.emit('plugin-state', { pluginId: 'mixer', on: true, round: r });
        await received;
        relayLat.push(Date.now() - t0);
      } catch (e) {
        errors.push(`relay ${r}: ${e.message}`);
      }
    }

    // 5. Client muss abgewiesen werden (session-full)
    try {
      const fifth = sockets[4];
      const t0 = Date.now();
      fifth.emit('join-session', { userId: 'stress-5' });
      const data = await once(fifth, 'session-full', 10_000);
      sessionFullEnforced = data?.max === 4;
      joinLat.push(Date.now() - t0);
    } catch (e) {
      errors.push(`session-full: ${e.message}`);
    }
  } else {
    errors.push(`zu wenige Verbindungen fuer Session-Test (${connected} < 5)`);
  }

  // 3) Verbindungen halten + activity-Pings
  const holdStart = Date.now();
  while (Date.now() - holdStart < WS_HOLD_MS) {
    for (const s of sockets) s.emit('activity');
    await new Promise((r) => setTimeout(r, 1000));
  }

  let disconnects = 0;
  for (const s of sockets) {
    s.disconnect();
    disconnects++;
  }

  return {
    requested: WS_CLIENTS,
    connected,
    failed: WS_CLIENTS - connected,
    connectMsTotal: Math.round(connectMsTotal),
    connect: summarize('ws-connect', connectLat, connectMsTotal),
    join: summarize('ws-join', joinLat, connectMsTotal),
    relay: summarize('ws-plugin-state-relay', relayLat, connectMsTotal),
    sessionFullEnforced,
    holdMs: WS_HOLD_MS,
    disconnects,
    errors,
  };
}

// --- Main --------------------------------------------------------------------
async function main() {
  console.log(`[stress] Ziel: ${BASE_URL}  (http=${HTTP_CLIENTS}x${HTTP_REQUESTS}, ws=${WS_CLIENTS})`);
  console.log('[stress] HTTP-Phase ...');
  const http = await httpPhase();
  console.log(`[stress] HTTP fertig: ${http.ok}/${http.totalRequests} ok, ${http.rps} req/s, Fehler ${http.fail}`);
  console.log('[stress] Socket.io-Phase ...');
  const ws = await socketPhase();
  const summary = { baseUrl: BASE_URL, http, socketio: ws };
  console.log(JSON.stringify(summary, null, 2));
  const exitCode = http.fail === 0 && ws.failed === 0 && ws.sessionFullEnforced ? 0 : 1;
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[stress] Fatal:', e);
  process.exit(2);
});
