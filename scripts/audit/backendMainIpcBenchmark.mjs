import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Each round trip moves one 10 ms stereo 96 kHz PCM24 packet in each direction.
const BYTES = 5760, SLOTS = 32;
const cpuTicks = () => {
  try {
    const stat = readFileSync('/proc/thread-self/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]); // utime + stime
  } catch { return null; }
};

if (!isMainThread) {
  const startCpu = cpuTicks();
  const usedCpu = () => { const end = cpuTicks(); return end == null || startCpu == null ? null : end - startCpu; };
  if (workerData.mode === 'transfer') {
    parentPort.on('message', ({ id, buffer, stop }) => {
      if (stop) return parentPort.postMessage({ stopped: true, cpuTicks: usedCpu() });
      const data = new Uint8Array(buffer);
      data[0] ^= 1; // Touch the returned payload.
      parentPort.postMessage({ id, buffer }, [buffer]);
    });
    parentPort.postMessage({ ready: true });
  } else {
    const control = new Int32Array(workerData.control);
    const shared = new Uint8Array(workerData.data);
    const scratch = new Uint8Array(BYTES);
    parentPort.postMessage({ ready: true });
    while (!Atomics.load(control, 0)) {
      const signal = Atomics.load(control, 1);
      for (let id = 0; id < SLOTS; id++) {
        if (Atomics.load(control, id + 2) !== 1) continue;
        const slot = shared.subarray(id * BYTES, (id + 1) * BYTES);
        scratch.set(slot); // shared slot -> worker local buffer
        scratch[0] ^= 1;
        slot.set(scratch); // worker local buffer -> shared slot
        Atomics.store(control, id + 2, 2);
        parentPort.postMessage({ id });
      }
      if (!Atomics.load(control, 0)) Atomics.wait(control, 1, signal, 100);
    }
    parentPort.postMessage({ stopped: true, cpuTicks: usedCpu() });
  }
} else {
  const dir = process.env.R14_BENCH_DIR;
  if (!dir) throw new Error('Set R14_BENCH_DIR to a new output directory');
  mkdirSync(dir, { recursive: false });
  let hz = null;
  try { hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()); } catch {}
  const ms = ticks => ticks == null || !hz ? null : ticks * 1000 / hz;
  const stats = values => {
    if (!values.length) return { count: 0, p50: null, p95: null, max: null };
    const a = values.slice().sort((x, y) => x - y);
    return { count: a.length, p50: a[Math.ceil(a.length * .5) - 1], p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) };
  };
  async function run(mode, load) {
    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (SLOTS + 2));
    const dataBuffer = new SharedArrayBuffer(BYTES * SLOTS);
    const control = new Int32Array(controlBuffer), shared = new Uint8Array(dataBuffer);
    const worker = new Worker(new URL(import.meta.url), { workerData: { mode, control: controlBuffer, data: dataBuffer } });
    const free = Array.from({ length: SLOTS }, (_, id) => id);
    const buffers = Array.from({ length: SLOTS }, () => new ArrayBuffer(BYTES));
    const sent = new Float64Array(SLOTS), latencies = [];
    let completed = 0, issued = 0, missed = 0, doneSending = false, workerCpu = null;
    let resolveReady, resolveDone, rejectRun;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectRun = reject; });
    worker.on('error', rejectRun);
    worker.on('exit', code => { if (code !== 0) rejectRun(new Error(`Worker exited ${code}`)); });
    let start, end, mainCpuStart;
    function send() {
      const id = free.pop();
      if (id === undefined) return false;
      sent[id] = performance.now();
      issued++;
      if (mode === 'transfer') {
        const buffer = buffers[id];
        new Uint8Array(buffer)[1] = issued & 255;
        worker.postMessage({ id, buffer }, [buffer]);
      } else {
        const local = new Uint8Array(buffers[id]);
        local[1] = issued & 255;
        shared.set(local, id * BYTES); // main local buffer -> shared slot
        Atomics.store(control, id + 2, 1);
        Atomics.add(control, 1, 1);
        Atomics.notify(control, 1);
      }
      return true;
    }
    function finishIfDone() {
      if (!doneSending || completed !== issued) return;
      end = performance.now();
      const mainCpu = cpuTicks();
      if (mode === 'transfer') worker.postMessage({ stop: true });
      else { Atomics.store(control, 0, 1); Atomics.add(control, 1, 1); Atomics.notify(control, 1); }
      return mainCpu == null || mainCpuStart == null ? null : mainCpu - mainCpuStart;
    }
    let mainTicks;
    worker.on('message', message => {
      if (message.ready) return resolveReady();
      if (message.stopped) { workerCpu = message.cpuTicks; return resolveDone(); }
      const { id, buffer } = message;
      if (mode === 'transfer') buffers[id] = buffer;
      else {
        new Uint8Array(buffers[id]).set(shared.subarray(id * BYTES, (id + 1) * BYTES)); // shared slot -> main local buffer
        Atomics.store(control, id + 2, 0);
      }
      latencies.push(performance.now() - sent[id]);
      completed++;
      free.push(id);
      if (load === 'burst' && issued < 10000) send();
      if (load === 'burst' && issued === 10000) doneSending = true;
      if (doneSending && completed === issued) mainTicks = finishIfDone();
    });
    await ready;
    mainCpuStart = cpuTicks();
    start = performance.now();
    if (load === 'burst') {
      while (free.length && issued < 10000) send();
    } else {
      const duration = 3000, interval = 1000 / 1600;
      let scheduled = 0;
      await new Promise(resolve => {
        function pump() {
          const elapsed = performance.now() - start;
          const target = Math.min(Math.floor(elapsed / interval), duration / interval);
          while (scheduled < target) { if (!send()) missed++; scheduled++; }
          if (scheduled >= duration / interval) { doneSending = true; resolve(); }
          else setTimeout(pump, Math.max(0, Math.min(2, (scheduled + 1) * interval - elapsed)));
        }
        pump();
      });
      if (completed === issued) mainTicks = finishIfDone();
    }
    await done;
    await worker.terminate();
    const elapsedMs = end - start;
    return { mode, load, packetBytes: BYTES, slots: SLOTS, issued, completed, missedScheduled: missed,
      elapsedMs, roundTripsPerSecond: completed * 1000 / elapsedMs, oneWayPacketsPerSecond: completed * 2000 / elapsedMs,
      latencyMs: { coldFirst100: stats(latencies.slice(0, 100)), warmRemainder: stats(latencies.slice(100)) },
      cpuMs: { mainOsThread: ms(mainTicks), workerOsThread: ms(workerCpu), clockTicksPerSecond: hz },
      payloadCopiesPerRoundTrip: mode === 'sab' ? { mainToSlot: 1, slotToWorker: 1, workerToSlot: 1, slotToMain: 1 } : { structuredClonePayloadCopies: 0, ownershipTransfers: 2 } };
  }
  const results = [];
  for (const mode of ['transfer', 'sab']) for (const load of ['paced1600', 'burst']) results.push(await run(mode, load));
  const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, results };
  writeFileSync(join(dir, 'backend-main-ipc.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
