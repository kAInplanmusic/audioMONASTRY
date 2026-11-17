// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetFleetWakeState, fleetStatus, sessionWakeRoles, sleepFleet, wakeFleet } from '../src/core/ai/orchestrator/fleetWake';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';
import { resetBudgetLimits, setBudgetLimits } from '../src/config/aiInfrastructure';
import { POD_ROLE_IDS } from '../src/core/ai/orchestrator/podRouting';
import { onSessionStartPods } from '../src/core/ai/orchestrator/podStartTriggers';
import { setFleetAutostopHooks } from '../src/core/ai/orchestrator/fleetAutostop';

const existingRoles = ['brain', 'ears', 'voiceGen', 'music', 'orchestrator'];
const calls: Array<{ url: string; method: string }> = [];
const keys = ['AI_POD_TOKEN', 'AI_FLEET_WAKE', 'AI_FLEET_SLEEP', 'VAST_API_KEY', ...POD_ROLE_IDS.flatMap(role => {
  const suffix = role.toUpperCase().replace(/-/g, '_');
  return [`VAST_POD_URL_${suffix}`, `VAST_POD_EUR_PER_HOUR_${suffix}`];
})];
function configureFleet() {
  vi.stubEnv('AI_POD_TOKEN', 'fixture-runtime-token-at-least-thirty-two-characters');
  vi.stubEnv('VAST_API_KEY', 'fixture-control-key');
  for (const role of POD_ROLE_IDS) {
    const suffix = role.toUpperCase().replace(/-/g, '_');
    vi.stubEnv(`VAST_POD_URL_${suffix}`, `https://${role}.example`);
    vi.stubEnv(`VAST_POD_EUR_PER_HOUR_${suffix}`, '.5');
  }
}
beforeEach(() => {
  calls.length = 0; __resetFleetWakeState(); __resetAiGate(); resetBudgetLimits();
  for (const key of keys) vi.stubEnv(key, '');
  vi.stubEnv('AI_GPU_PROVIDER', 'vast');
  setFleetAutostopHooks({ checkpoint: async () => ({ ok: true, verified: true, snapshotId: 'fixture', revision: 1, persistence: 'MemorySessionPersistence' }) });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/ready')) return new Response('{"status":"ready"}');
    if (url.startsWith('https://console.vast.ai/api/v1/instances?')) return new Response('{"instances":[]}');
    throw new Error(`Unexpected test request: ${url}`);
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __resetFleetWakeState(); __resetAiGate(); resetBudgetLimits(); });

describe('native Vast fleet replaces retired serverless workersMin/warmup controls', () => {
  it('readiness-checks configured role endpoints without control-plane PATCHes or warmup submissions', async () => {
    configureFleet();
    const report = await wakeFleet();
    expect(report.ok).toBe(true);
    expect(sessionWakeRoles()).toEqual(existingRoles);
    expect(report.roles.filter(role => !role.skipped).map(role => role.role)).toEqual(existingRoles);
    expect(report.roles.filter(role => !role.skipped).every(role => role.warmup?.ok)).toBe(true);
    expect(calls).toHaveLength(existingRoles.length);
    expect(calls.every(call => call.method === 'GET' && call.url.endsWith('/ready'))).toBe(true);
  });
  it('studio startup uses all eight selected physical roles, including the existing-media vis service', async () => {
    configureFleet();
    const report = await onSessionStartPods();
    expect(report.blocked).toBeNull();
    expect(report.pods.map(pod => pod.pod)).toEqual([...POD_ROLE_IDS]);
    expect(report.pods.every(pod => pod.state === 'ready' && !pod.startRequested)).toBe(true);
    expect(new Set(calls.map(call => call.url))).toEqual(new Set(POD_ROLE_IDS.map(role => `https://${role}.example/ready`)));
  });
  it('AI off blocks both role readiness wake and physical pod startup before any request', async () => {
    configureFleet(); setAiOperatingMode('off');
    expect((await wakeFleet()).blocked).toBe('ai-off');
    expect((await onSessionStartPods()).blocked).toBe('ai-off');
    expect(calls).toEqual([]);
  });
  it('the role budget guard runs before network access and keeps the same configuration after reset', async () => {
    configureFleet(); setBudgetLimits({ maxEurPerHour: 1 });
    expect((await wakeFleet()).blocked).toBe('budget');
    expect(calls).toEqual([]);
    resetBudgetLimits();
    expect((await wakeFleet()).ok).toBe(true);
    expect(calls).toHaveLength(existingRoles.length);
  });
  it('retired generative visual roles cannot be started by enabling visual AI', async () => {
    configureFleet(); setAiOperatingMode('on-with-visuals');
    const report = await wakeFleet({ roles: ['imageHq', 'videoReal', 'videoAbstract'] });
    expect(report.roles.filter(role => !role.skipped).every(role => !role.configured)).toBe(true);
    expect(calls).toEqual([]);
  });
  it('missing native configuration does not silently reuse legacy endpoint IDs', async () => {
    vi.stubEnv('RP_ENDPOINT_ID', 'retired-endpoint'); vi.stubEnv('RP_AGENT_KEY', 'retired-key');
    const report = await wakeFleet();
    expect(report.roles.every(role => !role.configured)).toBe(true);
    expect(calls).toEqual([]);
  });
  it('AI_FLEET_WAKE=0 prevents requests even with endpoints configured', async () => {
    configureFleet(); vi.stubEnv('AI_FLEET_WAKE', '0');
    const report = await wakeFleet();
    expect(report.roles.every(role => role.error === 'AI_FLEET_WAKE disabled')).toBe(true);
    expect(calls).toEqual([]);
  });
  it('concurrent readiness wakes share one result and one set of probes', async () => {
    configureFleet();
    const [first, second] = await Promise.all([wakeFleet(), wakeFleet()]);
    expect(first).toBe(second); expect(calls).toHaveLength(existingRoles.length);
  });
  it('native sleep uses checkpoint/list/verification, never the removed workersMin API, even when AI is off', async () => {
    configureFleet(); setAiOperatingMode('off');
    const report = await sleepFleet();
    expect(report.ok).toBe(true);
    expect(report.autostop?.steps).toEqual(['checkpoint', 'list', 'terminate', 'verify']);
    expect(calls.every(call => call.method === 'GET' && call.url.includes('/instances?'))).toBe(true);
  });
  it('status inspection is read-only and reports the runtime credential independently of legacy endpoint IDs', () => {
    configureFleet();
    expect(fleetStatus()).toMatchObject({ credentialConfigured: true, aiEnabled: true });
    expect(calls).toEqual([]);
  });
});
