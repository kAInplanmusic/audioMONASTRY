import { beforeEach as beforeCompatibilityProvider, afterEach as afterCompatibilityProvider } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmRouter, LlmTimeoutError, llmCostTracker, llmTimeoutMs } from '../src/core/ai/LlmRouter';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';

// Explicit compatibility fixture: production now defaults to Vast.
beforeCompatibilityProvider(() => { process.env.AI_GPU_PROVIDER = 'vast'; });
afterCompatibilityProvider(() => { delete process.env.AI_GPU_PROVIDER; });
/**
 * INFRA-AI-004: Der LLM-Pfad hatte kein Zeitlimit und keinen Abbruch, und weder
 * Circuit Breaker noch Kostenerfassung waren an `LlmRouter.complete()` verdrahtet.
 * INFRA-AI-005: Der Modul-State (PRO) hatte keine Wirkung auf Provider-/Modellwahl.
 */
const ENV_KEYS = [
  'AI_POD_TOKEN',
  'VAST_POD_URL_BRAIN',
  'VAST_POD_EUR_PER_HOUR_BRAIN',
  'AI_ALLOW_EXTERNAL_LLM',
  'AI_CB_FAILURE_THRESHOLD',
  'LLM_TIMEOUT_MS',
  'AI_COST_LLM_USD',
] as const;
interface RecordedCall {
  url: string;
  body: unknown;
}
let calls: RecordedCall[] = [];
/** Brain auf dem Vast-Pod (Pod-Modus ist auf der Vast-Flotte immer aktiv). */
function brainPodEnv(): void {
  process.env.AI_POD_TOKEN = 't'.repeat(32);
  process.env.VAST_POD_URL_BRAIN = 'https://brain.pods.example';
  process.env.VAST_POD_EUR_PER_HOUR_BRAIN = '0.4';
}
const COMPLETED = { id: 'job-1', status: 'COMPLETED', output: { text: 'ok' } };
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      // Wie echtes fetch: ein gesetztes Signal bricht den Request ab.
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const result = handler(String(input));
      if (!init?.signal) return result;
      return await new Promise<Response>((resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        init.signal!.addEventListener('abort', abort, { once: true });
        Promise.resolve(result).then(resolve, reject).finally(() => init.signal!.removeEventListener('abort', abort));
      });
    }),
  );
}
describe('LlmRouter: Zeitlimit, Circuit Breaker, Kosten (INFRA-AI-004)', () => {
  beforeEach(() => {
    calls = [];
    __resetAiGate();
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAiGate();
    for (const key of ENV_KEYS) delete process.env[key];
  });
  it('bricht einen hängenden Provider nach dem Zeitlimit ab (geordneter Weiterlauf)', async () => {
    process.env.LLM_TIMEOUT_MS = '120';
    brainPodEnv();
    stubFetch(() => new Promise<Response>((_resolve, reject) => {
      setTimeout(() => reject(new Error('nie beantwortet')), 5_000);
    }));
    const router = new LlmRouter();
    const started = Date.now();
    await expect(router.complete({ prompt: 'hi', complexity: 'simple' })).rejects.toBeInstanceOf(LlmTimeoutError);
    // Deutlich vor dem 5-s-Hänger: das Limit hat gegriffen.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(llmTimeoutMs()).toBe(120);
  });
  it('öffnet den Breaker nach Fehlern und ruft den Provider danach nicht mehr auf', async () => {
    brainPodEnv();
    process.env.AI_CB_FAILURE_THRESHOLD = '1';
    stubFetch((url) => (url.endsWith('/ready') ? jsonResponse({ status: 'ready' }) : jsonResponse({ error: 'kaputt' }, 500)));
    const router = new LlmRouter();
    await expect(router.complete({ prompt: 'hi', complexity: 'simple' })).rejects.toBeTruthy();
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    /* Ollama removed */
    // Zweiter Aufruf: der Provider wird übersprungen (fail-fast, kein Netz).
    await expect(router.complete({ prompt: 'hi', complexity: 'simple' })).rejects.toBeTruthy();
    expect(calls.length).toBe(afterFirst);
  });
  it('verbucht die Kosten eines erfolgreichen Aufrufs (Kostenbuch des Routers)', async () => {
    process.env.AI_COST_LLM_USD = '0.002';
    brainPodEnv();
    stubFetch(() => jsonResponse(COMPLETED));
    const before = llmCostTracker.summary().entries;
    const router = new LlmRouter();
    const completion = await router.complete({ prompt: 'hi', complexity: 'simple' });
    expect(completion.text).toBe('ok');
    const summary = router.costSummary();
    expect(summary.entries).toBe(before + 1);
    expect(llmCostTracker.costForSession('llm-router')).toBeGreaterThan(0);
  });
  it('reicht ein Aufrufer-Signal durch (Abbruch von außen)', async () => {
    brainPodEnv();
    stubFetch(() => new Promise<Response>((_resolve, reject) => {
      setTimeout(() => reject(new Error('nie beantwortet')), 2_000);
    }));
    const controller = new AbortController();
    const router = new LlmRouter();
    const promise = router.complete({ prompt: 'hi', complexity: 'simple', signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toBeTruthy();
  });
});
describe('Modul-State wirkt auf Provider- und Modellwahl (INFRA-AI-005)', () => {
  beforeEach(() => {
    calls = [];
    __resetAiGate();
    for (const key of ENV_KEYS) delete process.env[key];
    // Externe Wege zulassen, sonst bleibt die Kette in beiden Stufen gleich.
    process.env.AI_ALLOW_EXTERNAL_LLM = 'true';
    process.env.DEEPSEEK_API_KEY = 'ds_test';
    process.env.PROVIDER_UNUSED = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAiGate();
    for (const key of ENV_KEYS) delete process.env[key];
    delete process.env.DEEPSEEK_API_KEY;
  });
  it('verschiebt die Provider-Kette zwischen Standard und PRO', () => {
    const router = new LlmRouter();
    setAiOperatingMode('on-no-visuals', { source: 'test' });
    const standard = router.rankProviders('moderate').map((p) => p.id);
    expect(standard.indexOf('deepseek-pro')).toBeGreaterThan(standard.indexOf('deepseek-flash'));
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    const pro = router.rankProviders('moderate').map((p) => p.id);
    // PRO zieht das stärkere Modell direkt hinter die lokalen Provider.
    expect(pro.indexOf('deepseek-pro')).toBeLessThan(pro.indexOf('deepseek-flash'));
    expect(pro).not.toEqual(standard);
  });
  it('nutzt auf dem Vast-Brain-Pod in beiden Stufen das Pod-Brain-Modell', async () => {
    // Der Vast-Brain-Pod serviert genau ein Brain-Modell (Pod-Manifest); die
    // Qualitätsstufe wirkt dort nur auf die Provider-Kette, nicht aufs Modell.
    // (Die 4B/14B-Umschaltung gehörte zum RunPod-Serverless-Pfad bis 9394a65.)
    brainPodEnv();
    stubFetch(() => jsonResponse(COMPLETED));
    const router = new LlmRouter();
    setAiOperatingMode('on-no-visuals', { source: 'test' });
    await router.complete({ prompt: 'hi', complexity: 'simple' });
    // Der Job-Pfad: POST /run traegt das Modell, der Status-Poll danach nicht.
    const standardBody = calls.find((c) => c.url.endsWith('/run'))?.body as { input?: { model?: string } } | undefined;
    expect(standardBody?.input?.model).toBe('qwen38-27b-fp8');
    calls = [];
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    await router.complete({ prompt: 'hi', complexity: 'simple' });
    const proBody = calls.find((c) => c.url.endsWith('/run'))?.body as { input?: { model?: string } } | undefined;
    expect(proBody?.input?.model).toBe('qwen38-27b-fp8');
  });
  it('nimmt bei „AI aus" jeden GPU-Provider aus der Kette', () => {
    brainPodEnv();
    const router = new LlmRouter();
    setAiOperatingMode('on-no-visuals', { source: 'test' });
    expect(router.rankProviders('moderate').map((p) => p.id)).toContain('vast-local');
    setAiOperatingMode('off', { source: 'test' });
    expect(router.rankProviders('moderate').map((p) => p.id)).not.toContain('vast-local');
  });
});