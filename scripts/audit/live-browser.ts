/** Opt-in CDP collector; production needs actual scoped spend, never tariff estimates. */
import { chromium } from 'playwright';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { browserCpuPercent, rtpValues, emptyLiveValues, summarizeLiveRun, type LiveRun } from '../../src/utils/liveSessionAudit';
import { COST_POLL_MS, RAW_FLUSH_MS, HandoverObserver, LiveGuard, type CostSample } from './live-guard';
import { LiveJournal } from './live-journal';

const endpoint = process.env.LIVE_AUDIT_CDP, origin = process.env.LIVE_AUDIT_ORIGIN;
const costApi = process.env.LIVE_AUDIT_COST_API, sfuHealthUrl = process.env.LIVE_AUDIT_SFU_HEALTH;
const output = process.env.LIVE_AUDIT_OUTPUT, sessionId = process.env.LIVE_AUDIT_SESSION_ID;
const simulation = process.env.LIVE_AUDIT_MODE === 'local-staging';
if (!endpoint || !origin || !output || !sessionId || !sfuHealthUrl) throw new Error('CDP, exact ORIGIN, OUTPUT, SESSION_ID and SFU_HEALTH required');
if (new URL(origin).origin !== origin) throw new Error('ORIGIN must be an exact origin');
const seconds = Number(process.env.LIVE_AUDIT_SECONDS ?? 25200);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 25200) throw new Error('duration must be 1..25200 seconds');
// The operator explicitly selects one task-owned test process. Verify UID/start
// identity on every signal, and refuse ancestors (including the caller/browser).
const pid = Number(process.env.LIVE_AUDIT_SESSION_PID);
if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('Explicit task-owned test session PID required');
const proc = (n: number) => readFileSync(`/proc/${n}/stat`, 'utf8').slice(readFileSync(`/proc/${n}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ');
let ancestor = process.ppid;
while (ancestor > 1) { if (ancestor === pid) throw new Error('Refusing to stop an ancestor process'); ancestor = Number(proc(ancestor)[1]); }
if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) throw new Error('Test session belongs to another user');
const processStart = proc(pid)[19];
const journal = new LiveJournal(resolve(output));
let stopping = false, stopReason: string | null = null, signalSent = false;
const guard = new LiveGuard({ sessionId, simulation, record: event => journal.record(event), flush: () => journal.flush(), stop: reason => {
  stopping = true; stopReason = reason;
  // PID reuse cannot terminate an unrelated session. Missing means already ended.
  try {
    if (proc(pid)[19] !== processStart || statSync(`/proc/${pid}`).uid !== process.getuid?.()) throw new Error('Test process identity changed');
    process.kill(pid, 'SIGTERM'); signalSent = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
} });
async function cost() {
  let sample: CostSample | null = null;
  if (costApi) {
    const url = new URL(costApi);
    if (url.protocol !== 'https:' && !(simulation && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Cost API requires HTTPS (loopback fixture only in local-staging)');
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: process.env.LIVE_AUDIT_COST_TOKEN ? { Authorization: `Bearer ${process.env.LIVE_AUDIT_COST_TOKEN}` } : {} });
      if (response.ok) sample = await response.json() as CostSample;
    } catch { /* Missing/timeout spend is not zero. */ }
  }
  await guard.cost(sample, Date.now());
}
async function health(url: string, sfu: boolean) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    const ok = response.ok && body.status === 'ok' && (!sfu || body.sfu?.ready === true);
    journal.record({ type: 'health', service: sfu ? 'sfu' : 'origin', status: response.status, ok, scope: sfu ? body.sfu?.scope : 'origin HTTP liveness' });
    return ok;
  } catch { journal.record({ type: 'health', service: sfu ? 'sfu' : 'origin', ok: false }); return false; }
}
const run: LiveRun = { schemaVersion: 1, mode: simulation ? 'local-staging' : 'live', seed: 0, hostname: hostname(),
  runId: sessionId, version: JSON.parse(readFileSync('package.json', 'utf8')).version,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), startedAt: new Date().toISOString(), observations: [], handovers: [] };
journal.record({ type: 'run-start', ...run, capEur: 50, costPollMs: COST_POLL_MS, flushMs: RAW_FLUSH_MS,
  glitchRate: null, glitchRateStatus: 'nicht gemessen: keine echten Blockzähler', simulationCosts: simulation });
const externalStop = () => { void guard.halt('operator-signal').catch(error => console.error('Guard persistence/stop failed', (error as Error).name)); };
process.on('SIGTERM', externalStop); process.on('SIGINT', externalStop);
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
const sessions: Awaited<ReturnType<import('playwright').BrowserContext['newCDPSession']>>[] = [];
let browserSession: Awaited<ReturnType<import('playwright').Browser['newBrowserCDPSession']>> | undefined;
let periodicFlush: ReturnType<typeof setInterval> | undefined;
let periodicCost: ReturnType<typeof setInterval> | undefined;
let costBusy = false;
try {
  journal.flush();
  periodicFlush = setInterval(() => { try { journal.flush(); } catch { void guard.halt('raw-persistence-failure'); } }, RAW_FLUSH_MS);
  // Startup costs checked before opening the test window, then every 30 seconds.
  await cost();
  if (guard.stopped) throw new Error('Actual session spend unavailable; B3 blocked');
  periodicCost = setInterval(() => {
    if (costBusy || stopping) return; costBusy = true;
    void cost().catch(() => guard.halt('cost-reader-failed')).finally(() => { costBusy = false; });
  }, COST_POLL_MS);
  const checks = await Promise.all([health(origin + '/api/health', false), health(sfuHealthUrl, true)]);
  if (!checks.every(Boolean)) { await guard.halt('origin-or-sfu-unhealthy'); throw new Error('Origin/SFU health failed'); }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
  const contexts = browser.contexts();
  const pages = contexts.flatMap(c => c.pages()).filter(p => { try { const url = new URL(p.url()); return url.origin === origin && url.searchParams.get('liveAudit') === '1'; } catch { return false; } });
  // A second CDP attachment may expose existing incognito targets through one
  // Playwright default context. Attest Chromium's actual context IDs instead.
  const contextIds: string[] = [];
  for (const page of pages) {
    const session = await page.context().newCDPSession(page); sessions.push(session);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    contextIds.push(targetInfo.browserContextId ?? 'default');
    await session.send('Performance.enable');
  }
  const observedContexts = new Set(contextIds);
  journal.record({ type: 'context-inventory', chromiumContexts: observedContexts.size, playwrightContexts: contexts.length, pages: pages.length });
  if (observedContexts.size !== 4) throw new Error(`Exactly four opted-in browser contexts required; found ${observedContexts.size} across ${pages.length} pages`);
  journal.record({ type: 'collector-attestation', contexts: observedContexts.size, pages: pages.length, mode: run.mode,
    locationScope: 'four simulated sites in one browser; no WAN geography proof' });
  browserSession = await browser.newBrowserCDPSession();
  const previous = new Map<string, Record<string, unknown>[]>(), cpuBefore = new Map<number, { task: number; at: number }>();
  const handovers = new Map<number, HandoverObserver>();
  let previousProcesses: { id: number; cpuTime: number }[] = [], previousProcessAt = 0;
  const started = performance.now();
  for (let tick = 0; tick <= seconds && !guard.stopped; tick++) {
    const processAt = performance.now();
    const processInfo = await browserSession.send('SystemInfo.getProcessInfo').catch(() => null);
    const fullCpu = pages.length === 1 && processInfo ? browserCpuPercent(processInfo.processInfo, previousProcesses, processAt - previousProcessAt) : null;
    previousProcesses = processInfo?.processInfo ?? []; previousProcessAt = processAt;
    for (let i = 0; i < pages.length && !guard.stopped; i++) {
      const snapshot = await Promise.race([pages[i].evaluate(async () => {
        const api = (window as any).__audioMonastryLiveAudit;
        if (!api) throw new Error('Opt-in audit API missing');
        return { ...(await api.snapshot()), pageAt: new Date().toISOString(), pageMonotonicMs: performance.now() };
      }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Snapshot timeout')), 3000); timer.unref(); })]);
      if (guard.stopped) break;
      journal.record({ type: 'raw-snapshot', context: contextIds[i], page: i, ...snapshot });
      const metrics = await sessions[i].send('Performance.getMetrics');
      if (guard.stopped) break;
      const task = metrics.metrics.find(m => m.name === 'TaskDuration')?.value;
      const now = performance.now(), prev = cpuBefore.get(i);
      const cpu = task !== undefined && prev && now > prev.at ? Math.max(0, (task - prev.task) * 100000 / (now - prev.at)) : null;
      if (task !== undefined) cpuBefore.set(i, { task, at: now });
      const observation = { userId: snapshot.userId, observerId: snapshot.userId,
        role: snapshot.mode === 'master-out' ? 'master-out' as const : 'member' as const, at: snapshot.pageAt,
        monotonicMs: snapshot.pageMonotonicMs, values: { ...emptyLiveValues(), cpuPercent: fullCpu, rendererMainThreadCpuPercent: cpu },
        methods: { cpuPercent: 'CDP all browser processes; only attributable with one page; otherwise null', rendererMainThreadCpuPercent: 'CDP TaskDuration/controller interval',
          audioInToPaOutMs: 'nicht gemessen: kalibrierter physischer Loopback fehlt', droppedBlocks: 'nicht gemessen: keine Blockzähler' } };
      run.observations.push(observation); journal.record({ type: 'observation', ...observation });
      let deliveredFromOwner = false;
      for (const peer of snapshot.peers) {
        const key = `${i}/${peer.peerId}`;
        const values = rtpValues(peer.rows, previous.get(key)); previous.set(key, peer.rows);
        if (!peer.userId || peer.error) continue;
        const observation = { userId: peer.userId, observerId: snapshot.userId,
          role: snapshot.mode === 'master-out' ? 'master-out' as const : 'member' as const, at: snapshot.pageAt,
          monotonicMs: snapshot.pageMonotonicMs, values, methods: { networkJitterMs: 'RFC3550 inbound RTP', networkRttMs: 'candidate-pair RTT',
            jitterBufferMs: 'delta(delay)/delta(emitted)', counters: 'per-SSRC interval deltas; first/reset window unavailable' } };
        run.observations.push(observation); journal.record({ type: 'observation', ...observation });
        await guard.rtp(key, now, values.concealedSamples, values.receivedSamples);
        if (guard.stopped) break;
        if (peer.userId === snapshot.mainOutOwnerId && (values.receivedSamples ?? 0) > 0) deliveredFromOwner = true;
      }
      if (!guard.stopped && snapshot.mode === 'master-out') {
        const observer = handovers.get(i) ?? new HandoverObserver(); handovers.set(i, observer);
        const transition = observer.observe(snapshot.mainOutOwnerId ?? '', deliveredFromOwner, now);
        if (transition) {
          journal.record({ type: 'handover-window', observerId: snapshot.userId, ...transition });
          if (transition.complete) run.handovers.push({ from: transition.from, to: transition.to, outageSeconds: transition.outageSeconds,
            method: 'receiver RTP delivery sampled ~1s; not physical PA outage' });
          await guard.handover(transition.outageSeconds);
        }
      }
    }
    if (tick < seconds && !stopping) await new Promise(r => setTimeout(r, Math.max(0, started + (tick + 1) * 1000 - performance.now())));
  }
  if (!stopping) await guard.halt('duration-complete');
} catch (error) {
  journal.record({ type: 'collector-error', error: error instanceof Error ? error.message : 'unknown' });
  await guard.halt('collector-error');
  process.exitCode = 1;
} finally {
  if (periodicCost) clearInterval(periodicCost); if (periodicFlush) clearInterval(periodicFlush);
  journal.record({ type: 'run-end', reason: stopReason, signalSent, observations: run.observations.length, handovers: run.handovers.length }); journal.flush();
  const summary = { ...run, observations: undefined, summary: summarizeLiveRun(run), stopReason, signalSent,
    glitchRateStatus: 'nicht gemessen ohne echte Blockzähler', rawFile: 'raw.ndjson' };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ runId: run.runId, stopReason, signalSent, observations: run.observations.length, rawDirectory: output }));
  for (const session of sessions) await session.detach().catch(() => {});
  await browserSession?.detach().catch(() => {});
  await browser?.close(); // CDP disconnect only; browser owned by the launcher.
  process.off('SIGTERM', externalStop); process.off('SIGINT', externalStop);
}
