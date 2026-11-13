/** 30-minute local preflight. The production guard stops the real load child. */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { attestRtpContexts } from './live-rtp-attestation';
const directory = resolve(process.env.LIVE_PREFLIGHT_OUTPUT ?? 'test-results/live-preflight-' + Date.now());
mkdirSync(directory, { recursive: true, mode: 0o700 });
const sessionId = 'b3-local-preflight-' + Date.now();
const logFd = openSync(join(directory, 'load.log'), 'ax', 0o600);
const load = spawn(process.execPath, ['--import', 'tsx', 'scripts/audit/live-preflight-load.ts'], {
  env: { ...process.env, LIVE_PREFLIGHT_OUTPUT: directory }, stdio: ['ignore', logFd, logFd] });
closeSync(logFd);
let collector: ReturnType<typeof spawn> | undefined;
const loadEnded = new Promise<number | null>(r => load.once('exit', r));
try {
  const readyPath = join(directory, 'ready.json');
  for (let i = 0; !existsSync(readyPath) && i < 600; i++) {
    if (load.exitCode !== null) throw new Error('Load startup failed; see load.log');
    await new Promise(r => setTimeout(r, 100));
  }
  if (!existsSync(readyPath)) throw new Error('Load readiness timeout');
  const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
  const fd = openSync(join(directory, 'collector.log'), 'ax', 0o600);
  collector = spawn(process.execPath, ['--import', 'tsx', 'scripts/audit/live-browser.ts'], {
    env: { ...process.env, LIVE_AUDIT_CDP: ready.cdp, LIVE_AUDIT_ORIGIN: ready.origin,
      LIVE_AUDIT_ADDITIONAL_ORIGINS: ready.origins.join(','), LIVE_AUDIT_SFU_HEALTH: ready.origin + '/api/health',
      LIVE_AUDIT_OUTPUT: directory, LIVE_AUDIT_SESSION_ID: sessionId, LIVE_AUDIT_SESSION_PID: String(load.pid),
      LIVE_AUDIT_SECONDS: '1800', LIVE_AUDIT_COST_API: process.env.LIVE_AUDIT_COST_API ?? '', LIVE_AUDIT_COST_TOKEN: process.env.LIVE_AUDIT_COST_TOKEN ?? '',
      LIVE_AUDIT_RATE_BOUND: resolve('deploy/live-audit-cost-bound.json') }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const code = await new Promise<number | null>(r => collector!.once('exit', r));
  if (load.exitCode === null) load.kill('SIGTERM'); // Also stop real load if collector fails before its guard is ready.
  const loadCode = await loadEnded;
  const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
  const rows = readFileSync(join(directory, 'raw.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const memory = readFileSync(join(directory, 'memory.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const delivered = rows.filter(r => r.type === 'observation' && r.role === 'master-out' && r.values.receivedSamples !== null);
  const received = delivered.reduce((n,r)=>n+r.values.receivedSamples,0), concealed = delivered.reduce((n,r)=>n+r.values.concealedSamples,0);
  const report = { sessionId, code, loadCode, ...attestRtpContexts(rows), handovers: summary.handovers,
    receivedSamples: received, concealedSamples: concealed, concealmentRatio: received > 0 ? concealed / received : null,
    glitchRate: null, glitchRateStatus: 'nicht gemessen: keine Blockzähler', stopReason: summary.stopReason,
    rateBounds: rows.filter(r=>r.type==='cost-upper-bound'), memory,
    scope: '30min local preflight on 127.0.0.2/3/4/5, P2P Main-Out RTP via local TCP TURN; not WAN/SFU media/physical PA latency', directory };
  writeFileSync(join(directory,'preflight-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report,null,2));
  if (code !== 0 || loadCode !== 0 || summary.stopReason !== 'duration-complete') process.exitCode = 1;
} finally {
  if (collector && collector.exitCode === null) collector.kill('SIGTERM');
  if (load.exitCode === null) load.kill('SIGTERM');
}
