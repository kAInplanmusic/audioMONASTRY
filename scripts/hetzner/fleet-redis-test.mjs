#!/usr/bin/env node
// =============================================================================
// fleet-redis-test.mjs – Redis-Fleet-Signaling-Test (Cross-Instanz)
// -----------------------------------------------------------------------------
// Verbindet zwei socket.io-Clients mit zwei App-Instanzen:
//   Client A -> Instanz 1 (:8080)
//   Client B -> Instanz 2 (:8081, teilt Redis-Räume mit Instanz 1)
// Danach sendet A ein Offer an B.socketId. Ohne Redis-Adapter würde das
// Event die Instanzgrenze NICHT überschreiten; mit Adapter muss es bei B
// ankommen. Anschließend antwortet B und A muss die Answer erhalten.
//
// Aufruf (innerhalb des samplemonk-Containers):
//   node /tmp/fleet-redis-test.mjs
//   A_URL=http://127.0.0.1:8080 B_URL=http://samplemonk-2:8081 node /tmp/fleet-redis-test.mjs
// =============================================================================
import { createRequire } from 'node:module';

// Auflösung aus dem App-Verzeichnis (Container: /app, read-only) statt /tmp
const require = createRequire(process.env.APP_DIR || '/app/');
const { io } = require('socket.io-client');

const A_URL = process.env.A_URL || 'http://127.0.0.1:8080';
const B_URL = process.env.B_URL || 'http://samplemonk-2:8081';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);

const state = {
  aConnected: false,
  bConnected: false,
  bGotOffer: false,
  aGotAnswer: false,
};

const done = (ok, msg) => {
  console.log(ok ? `✅ FLEET-TEST OK: ${msg}` : `❌ FLEET-TEST FAIL: ${msg}`);
  try { a.close(); } catch {}
  try { b.close(); } catch {}
  process.exit(ok ? 0 : 1);
};

const failTimer = setTimeout(() => {
  done(false, `Timeout nach ${TIMEOUT_MS}ms – State: ${JSON.stringify(state)}`);
}, TIMEOUT_MS);

const a = io(A_URL, { path: '/webrtc-signaling', transports: ['websocket'], forceNew: true });
const b = io(B_URL, { path: '/webrtc-signaling', transports: ['websocket'], forceNew: true });

const startExchange = () => {
  if (!state.aConnected || !state.bConnected) return;
  if (!b.id || !a.id) return;
  console.log(`[fleet-test] A=${a.id} (${A_URL})  B=${b.id} (${B_URL})`);
  console.log('[fleet-test] A sendet Offer an B.socketId (cross-instance) ...');
  setTimeout(() => a.emit('offer', { target: b.id, offer: { sdp: 'fleet-test-sdp' } }), 500);
};

a.on('connect', () => {
  state.aConnected = true;
  console.log(`[fleet-test] A verbunden: ${a.id}`);
  startExchange();
});
b.on('connect', () => {
  state.bConnected = true;
  console.log(`[fleet-test] B verbunden: ${b.id}`);
  startExchange();
});

b.on('offer', (data) => {
  if (data && data.sender === a.id && data.offer && data.offer.sdp === 'fleet-test-sdp') {
    state.bGotOffer = true;
    console.log('[fleet-test] B hat Offer von A erhalten (Redis-Relay OK). B antwortet ...');
    b.emit('answer', { target: data.sender, answer: { sdp: 'fleet-test-answer' } });
  }
});

a.on('answer', (data) => {
  if (data && data.sender === b.id && data.answer && data.answer.sdp === 'fleet-test-answer') {
    state.aGotAnswer = true;
    clearTimeout(failTimer);
    done(true, 'Offer (A→B) und Answer (B→A) über Redis-Adapter zugestellt.');
  }
});

a.on('connect_error', (e) => done(false, `A connect_error: ${e.message}`));
b.on('connect_error', (e) => done(false, `B connect_error: ${e.message}`));
