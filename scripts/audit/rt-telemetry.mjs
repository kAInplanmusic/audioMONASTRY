/** Separate opt-in network/holder CPU telemetry. Never runs from the DSP gate. */
import dgram from 'node:dgram';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { distribution, procStat, cpuPercent } from './rtTelemetry.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
if (args.includes('--help')) {
  console.log('node scripts/audit/rt-telemetry.mjs --duration 600 --out DIR --local-harness\n'
    + 'or --holder-pid PID --echo-host HOST --echo-port PORT (existing UDP echo endpoint)\n'
    + 'Linux /proc process CPU; abs successive UDP round-trip delay variation, not RTP/one-way jitter.');
  process.exit(0);
}
const duration = Number(option('--duration', '600'));
const intervalMs = Number(option('--interval-ms', '20'));
if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(intervalMs) || intervalMs < 1) throw new Error('Invalid duration/interval');
const out = resolve(option('--out', 'work/rt-telemetry'));
mkdirSync(out, { recursive: true });
const harness = args.includes('--local-harness');
let worker;
let socket;
let sender;
let sampler;
let failure;
let stoppingWorker = false;
let workerOutput = '';
let pid = Number(option('--holder-pid', '0'));
let host = option('--echo-host', '');
let port = Number(option('--echo-port', '0'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
try {
  if (harness) {
    worker = spawn(process.execPath, ['--import', 'tsx', 'scripts/audit/rt-holder-harness.ts'], { stdio: ['ignore', 'pipe', 'inherit'] });
    worker.on('exit', (code, signal) => {
      if (!stoppingWorker) failure = new Error(`Harness exited unexpectedly: code=${code} signal=${signal}`);
    });
    const ready = await Promise.race([
      new Promise((resolveReady, reject) => {
        worker.stdout.on('data', (chunk) => {
          workerOutput += chunk;
          const line = workerOutput.split('\n')[0];
          if (workerOutput.includes('\n')) {
            try { resolveReady(JSON.parse(line)); } catch (error) { reject(error); }
          }
        });
        worker.once('exit', (code) => reject(new Error(`Harness exited before ready: ${code}`)));
      }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Harness startup timeout')), 15000); timer.unref(); }),
    ]);
    pid = ready.pid; host = '127.0.0.1'; port = ready.port;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Supply --local-harness or holder PID and existing UDP echo endpoint');
  const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  if (!Number.isFinite(hz) || hz <= 0) throw new Error('Invalid CLK_TCK');
  const readCpu = () => procStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  socket = dgram.createSocket('udp4');
  await new Promise((ready, reject) => { socket.once('error', reject); socket.bind(0, '0.0.0.0', ready); });
  await new Promise((ready, reject) => socket.connect(port, host, (error) => error ? reject(error) : ready()));
  let sequence = 0;
  let previousRtt = null;
  let previousSequence = -1;
  let receiveCount = 0;
  let duplicates = 0;
  const pending = new Map();
  const received = new Set();
  const packets = [];
  const cpu = [];
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let beforeCpu = readCpu();
  let beforeAt = start;
  socket.on('error', (error) => { failure = error; });
  socket.on('message', (packet) => {
    if (packet.length !== 12) return;
    const seq = packet.readUInt32BE(0);
    const sent = pending.get(seq);
    if (sent === undefined || packet.readDoubleBE(4) !== sent) { duplicates++; return; }
    pending.delete(seq); received.add(seq); receiveCount++;
    const now = performance.now();
    const rtt = now - sent;
    // Reordering is recorded, not silently treated as sequential delay variation.
    const variation = previousRtt !== null && seq === previousSequence + 1 ? Math.abs(rtt - previousRtt) : null;
    packets.push({ seq, elapsedMs: now - start, sentMs: sent - start, rttMs: rtt, jitterMs: variation });
    previousRtt = rtt; previousSequence = seq;
  });
  sender = setInterval(() => {
    const sent = performance.now();
    const packet = Buffer.alloc(12);
    packet.writeUInt32BE(sequence, 0); packet.writeDoubleBE(sent, 4);
    pending.set(sequence++, sent);
    socket.send(packet, (error) => { if (error) failure = error; });
  }, intervalMs);
  const sampleCpu = () => {
    const now = performance.now();
    const after = readCpu();
    cpu.push({ elapsedMs: now - start, intervalMs: now - beforeAt, cpuPercent: cpuPercent(beforeCpu, after, now - beforeAt, hz), ticks: after.ticks });
    beforeCpu = after; beforeAt = now;
  };
  sampler = setInterval(() => { try { sampleCpu(); } catch (error) { failure = error; } }, 1000);
  await new Promise((done) => setTimeout(done, duration * 1000));
  clearInterval(sender); clearInterval(sampler);
  try { sampleCpu(); } catch (error) { failure = error; }
  const end = performance.now();
  await new Promise((done) => setTimeout(done, 200));
  socket.close();
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    stoppingWorker = true;
    const exited = once(worker, 'exit'); worker.kill('SIGTERM'); await exited;
  }
  const summary = {
    schema: 1, startedAt, endedAt: new Date().toISOString(), host: hostname(), commit, dirty,
    node: process.version, platform: process.platform, holderPid: pid,
    mode: harness ? 'local-V2-fixture-NOT-live-browser-holder' : 'existing-holder-and-UDP-echo',
    endpoint: { host, port }, requestedSeconds: duration, measuredSeconds: (end - start) / 1000,
    intervalMs, cpuHz: hz, sent: sequence, received: receiveCount, lost: sequence - received.size, duplicates,
    jitterDefinition: 'abs(RTT[n] - RTT[n-1]) for consecutive in-order echoed UDP packets; ms; no trimming',
    jitterMs: distribution(packets.flatMap((p) => p.jitterMs === null ? [] : [p.jitterMs])),
    rttMs: distribution(packets.map((p) => p.rttMs)),
    cpuPercent: distribution(cpu.map((p) => p.cpuPercent)),
    cpuTimeWeightedMeanPercent: cpu.reduce((sum, p) => sum + p.cpuPercent * p.intervalMs, 0) / (end - start),
    cpuDefinition: 'Linux /proc PID user+system ticks / elapsed monotonic seconds; one core=100%; excludes child processes',
    harnessOutput: workerOutput, error: failure ? String(failure) : null,
  };
  writeFileSync(resolve(out, 'packets.csv'), 'seq,elapsedMs,sentMs,rttMs,jitterMs\n' + packets.map((p) => [p.seq, p.elapsedMs, p.sentMs, p.rttMs, p.jitterMs ?? ''].join(',')).join('\n') + '\n');
  writeFileSync(resolve(out, 'cpu.csv'), 'elapsedMs,intervalMs,cpuPercent,ticks\n' + cpu.map((p) => [p.elapsedMs, p.intervalMs, p.cpuPercent, p.ticks].join(',')).join('\n') + '\n');
  writeFileSync(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (failure || !receiveCount || !summary.jitterMs.count) process.exitCode = 1;
} finally {
  clearInterval(sender); clearInterval(sampler);
  try { socket?.close(); } catch { /* Already closed or never bound. */ }
  if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
}
