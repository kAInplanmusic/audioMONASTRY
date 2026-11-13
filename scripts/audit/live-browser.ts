/** Attach to user-opened Chromium pages via CDP; never opens a production session. */
import { chromium } from 'playwright';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { browserCpuPercent, rtpValues, emptyLiveValues, summarizeLiveRun, type LiveRun } from '../../src/utils/liveSessionAudit';

const endpoint = process.env.LIVE_AUDIT_CDP;
const origin = process.env.LIVE_AUDIT_ORIGIN;
if (!endpoint || !origin) throw new Error('Set LIVE_AUDIT_CDP and exact LIVE_AUDIT_ORIGIN; no automatic session launch');
const seconds = Number(process.env.LIVE_AUDIT_SECONDS ?? 10);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('duration must be 1..3600 seconds');
const browser = await chromium.connectOverCDP(endpoint);
const pages = browser.contexts().flatMap(c => c.pages()).filter(p => {
  const url = new URL(p.url());
  return url.origin === origin && url.searchParams.get('liveAudit') === '1';
});
if (!pages.length) { await browser.close(); throw new Error('No explicitly opted-in pages at exact origin'); }
const run: LiveRun = { schemaVersion: 1, mode: 'live', seed: 0, hostname: hostname(),
  runId: `capture-${Date.now()}`, version: JSON.parse(readFileSync('package.json', 'utf8')).version,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(), observations: [], handovers: [] };
const previous = new Map<string, Record<string, unknown>[]>();
const cpuBefore = new Map<number, { task: number; at: number }>();
const sessions = await Promise.all(pages.map(p => p.context().newCDPSession(p)));
const browserSession = await browser.newBrowserCDPSession();
let previousProcesses: { id: number; cpuTime: number }[] = [], previousProcessAt = 0;
try {
  for (const session of sessions) await session.send('Performance.enable');
  const started = performance.now();
  for (let tick = 0; tick <= seconds; tick++) {
    const processAt = performance.now();
    const processInfo = await browserSession.send('SystemInfo.getProcessInfo').catch(() => null);
    const fullCpu = pages.length === 1 && processInfo
      ? browserCpuPercent(processInfo.processInfo, previousProcesses, processAt - previousProcessAt) : null;
    previousProcesses = processInfo?.processInfo ?? []; previousProcessAt = processAt;
    for (let i = 0; i < pages.length; i++) {
      const snapshot = await pages[i].evaluate(async () => {
        const api = (window as any).__audioMonastryLiveAudit;
        if (!api) throw new Error('Opt-in audit API missing: loaded build must include instrumentation');
        return { ...(await api.snapshot()), pageAt: new Date().toISOString(), pageMonotonicMs: performance.now() };
      });
      const metrics = await sessions[i].send('Performance.getMetrics');
      const task = metrics.metrics.find(m => m.name === 'TaskDuration')?.value;
      const now = performance.now(), prev = cpuBefore.get(i);
      const cpu = task !== undefined && prev && now > prev.at ? Math.max(0, (task - prev.task) * 100000 / (now - prev.at)) : null;
      if (task !== undefined) cpuBefore.set(i, { task, at: now });
      // CPU belongs to the observed browser, not the sender whose RTP arrives here.
      run.observations.push({ userId: snapshot.userId, observerId: snapshot.userId,
        role: snapshot.mode === 'master-out' ? 'master-out' : 'member', at: snapshot.pageAt,
        monotonicMs: snapshot.pageMonotonicMs, values: { ...emptyLiveValues(), cpuPercent: fullCpu, rendererMainThreadCpuPercent: cpu },
        methods: { cpuPercent: 'CDP SystemInfo cpuTime across browser processes/all threads; one opted-in page only; first/process-change/unsupported windows unavailable; multicore may exceed 100%',
          rendererMainThreadCpuPercent: 'CDP TaskDuration / controller monotonic wall interval; renderer main thread only',
          audioInToPaOutMs: 'unavailable: calibrated physical loopback required', droppedBlocks: 'unavailable: no block-drop counter' } });
      for (const peer of snapshot.peers) {
        const key = `${i}/${peer.peerId}`;
        const values = rtpValues(peer.rows, previous.get(key)); previous.set(key, peer.rows);
        if (!peer.userId || peer.error) continue;
        run.observations.push({ userId: peer.userId, observerId: snapshot.userId,
          role: snapshot.mode === 'master-out' ? 'master-out' : 'member', at: snapshot.pageAt,
          monotonicMs: snapshot.pageMonotonicMs, values,
          methods: { networkJitterMs: 'inbound RTP jitter (RFC3550), seconds converted to ms',
            networkRttMs: 'selected/nominated candidate-pair RTT', jitterBufferMs: 'interval delta(delay)/delta(emitted count)',
            counters: 'per-SSRC interval deltas; first/reset window unavailable', error: peer.error ?? '' } });
      }
    }
    if (tick < seconds) await new Promise(r => setTimeout(r, Math.max(0, started + (tick + 1) * 1000 - performance.now())));
  }
  console.log(JSON.stringify({ ...run, summary: summarizeLiveRun(run) }, null, 2));
} finally {
  for (const session of sessions) await session.detach();
  await browserSession.detach();
  // CDP attachment only: disconnect; do not close the user's browser.
  await browser.close();
}
