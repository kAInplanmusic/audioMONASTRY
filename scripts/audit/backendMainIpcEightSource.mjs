import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// IPC workload only: eight 100 packet/s sources and ten mixed packets/s.
// This is not a DSP or mixer benchmark. All bytes are read by the receiver.
const INPUT_BYTES = 5760, OUTPUT_BYTES = 57600, SLOTS = 32;
const WARM_MS = 2000, MEASURE_MS = 10000, DURATION_MS = WARM_MS + MEASURE_MS;
const cpuTicks = () => {
  try {
    const s = readFileSync('/proc/thread-self/stat', 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch { return null; }
};
const delta = (a, b) => a == null || b == null ? null : b - a;
const touch = bytes => { let sum = 0; for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) >>> 0; return sum; };
const stats = values => {
  if (!values.length) return { count: 0, p50: null, p95: null, max: null };
  const a = values.slice().sort((x, y) => x - y);
  return { count: a.length, p50: a[Math.ceil(a.length * .5) - 1], p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) };
};

if (!isMainThread) {
  const { mode, controlBuffer, dataBuffer } = workerData;
  const control = new Int32Array(controlBuffer), shared = new Uint8Array(dataBuffer);
  let cpuStart = null, checksum = 0, touchMs = 0;
  const outputAck = [];
  parentPort.on('message', message => {
    if (message.type === 'measure') { cpuStart = cpuTicks(); return; }
    if (message.type === 'stop') {
      parentPort.postMessage({ type: 'stopped', cpuTicks: delta(cpuStart, cpuTicks()), checksum, outputAck, touchMs });
      return;
    }
    const { id, measured } = message;
    if (message.type === 'input') {
      const bytes = mode === 'transfer' ? new Uint8Array(message.buffer) : shared.subarray(id * OUTPUT_BYTES, id * OUTPUT_BYTES + INPUT_BYTES);
      if (mode === 'sab' && Atomics.load(control, id) !== 1) throw new Error('Input slot ownership violation');
      const received = performance.now(), t = performance.now();
      checksum = (checksum + touch(bytes)) >>> 0;
      if (measured) touchMs += performance.now() - t;
      if (mode === 'sab') Atomics.store(control, id, 2);
      const reply = { type: 'inputAck', id, received, measured, buffer: message.buffer };
      if (mode === 'transfer') parentPort.postMessage(reply, [message.buffer]); else parentPort.postMessage(reply);
    } else if (message.type === 'outputRequest') {
      const buffer = mode === 'transfer' ? new ArrayBuffer(OUTPUT_BYTES) : undefined;
      const bytes = mode === 'transfer' ? new Uint8Array(buffer) : shared.subarray(id * OUTPUT_BYTES, (id + 1) * OUTPUT_BYTES);
      if (mode === 'sab' && Atomics.load(control, id) !== 3) throw new Error('Output slot ownership violation');
      bytes.fill(message.value);
      if (mode === 'sab') Atomics.store(control, id, 4);
      const sent = performance.now();
      const reply = { type: 'output', id, sent, measured, buffer };
      if (mode === 'transfer') parentPort.postMessage(reply, [buffer]); else parentPort.postMessage(reply);
    } else if (message.type === 'outputAck') {
      if (measured) outputAck.push(performance.now() - message.sent);
      if (mode === 'sab' && Atomics.load(control, id) !== 5) throw new Error('Output acknowledgement ownership violation');
      parentPort.postMessage({ type: 'outputDone', id, buffer: message.buffer }, mode === 'transfer' ? [message.buffer] : []);
    }
  });
  parentPort.postMessage({ type: 'ready' });
} else {
  const dir = process.env.R15_IPC_DIR;
  if (!dir) throw new Error('Set R15_IPC_DIR to a new output directory');
  mkdirSync(dir, { recursive: false });
  let hz = null;
  try { hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()); } catch {}
  const ms = ticks => ticks == null || !hz ? null : ticks * 1000 / hz;
  async function run(mode) {
    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * SLOTS);
    const dataBuffer = new SharedArrayBuffer(OUTPUT_BYTES * SLOTS);
    const control = new Int32Array(controlBuffer), shared = new Uint8Array(dataBuffer);
    const worker = new Worker(new URL(import.meta.url), { workerData: { mode, controlBuffer, dataBuffer } });
    const free = Array.from({ length: SLOTS }, (_, i) => i);
    const inputBuffers = Array.from({ length: SLOTS }, () => new ArrayBuffer(INPUT_BYTES));
    const sent = new Float64Array(SLOTS), forwardInput = [], ackInput = [], forwardOutput = [];
    let checksum = 0, touchMs = 0, scheduledInput = 0, scheduledOutput = 0, missedInput = 0, missedOutput = 0;
    let issued = 0, completed = 0, sendingDone = false, stopping = false, mainStart = null, mainEnd = null, end;
    let readyResolve, doneResolve, rejectRun;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const done = new Promise((resolve, reject) => { doneResolve = resolve; rejectRun = reject; });
    worker.on('error', rejectRun);
    worker.on('exit', code => { if (code !== 0) rejectRun(new Error(`Worker exited ${code}`)); });
    function maybeStop() {
      if (sendingDone && issued === completed && !stopping) {
        stopping = true; end = performance.now(); mainEnd = cpuTicks(); worker.postMessage({ type: 'stop' });
      }
    }
    worker.on('message', message => {
      if (message.type === 'ready') return readyResolve();
      if (message.type === 'stopped') return doneResolve(message);
      const now = performance.now(), { id, measured } = message;
      if (message.type === 'inputAck') {
        if (measured) { forwardInput.push(message.received - sent[id]); ackInput.push(now - sent[id]); }
        if (mode === 'transfer') inputBuffers[id] = message.buffer; else Atomics.store(control, id, 0);
        free.push(id); completed++;
      } else if (message.type === 'output') {
        const bytes = mode === 'transfer' ? new Uint8Array(message.buffer) : shared.subarray(id * OUTPUT_BYTES, (id + 1) * OUTPUT_BYTES);
        if (mode === 'sab' && Atomics.load(control, id) !== 4) throw new Error('Output slot ownership violation');
        if (measured) forwardOutput.push(now - message.sent);
        const t = performance.now(); checksum = (checksum + touch(bytes)) >>> 0;
        if (measured) touchMs += performance.now() - t;
        if (mode === 'sab') Atomics.store(control, id, 5);
        const ack = { type: 'outputAck', id, sent: message.sent, measured, buffer: message.buffer };
        if (mode === 'transfer') worker.postMessage(ack, [message.buffer]); else worker.postMessage(ack);
      } else if (message.type === 'outputDone') {
        if (mode === 'sab') Atomics.store(control, id, 0);
        free.push(id); completed++;
      }
      maybeStop();
    });
    await ready;
    const start = performance.now();
    let measuring = false;
    function issue(type, sequence, measured) {
      const id = free.pop();
      if (id === undefined) return false;
      issued++;
      if (type === 'input') {
        const buffer = inputBuffers[id];
        const bytes = mode === 'transfer' ? new Uint8Array(buffer) : shared.subarray(id * OUTPUT_BYTES, id * OUTPUT_BYTES + INPUT_BYTES);
        bytes.fill(sequence & 255);
        sent[id] = performance.now();
        if (mode === 'sab') Atomics.store(control, id, 1);
        const msg = { type, id, measured, buffer: mode === 'transfer' ? buffer : undefined };
        if (mode === 'transfer') worker.postMessage(msg, [buffer]); else worker.postMessage(msg);
      } else {
        if (mode === 'sab') Atomics.store(control, id, 3);
        worker.postMessage({ type: 'outputRequest', id, measured, value: sequence & 255 });
      }
      return true;
    }
    await new Promise(resolve => {
      function pump() {
        const elapsed = performance.now() - start;
        if (!measuring && elapsed >= WARM_MS) { measuring = true; mainStart = cpuTicks(); worker.postMessage({ type: 'measure' }); }
        const targetInput = Math.min(9600, Math.floor(elapsed * 800 / 1000));
        const targetOutput = Math.min(120, Math.floor(elapsed * 10 / 1000));
        while (scheduledInput < targetInput) { scheduledInput++; if (!issue('input', scheduledInput, measuring)) missedInput++; }
        while (scheduledOutput < targetOutput) { scheduledOutput++; if (!issue('output', scheduledOutput, measuring)) missedOutput++; }
        if (elapsed >= DURATION_MS) { sendingDone = true; maybeStop(); resolve(); }
        else setTimeout(pump, 1);
      }
      pump();
    });
    const result = await done;
    await worker.terminate();
    return { mode, durationMs: end - start, warmupMs: WARM_MS, measurementMs: MEASURE_MS,
      scheduled: { input: scheduledInput, output: scheduledOutput }, missed: { input: missedInput, output: missedOutput }, issued, completed,
      latencyMs: { inputForward: stats(forwardInput), inputAcknowledgementRoundTrip: stats(ackInput), outputForward: stats(forwardOutput), outputAcknowledgementRoundTrip: stats(result.outputAck) },
      cpuMs: { mainOsThread: ms(delta(mainStart, mainEnd)), workerOsThread: ms(result.cpuTicks), clockTicksPerSecond: hz },
      payload: { inputBytes: INPUT_BYTES, outputBytes: OUTPUT_BYTES, inputPacketsPerSecond: 800, outputPacketsPerSecond: 10, slots: SLOTS,
        receiverChecksum: { worker: result.checksum, main: checksum }, measuredReceiverTouchMs: { main: touchMs, worker: result.touchMs },
        materializationCopiesPerPacket: 0, materializationCopyMs: 0, ownershipTransfersPerPacket: mode === 'transfer' ? 2 : 0,
        note: 'Receivers read the owned transfer buffer or the exclusively owned shared slot directly; no local materialization copy. Shared slot remains owned until acknowledgement.' } };
  }
  const results = [];
  for (const mode of ['transfer', 'sab']) results.push(await run(mode));
  const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    scope: 'IPC only: eight synthetic sources; no audio mixing or DSP', results };
  writeFileSync(join(dir, 'backend-main-ipc-eight-source.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
