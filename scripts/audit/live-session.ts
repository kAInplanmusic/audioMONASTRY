/** B1 reproducible two-user simulation. All generated values are labelled synthetic. */
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { emptyLiveValues, summarizeLiveRun, type LiveRun } from '../../src/utils/liveSessionAudit';

export function simulatedLiveRun(seed: number): LiveRun {
  let state = seed >>> 0;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  const startedAt = new Date().toISOString();
  const run: LiveRun = { schemaVersion: 1, mode: 'simulation', runId: `simulation-${seed}`,
    seed, hostname: hostname(), version: JSON.parse(readFileSync('package.json', 'utf8')).version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), startedAt,
    observations: [], handovers: [{ from: 'sim-user-1', to: 'sim-user-2', outageSeconds: 2, method: 'synthetic fixture, not an application measurement' }] };
  for (let n = 0; n < 100; n++) for (const userId of ['sim-user-1', 'sim-user-2']) {
    run.observations.push({ userId, observerId: userId, role: 'member',
      at: new Date(Date.parse(startedAt) + n * 1000).toISOString(), monotonicMs: n * 1000,
      values: { ...emptyLiveValues(), audioInToPaOutMs: 30 + random() * 20,
        jitterBufferMs: 10 + random() * 5, droppedBlocks: n === 50 ? 1 : 0,
        cpuPercent: 10 + random() * 15, networkRttMs: 20 + random() * 15,
        networkJitterMs: random() * 5, receivedSamples: 48000, renderedBlocks: 375, concealedSamples: n === 50 ? 128 : 0 },
      methods: { all: 'seeded synthetic values; no production evidence' } });
  }
  return run;
}
if (process.argv.includes('--simulate')) {
  const seed = Number(process.argv.find(a => a.startsWith('--seed='))?.split('=')[1] ?? 42);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be uint32');
  const run = simulatedLiveRun(seed);
  console.log(JSON.stringify({ ...run, summary: summarizeLiveRun(run) }, null, 2));
}
