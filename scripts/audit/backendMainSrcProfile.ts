/** Synthetic SRC microbenchmark, separate from the real App integration proof. */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { BackendMainResampler as CurrentResampler } from '../../src/core/audio/backendMainResampler';
import { pathToFileURL } from 'node:url';
const BackendMainResampler: typeof CurrentResampler = process.env.R13_SRC_MODULE ? (await import(pathToFileURL(process.env.R13_SRC_MODULE).href)).BackendMainResampler : CurrentResampler;
const directory = process.env.R13_PROFILE_DIR ?? '/tmp/r13-src-profile';
if (existsSync(`${directory}/src.json`)) throw new Error('Fresh evidence directory required');
mkdirSync(directory, { recursive: true });
const stats = (values: number[]) => { const a = [...values].sort((x, y) => x - y); return { p50: a[Math.floor(a.length / 2)], p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) }; };
const rows: unknown[] = [];
for (const inputRate of [44100, 48000, 96000, 192000]) for (const sources of [4, 6, 8]) {
  const frames = inputRate / 10;
  const input = [Float32Array.from({ length: frames }, (_, i) => .2 * Math.sin(i * .11)), Float32Array.from({ length: frames }, (_, i) => .17 * Math.cos(i * .07))];
  const processors = Array.from({ length: sources }, () => new BackendMainResampler(inputRate, 96000));
  const run = () => { for (const p of processors) { if (inputRate !== 96000) p.process(input, frames); } };
  for (let i = 0; i < 5; i++) run();
  const wall: number[] = [], cpu: number[] = [], heapNet: number[] = [], externalNet: number[] = [];
  for (let i = 0; i < 20; i++) {
    const m = process.memoryUsage(), c = process.cpuUsage(), start = performance.now();
    run(); wall.push(performance.now() - start);
    const used = process.cpuUsage(c); cpu.push((used.user + used.system) / 1000);
    const after = process.memoryUsage(); heapNet.push(after.heapUsed - m.heapUsed); externalNet.push(after.external - m.external);
  }

  rows.push({ inputRate, outputRate: 96000, sources, actualPublisherBypass: inputRate === 96000,
    wallMs: stats(wall), cpuMs: stats(cpu), heapNetBytes: stats(heapNet), externalNetBytes: stats(externalNet),
    note: 'Heap/external deltas are NET retention including GC, not total allocations. Trig counters from separate untimed pass.',
    raw: { wall, cpu, heapNet, externalNet } });
}
// Count trig calls only after ALL timing cases: replacing Math intrinsics invalidates JIT assumptions.
for (const row of rows as any[]) {
  const input = [new Float32Array(row.inputRate / 10).fill(.2), new Float32Array(row.inputRate / 10).fill(.1)];
  const processors = Array.from({ length: row.sources }, () => new BackendMainResampler(row.inputRate, 96000));
  for (const p of processors) if (row.inputRate !== 96000) p.process(input, input[0].length);
  const sin = Math.sin, cos = Math.cos; let sinCalls = 0, cosCalls = 0;
  try {
    Math.sin = x => { sinCalls++; return sin(x); }; Math.cos = x => { cosCalls++; return cos(x); };
    for (const p of processors) if (row.inputRate !== 96000) p.process(input, input[0].length);
  } finally { Math.sin = sin; Math.cos = cos; }
  row.sinCallsPer100ms = sinCalls; row.cosCallsPer100ms = cosCalls;
}
writeFileSync(`${directory}/src.json`, JSON.stringify({ scope: 'Synthetic isolated SRC cost, not App/WAN/PA evidence', module: process.env.R13_SRC_MODULE ?? 'current', note: 'All timing cases finish before global Math instrumentation begins; trig counters from a separate pass.', rows }, null, 2));
console.log(JSON.stringify(rows.map((row: any) => ({ rate: row.inputRate, sources: row.sources, wall: row.wallMs, cpu: row.cpuMs, sin: row.sinCallsPer100ms }))));
