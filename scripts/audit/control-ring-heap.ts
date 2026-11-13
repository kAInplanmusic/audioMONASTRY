/** Round6 diagnosis only. Never mutates DSP or the original 16KiB assertion.
 * One bounded workload per invocation; snapshots/profiling alter runtime state.
 */
import { Session } from 'node:inspector';
import { getHeapStatistics, writeHeapSnapshot } from 'node:v8';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { ControlRing, CONTROL_FIELD, CONTROL_OP, CONTROL_RECORD_WORDS } from '../../src/core/audio/live/controlRing';
const directory = resolve(process.env.RING_DIAG_OUTPUT ?? 'test-results/control-ring-heap-' + Date.now());
mkdirSync(directory, { recursive: true, mode: 0o700 });
const snapshots = process.argv.includes('--snapshots');
const ring = ControlRing.create(10001), rec = new Float64Array(CONTROL_RECORD_WORDS), acc = new Float64Array(1);
const consumeAll = () => { while (ring.peek(rec)) { acc[0] += rec[CONTROL_FIELD.A]; ring.advance(); } };
const fill = (n: number) => { for (let i = 0; i < n; i++) ring.push(CONTROL_OP.GAIN_DB, i & 7, i, i); };
const gcEvents: { startTime: number; duration: number; detail: unknown }[] = [];
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gcEvents.push({ startTime: e.startTime, duration: e.duration, detail: (e as any).detail }); });
observer.observe({ entryTypes: ['gc'] });
for (let r = 0; r < 50; r++) { fill(1000); consumeAll(); getHeapStatistics(); }
fill(10000);
if (ring.size !== 10000) throw new Error('Producer fixture incomplete');
// Keep the exact production instance/views reachable across both snapshots.
(globalThis as any).__ringDiagnosis = { ring, rec, acc };
const inspector = new Session();
const post = (name: string, params: object = {}) => new Promise<any>((resolve, reject) => inspector.post(name as any, params, (error, value) => error ? reject(error) : resolve(value)));
if (snapshots) {
  writeHeapSnapshot(join(directory, 'before.heapsnapshot'));
  inspector.connect(); await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 1, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
}
const beforeAt = performance.now();
const before = getHeapStatistics().used_heap_size;
consumeAll();
const after = getHeapStatistics().used_heap_size;
const afterAt = performance.now();
// No GC, await, logging or assertion between the two heap readings.
const result = { node: process.version, execArgv: process.execArgv, pid: process.pid, mode: snapshots ? 'snapshot-and-allocation-profile' : 'raw-workload',
  previousTests: [], warmup: { rounds: 50, recordsPerRound: 1000 }, measuredRecords: 10000,
  baseline: 'after producer fill and warmup; no Vitest matcher; snapshot/profile setup before baseline only in snapshot mode',
  beforeAt, afterAt, before, after, deltaBytes: after - before, originalLimitBytes: 16384,
  originalLimitExceededInThisDiagnostic: after - before >= 16384, remainingRecords: ring.size, accumulated: acc[0],
  explicitGcCalled: false, heapSnapshotsForceGc: snapshots, snapshotResultsNotEquivalentToOriginalTest: snapshots };
if (snapshots) {
  const allocation = await post('HeapProfiler.stopSampling');
  writeFileSync(join(directory, 'allocations.json'), JSON.stringify(allocation, null, 2), { mode: 0o600 });
  inspector.disconnect(); writeHeapSnapshot(join(directory, 'after.heapsnapshot'));
}
await new Promise(r => setImmediate(r)); observer.disconnect();
const report = { ...result, gcEvents };
writeFileSync(join(directory, 'measurements.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
