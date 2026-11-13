/** Separate profiler of the old accumulator; sampling changes execution, never a gate result. */
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { getHeapStatistics } from 'node:v8';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ControlRing, CONTROL_FIELD, CONTROL_OP, CONTROL_RECORD_WORDS } from '../../src/core/audio/live/controlRing';
assert.equal(process.versions.node.split('.')[0], '22', 'ControlRing gate requires Node22');
assert.equal(typeof global.gc, 'function', '--expose-gc is required');
assert.ok(process.execArgv.includes('--trace-opt') && process.execArgv.includes('--trace-deopt'), 'JIT tracing required');
const directory = resolve(process.env.CONTROL_RING_PROFILE_OUTPUT ?? 'test-results/control-ring-allocation-profile-' + Date.now());
mkdirSync(directory, { recursive: true, mode: 0o700 });
const ring = ControlRing.create(10001), rec = new Float64Array(CONTROL_RECORD_WORDS), acc = new Float64Array(1);
const fill = () => { for (let i = 0; i < 10000; i++) ring.push(CONTROL_OP.GAIN_DB, i & 7, i, i); };
const consumeAll = () => { while (ring.peek(rec)) { acc[0] += rec[CONTROL_FIELD.A]; ring.advance(); } };
for (let batch = 0; batch < 100; batch++) { fill(); consumeAll(); getHeapStatistics(); }
fill(); assert.equal(ring.size, 10000);
// Single explicit collection AFTER producer/matchers/warmup, BEFORE baseline.
// No after-GC subtraction and no snapshot/profiler in the measurement process.
const inspector = new Session(); inspector.connect();
inspector.post('HeapProfiler.startSampling', { samplingInterval: 16, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
global.gc!();
const before = getHeapStatistics().used_heap_size;
consumeAll();
const after = getHeapStatistics().used_heap_size;
inspector.post('HeapProfiler.stopSampling', (error, allocation) => {
  if (error) throw error;
  writeFileSync(join(directory, 'allocations.json'), JSON.stringify(allocation), { mode: 0o600 });
});
inspector.disconnect();
const result = { node: process.version, pid: process.pid, execArgv: process.execArgv,
  warmupBatches: 100, recordsPerBatch: 10000, explicitGcCalls: 1,
  baseline: 'after complete-batch warmup, getHeapStatistics warmup, producer, matcher and single explicit GC',
  diagnosticOnly: true, profilerInfluencesExecution: true, before, after, deltaBytes: after - before,
  limitBytes: 16384, remainingRecords: ring.size, accumulated: acc[0], pass: after - before < 16384 };
writeFileSync(join(directory, 'gate.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log('CONTROL_RING_PROFILE_DIAGNOSTIC ' + JSON.stringify(result));

// Diagnostic process never changes or reports the allocation gate's status.
