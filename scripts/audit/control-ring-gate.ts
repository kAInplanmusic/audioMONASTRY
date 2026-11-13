/** Dedicated Node22 allocation gate. Diagnostics/profilers never run in its window. */
import assert from 'node:assert/strict';
import { getHeapStatistics, writeHeapSnapshot } from 'node:v8';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ControlRing, CONTROL_FIELD, CONTROL_OP, CONTROL_RECORD_WORDS } from '../../src/core/audio/live/controlRing';
assert.equal(process.versions.node.split('.')[0], '22', 'ControlRing gate requires Node22');
assert.equal(typeof global.gc, 'function', '--expose-gc is required');
assert.ok(process.execArgv.includes('--trace-opt') && process.execArgv.includes('--trace-deopt'), 'JIT tracing required');
const directory = resolve(process.env.CONTROL_RING_GATE_OUTPUT ?? 'test-results/control-ring-gate-' + Date.now());
mkdirSync(directory, { recursive: true, mode: 0o700 });
const ring = ControlRing.create(10001), rec = new Float64Array(CONTROL_RECORD_WORDS);
const fill = () => { for (let i = 0; i < 10000; i++) ring.push(CONTROL_OP.GAIN_DB, i & 7, i, i); };
let consumed = 0;
const consumeAll = () => { while (ring.peek(rec)) { ring.advance(); consumed++; } };
for (let batch = 0; batch < 100; batch++) { fill(); consumeAll(); getHeapStatistics(); }
fill(); assert.equal(ring.size, 10000); consumed = 0;
// Single explicit collection AFTER producer/matchers/warmup, BEFORE baseline.
// No after-GC subtraction and no snapshot/profiler in the measurement process.
global.gc!();
const before = getHeapStatistics().used_heap_size;
consumeAll();
const after = getHeapStatistics().used_heap_size;
const result = { node: process.version, pid: process.pid, execArgv: process.execArgv,
  warmupBatches: 100, recordsPerBatch: 10000, explicitGcCalls: 1,
  baseline: 'after complete-batch warmup, getHeapStatistics warmup, producer, matcher and single explicit GC',
  snapshotsDuringGate: false, before, after, deltaBytes: after - before,
  limitBytes: 16384, remainingRecords: ring.size, consumedRecords: consumed, lastReadA: rec[CONTROL_FIELD.A], pass: after - before < 16384 };
writeFileSync(join(directory, 'gate.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log('CONTROL_RING_GATE ' + JSON.stringify(result));
if (!result.pass) {
  // Preserve the SAME red process for post-window diagnostics. Snapshot causes
  // GC, so it cannot reconstruct transient allocations that have already died.
  (globalThis as any).__redRingGate = { ring, rec, result };
  writeHeapSnapshot(join(directory, 'red-after.heapsnapshot'));
}
assert.equal(ring.size, 0); assert.equal(consumed, 10000); assert.equal(rec[CONTROL_FIELD.A], 9999);
assert.ok(result.pass, `ControlRing heap delta ${result.deltaBytes}B >= 16384B; raw baseline saved in ${directory}`);
