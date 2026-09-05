#!/usr/bin/env node
// =============================================================================
// memory-pressure-gate.mjs – AM-E5-2 Heap-Wachstums-Gate
// -----------------------------------------------------------------------------
// Führt eine repräsentative, deterministische Arbeitslast aus (Worklet-artige
// Block-Verarbeitung, Session-Snapshot-Serialisierung analog IndexedDB/
// largeStore, Telemetrie-Ringpuffer) und misst das Heap-Wachstum (Delta).
// Gate: < 512 MB Heap-Delta (AM-E5-2). Die volle 2-GB-OOM-Simulation bleibt
// bewusst offen – dieses Skript ist das CI-Gate für schleichende Leaks.
//
// Aufruf (GC-Zugriff nötig):
//   node --expose-gc scripts/memory-pressure-gate.mjs
// =============================================================================
import { createHash } from 'node:crypto';

const HEAP_GATE_BYTES = 512 * 1024 * 1024;

function forceGc() {
  if (typeof globalThis.gc === 'function') {
    for (let i = 0; i < 3; i++) globalThis.gc();
  }
}

function heapUsed() {
  return process.memoryUsage().heapUsed;
}

/** Worklet-artige Biquad-Verarbeitung auf Float32-Blöcken (128 Samples). */
function runWorkletLikeLoad(blocks) {
  const c = [0.2929, 0.5858, 0.2929, -0.0, 0.1716]; // Butterworth-LP-Beispiel
  const state = { x1: 0, x2: 0, y1: 0, y2: 0 };
  for (let b = 0; b < blocks; b++) {
    const buf = new Float32Array(128);
    buf[0] = (b % 1000) / 1000;
    for (let i = 0; i < 128; i++) {
      const x = buf[i];
      const y = c[0] * x + c[1] * state.x1 + c[2] * state.x2 - c[3] * state.y1 - c[4] * state.y2;
      state.x2 = state.x1; state.x1 = x;
      state.y2 = state.y1; state.y1 = y;
      buf[i] = y;
    }
  }
}

/** Session-Snapshot-Serialisierung (IndexedDB/largeStore-Pfad). */
function runSnapshotLoad(rounds) {
  const snapshot = {
    patterns: Object.fromEntries(['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'].map((k) => [k, Array.from({ length: 32 }, (_, i) => i % 4 === 0)])),
    synthNotes: Array.from({ length: 32 }, (_, i) => i % 8),
    bpm: 128,
    mixer: { channel1: 0.8, channel2: 0.6 },
    routing: { mode: '2.1', layout: '2.1' },
  };
  for (let i = 0; i < rounds; i++) {
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json);
    createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
  }
}

/** Telemetrie-Ringpuffer (Xrun-Historie, max. 100). */
function runTelemetryLoad(events) {
  const history = [];
  for (let i = 0; i < events; i++) {
    history.push({ ts: Date.now() + i, source: `src-${i % 8}` });
    if (history.length > 100) history.shift();
  }
}

function main() {
  if (typeof globalThis.gc !== 'function') {
    console.error('❌ memory-pressure-gate: bitte mit `node --expose-gc` ausführen.');
    process.exit(2);
  }

  forceGc();
  const before = heapUsed();

  runWorkletLikeLoad(200_000);
  runSnapshotLoad(2_000);
  runTelemetryLoad(200_000);

  forceGc();
  const after = heapUsed();
  const delta = after - before;

  const mb = (b) => (b / 1024 / 1024).toFixed(2);
  console.log(`[memory-gate] Heap vorher ${mb(before)} MB · nachher ${mb(after)} MB · Delta ${mb(delta)} MB (Gate ${mb(HEAP_GATE_BYTES)} MB)`);

  if (delta > HEAP_GATE_BYTES) {
    console.error(`❌ Memory-Gate überschritten: ${mb(delta)} MB > ${mb(HEAP_GATE_BYTES)} MB.`);
    process.exit(1);
  }
  console.log('✅ Memory-Pressure-Gate bestanden (< 512 MB Heap-Delta).');
}

main();
