import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { BackendMainProcessors, type ProcessorSnapshot, type ProcessorPlugin } from '../../server/backendMainProcessors';
import { ParametricEqNode, DspFilterNode, EffectNode } from '../../src/core/audio/nodes/processingNodes';

// Synthetic kernel microbenchmark, not an App, end-to-end, or real-time gate proof.
const directory = process.env.R13_PROFILE_DIR;
if (!directory || existsSync(directory)) throw new Error('R13_PROFILE_DIR must name a fresh, nonexistent directory');
const integer = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};
const warm = integer('R13_WARM_BLOCKS', 20), measured = integer('R13_MEASURE_BLOCKS', 50);
mkdirSync(directory, { recursive: true });
const rate = 96000, frames = 9600;
const ids = ['drop', 'song', 'drumsampler', 'syntisampler', 'instru', 'voice', 'sound', 'stem'];
const source = (count: number) => new Map(ids.slice(0, count).map((id, index) => {
  const samples = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    samples[2 * i] = 0.1 * Math.sin(2 * Math.PI * (220 + index * 37) * i / rate);
    samples[2 * i + 1] = 0.1 * Math.sin(2 * Math.PI * (330 + index * 29) * i / rate + 0.2);
  }
  return [id, samples] as const;
}));
const params: Record<ProcessorPlugin, Record<string, unknown>> = {
  eq: { low: 18, mid: -12, high: 12 }, dsp: { cutoff: 250, resonance: 0.8, depth: 1, drive: 0.8, oversampling: 1 },
  effect: { wet: 1, feedback: 0.6, rate: 1, depth: 0.8 }, spatial: { pan: 0.8, width: 0.3 },
  mixer: { sources: Object.fromEntries(ids.map(id => [id, { gain: 0.4, pan: 0, sendEffect: 1, sendSpatial: 1 }])) }, master: { gain: 0.4 },
};
const plugins = Object.keys(params) as ProcessorPlugin[];
const snapshot = (active: ProcessorPlugin[]): ProcessorSnapshot => Object.fromEntries(active.map(id => [id, { active: true, parameters: params[id], epoch: 1 }]));
const cases = [4, 6, 8].flatMap(count => [
  { name: `baseline-${count}`, count, active: [] as ProcessorPlugin[] },
  ...plugins.map(id => ({ name: `${id}-${count}`, count, active: (id === 'effect' || id === 'spatial' ? ['mixer', id] : [id]) as ProcessorPlugin[] })),
  { name: `full-${count}`, count, active: plugins },
]);
const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.ceil(q * sorted.length) - 1];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1], raw: values };
};
const prepare = (c: typeof cases[number]) => {
  const processor = new BackendMainProcessors(rate), sources = source(c.count), config = snapshot(c.active);
  for (let i = 0; i < warm; i++) processor.process(sources, config);
  return { processor, sources, config };
};
const timing = cases.map(c => {
  const { processor, sources, config } = prepare(c), wall: number[] = [], cpu: number[] = [];
  const heapNet: number[] = [], externalNet: number[] = [];
  for (let i = 0; i < measured; i++) {
    const before = process.memoryUsage();
    const cpuStart = process.cpuUsage(), start = process.hrtime.bigint();
    processor.process(sources, config);
    const end = process.hrtime.bigint(), delta = process.cpuUsage(cpuStart);
    const after = process.memoryUsage();
    wall.push(Number(end - start) / 1e6); cpu.push((delta.user + delta.system) / 1000);
    heapNet.push(after.heapUsed - before.heapUsed); externalNet.push(after.external - before.external);
  }
  return { ...c, wallMs: quantiles(wall), processCpuMs: quantiles(cpu), memoryNetBytesPerBlock: { heapUsed: quantiles(heapNet), external: quantiles(externalNet) } };
});
const allocations = cases.map(c => {
  const { processor, sources, config } = prepare(c);
  const names = ['Float32Array', 'Float64Array', 'Int32Array'] as const;
  const counts: Record<string, { count: number; bytes: number }> = {};
  const originals = names.map(name => globalThis[name]);
  try {
    names.forEach((name, i) => {
      counts[name] = { count: 0, bytes: 0 };
      (globalThis as any)[name] = new Proxy(originals[i], { construct(target, args, newTarget) {
        const result = Reflect.construct(target, args, newTarget);
        // Views of an existing backing store allocate no new typed-array backing bytes.
        if (!(args[0] instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && args[0] instanceof SharedArrayBuffer)) {
          counts[name].count++; counts[name].bytes += result.byteLength;
        }
        return result;
      } });
    });
    processor.process(sources, config);
  } finally { names.forEach((name, i) => { (globalThis as any)[name] = originals[i]; }); }
  return { name: c.name, typedBackingAllocations: counts };
});
const attribution = cases.map(c => {
  const { processor, sources, config } = prepare(c);
  const nodes = [['eq', ParametricEqNode], ['dsp', DspFilterNode], ['effect', EffectNode]] as const;
  const values: Record<string, { calls: number; ms: number }> = Object.fromEntries(nodes.map(([name]) => [name, { calls: 0, ms: 0 }]));
  const originals = nodes.map(([, node]) => node.prototype.process);
  let totalMs = 0;
  try {
    nodes.forEach(([name, node], i) => { (node.prototype as any).process = function (...args: unknown[]) {
      const start = process.hrtime.bigint();
      try { return Reflect.apply(originals[i], this, args); }
      finally { values[name].calls++; values[name].ms += Number(process.hrtime.bigint() - start) / 1e6; }
    }; });
    const start = process.hrtime.bigint(); processor.process(sources, config); totalMs = Number(process.hrtime.bigint() - start) / 1e6;
  } finally { nodes.forEach(([, node], i) => { (node.prototype as any).process = originals[i]; }); }
  return { name: c.name, totalMs, nodes: values, otherInstrumentedMs: totalMs - Object.values(values).reduce((sum, value) => sum + value.ms, 0) };
});
const session = new Session(); session.connect();
const post = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => session.post(method as any, params as any, (error, result) => error ? reject(error) : resolve(result)));
const heapSamples: unknown[] = [];
try {
  const full = prepare(cases.find(c => c.name === 'full-8')!);
  await post('Profiler.enable'); await post('Profiler.start');
  for (let i = 0; i < measured; i++) full.processor.process(full.sources, full.config);
  const profile = await post('Profiler.stop');
  writeFileSync(`${directory}/full-8.cpuprofile`, JSON.stringify(profile.profile), { flag: 'wx' });
  await post('HeapProfiler.enable');
  for (const c of cases.filter(c => c.count === 8 && c.name !== 'baseline-8')) {
    const run = prepare(c);
    await post('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < 20; i++) run.processor.process(run.sources, run.config);
    const sampled = await post('HeapProfiler.stopSampling');
    const filename = `${c.name}.heapprofile`;
    writeFileSync(`${directory}/${filename}`, JSON.stringify(sampled.profile), { flag: 'wx' });
    const sum = (node: any): number => node.selfSize + (node.children ?? []).reduce((total: number, child: any) => total + sum(child), 0);
    const estimatedBytes = sum(sampled.profile.head);
    heapSamples.push({ name: c.name, blocks: 20, estimatedBytes, estimatedBytesPerBlock: estimatedBytes / 20, profile: filename });
  }
} finally { session.disconnect(); }
const report = {
  scope: 'Synthetic fixed normalized stereo sine input through BackendMainProcessors only; not App or real-time proof.',
  sampleRate: rate, framesPerBlock: frames, blockDurationMs: 100, sourceIds: ids, warmBlocks: warm, measuredBlocks: measured,
  node: process.version, platform: process.platform, arch: process.arch, parameters: params,
  notes: [
    'Effect and spatial cases include active mixer gain and both sends; compare mixer-8 to assess additional return cost.',
    'CPU is process user plus system time per block; wall time uses hrtime. Percentiles use nearest rank and preserve raw samples.',
    'Memory deltas are per-block net heapUsed/external changes, not allocation totals and may reflect GC; memoryUsage calls are outside wall timing.',
    'Heap samples are statistical V8 sampled heap allocation estimates over 20 separate warmed blocks, including sampled objects collected by major/minor GC; external typed-array backing stores are excluded.',
    'Typed backing allocation counts cover intercepted Float32Array, Float64Array and Int32Array constructor calls during one separate warmed block; exclude object allocations, other constructors, and views of existing buffers.',
    'Kernel attribution wraps process methods for one separate warmed block; other time includes wrapper and measurement overhead, all other processing, and report generation.',
    'CPU profile is a separate full-8 pass; profiling overhead means it is not a real-time gate.'
  ], timing, allocations, attribution, heapSamples, cpuProfile: 'full-8.cpuprofile',
};
writeFileSync(`${directory}/result.json`, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ directory, cases: cases.map(c => c.name), result: 'result.json', cpuProfile: 'full-8.cpuprofile' }));
