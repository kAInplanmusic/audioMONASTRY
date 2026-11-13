import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVideo, generateVisionImage } from '../src/core/ai/vision/vastVisual';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';
import { __resetFleetWakeState } from '../src/core/ai/orchestrator/fleetWake';
import { resetBudgetLimits } from '../src/config/aiInfrastructure';

/**
 * INFRA-FEAT-001/002: Die Visual-Pfade hängen am AI-Betriebsmodus. Echter Pfad
 * ohne Mocks bis zum globalen fetch – ein einziger Treffer wäre GPU-Verkehr.
 * Stand Vast-Flotte: kein Pod für imageHq/videoReal, also auch mit Freigabe
 * kein Request, sondern NO_POD_FOR_ROLE.
 */
const ENV_KEYS = [
  'AI_MODE',
  'AI_OPERATING_MODE',
  'AI_GPU_PROVIDER',
  'AI_POD_TOKEN',
  'VAST_POD_URL_VIS',
] as const;

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

let calls: RecordedCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Globaler fetch: Pod-Health (bereit) und Job-Antworten des `vis`-Pods. */
function stubPodFetch(jobBody: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      if (/\/(runsync|run)$/.test(url) || /\/status\//.test(url)) return jsonResponse(jobBody);
      return jsonResponse({ status: 'ok', ready: true });
    }),
  );
}

function vastPodEnv(): void {
  process.env.AI_GPU_PROVIDER = 'vast';
  process.env.AI_POD_TOKEN = 't'.repeat(32);
  process.env.VAST_POD_URL_VIS = 'https://vis.pods.example';
}

describe('Visual-Pfade respektieren den AI-Schalter (INFRA-FEAT-001/002)', () => {
  beforeEach(() => {
    calls = [];
    __resetAiGate();
    __resetFleetWakeState();
    resetBudgetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAiGate();
    __resetFleetWakeState();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('weigert die Bild-Generierung im Modus "ohne Visuals" – ohne einen einzigen Request', async () => {
    vastPodEnv();
    stubPodFetch({ status: 'COMPLETED', output: { image_url: 'data:image/png;base64,AAAA' } });

    await expect(generateVisionImage('neonstadt')).rejects.toMatchObject({ code: 'AI_VISUALS_OFF' });
    expect(calls).toHaveLength(0);
  });

  it('weigert die Video-Generierung bei „AI aus“', async () => {
    vastPodEnv();
    setAiOperatingMode('off', { source: 'test' });
    stubPodFetch({ status: 'COMPLETED', output: { video: 'AAA' } });

    await expect(generateVideo('AAAA', 'langsam zoomen')).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(calls).toHaveLength(0);
  });

  it('meldet mit Visual-Freigabe ehrlich NO_POD_FOR_ROLE – die Vast-Flotte hat keinen Bild-Pod', async () => {
    vastPodEnv();
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    stubPodFetch({ status: 'COMPLETED', output: { image_url: 'data:image/png;base64,AAAA' } });

    await expect(generateVisionImage('neonstadt')).rejects.toMatchObject({ code: 'NO_POD_FOR_ROLE' });
    expect(calls).toHaveLength(0);
  });

  it('meldet für Video ebenso NO_POD_FOR_ROLE ohne GPU-Request', async () => {
    vastPodEnv();
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    stubPodFetch({ id: 'job-1', status: 'COMPLETED', output: { video: 'A'.repeat(200) } });

    await expect(generateVideo('BBBB', 'zoomen')).rejects.toMatchObject({ code: 'NO_POD_FOR_ROLE' });
    expect(calls).toHaveLength(0);
  });
});
