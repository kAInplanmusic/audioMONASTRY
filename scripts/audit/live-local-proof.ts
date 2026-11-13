/** Reproducible four-context CDP proof against an already running LOCAL app/SFU.
 * Costs are explicit simulations. No cloud resource or provider API is touched.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const origin = process.env.LIVE_PROOF_ORIGIN ?? 'http://127.0.0.1:8181';
if (new URL(origin).hostname !== '127.0.0.1' || new URL(origin).protocol !== 'http:') throw new Error('Proof is loopback-only');
const directory = resolve(process.env.LIVE_PROOF_OUTPUT ?? 'test-results/local-collector-' + Date.now());
mkdirSync(directory, { recursive: true, mode: 0o700 });
const health = await fetch(origin + '/api/health').then(r => r.json());
if (health.status !== 'ok' || !health.sfu?.ready) throw new Error('Actual local Origin and SFU worker/router health required');
const sessionId = 'four-context-proof-' + Date.now();
const token = process.env.STUDIO_ACCESS_TOKEN ?? 'ui-local-fixture';
await fetch(origin + '/api/session/reset', { method: 'POST', headers: { 'x-studio-token': token } }).then(r => { if (!r.ok) throw new Error('Local test reset failed'); });
let reads = 0;
const billing = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({
  sessionId, currency: 'EUR', totalEur: ++reads === 1 ? 49.9 : 50, observedAt: Date.now(), source: 'simulation', scopeComplete: true,
})); });
await new Promise<void>(r => billing.listen(0, '127.0.0.1', r));
const billingPort = (billing.address() as import('node:net').AddressInfo).port;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=9239'] });
let testSession: ReturnType<typeof spawn> | undefined;
try {
  for (let site = 0; site < 4; site++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'studio', value: token, domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    await page.goto(origin + '/?liveAudit=1');
    await page.getByRole('button', { name: /Studio betreten/ }).click();
    await page.locator('#ai-monk-dock').waitFor({ timeout: 30000 });
    await page.waitForFunction(() => !!(window as any).__audioMonastryLiveAudit);
  }
  // The guard may stop ONLY this owned process, not the browser or app service.
  testSession = spawn(process.execPath, ['-e', `const fs=require('node:fs'); process.on('SIGTERM',()=>{const p=process.env.LIVE_PROOF_OUTPUT; const text=fs.readFileSync(p+'/raw.ndjson','utf8');const rows=text.trim().split('\\n').map(JSON.parse);fs.writeFileSync(p+'/sigterm-proof.json',JSON.stringify({signal:'SIGTERM',lastDurableReason:rows.at(-1).reason,records:rows.length,at:Date.now()}));process.exit(0)}); console.log('ready');setInterval(()=>{},1000)`],
    { env: { ...process.env, LIVE_PROOF_OUTPUT: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>(r => testSession!.once('exit', r));
  await new Promise<void>(r => testSession!.stdout!.once('data', () => r()));
  const collector = spawn(process.execPath, ['--import', 'tsx', 'scripts/audit/live-browser.ts'], {
    env: { ...process.env, LIVE_AUDIT_CDP: 'http://127.0.0.1:9239', LIVE_AUDIT_ORIGIN: origin,
      LIVE_AUDIT_SFU_HEALTH: origin + '/api/health', LIVE_AUDIT_OUTPUT: directory, LIVE_AUDIT_SESSION_ID: sessionId,
      LIVE_AUDIT_MODE: 'local-staging', LIVE_AUDIT_SECONDS: '40', LIVE_AUDIT_SESSION_PID: String(testSession.pid),
      LIVE_AUDIT_COST_API: `http://127.0.0.1:${billingPort}/cost`, LIVE_AUDIT_COST_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; collector.stdout!.on('data', d => { log += d; }); collector.stderr!.on('data', d => { log += d; });
  const code = await new Promise<number | null>(r => collector.once('exit', r));
  writeFileSync(join(directory, 'collector.log'), log, { mode: 0o600 });
  if (code !== 0) throw new Error('Collector failed: ' + log);
  const childExit = await exited;
  const raw = readFileSync(join(directory, 'raw.ndjson'), 'utf8');
  const rows = raw.trim().split('\n').map(line => JSON.parse(line));
  const checkpoint = JSON.parse(readFileSync(join(directory, 'checkpoint.json'), 'utf8'));
  const signaled = JSON.parse(readFileSync(join(directory, 'sigterm-proof.json'), 'utf8'));
  const contexts = new Set(rows.filter(r => r.type === 'raw-snapshot').map(r => r.context));
  const users = new Set(rows.filter(r => r.type === 'raw-snapshot').map(r => r.userId));
  const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
  if (contexts.size !== 4 || users.size !== 4 || checkpoint.records !== rows.length || checkpoint.flushes < 4
    || signaled.lastDurableReason !== 'session-cap-50-eur' || childExit !== 0 || !summary.signalSent || summary.stopReason !== 'session-cap-50-eur') throw new Error('Collector durability/context/cap attestation failed');
  console.log(JSON.stringify({ mode: 'local-staging', costSource: 'simulation; NOT actual provider spend', contexts: contexts.size, users: users.size,
    rawSnapshots: rows.filter(r => r.type === 'raw-snapshot').length, observations: summary.summary, rawRecords: rows.length, checkpoint,
    stopReason: summary.stopReason, signalProof: signaled, rawSha256: createHash('sha256').update(raw).digest('hex'),
    audioE2E: 'nicht gemessen', handoverLive: 'nicht gemessen: no active output/transfer in this proof', directory }, null, 2));
} finally {
  if (testSession && testSession.exitCode === null) testSession.kill('SIGTERM');
  await browser.close(); await new Promise<void>(r => billing.close(() => r()));
}
