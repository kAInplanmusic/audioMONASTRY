import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVisionImage } from '../src/core/ai/vision/runpodVision';
import { generateVideo } from '../src/core/ai/vision/runpodVideo';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';
import { __resetFleetWakeState } from '../src/core/ai/orchestrator/fleetWake';
import { resetBudgetLimits } from '../src/config/aiInfrastructure';

const ENV_KEYS = [
  'AI_MODE',
  'AI_OPERATING_MODE',
  'AI_VISUAL_IDLE_MS',
  'RP_AGENT_KEY',
  'RP_API_KEY',
  'RUNPOD_API_KEY',
  'RP_ENDPOINT_ID_IMAGE',
  'RP_ENDPOINT_ID_VIDEO_REAL',
  'RP_ENDPOINT_ID',
] as const;

interface RecordedCall {
  url: string;
  method: string;
}

let fetchCalls: RecordedCall[] = [];
let restCalls: RecordedCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Injizierter Worker-Fetch (Job-Pfad) – ein Treffer beweist GPU-Verkehr. */
function jobFetch(body: unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), method: init?.method ?? 'GET' });
    return jsonResponse(body);
  });
}

/** Globaler fetch (Weck-Pfad auf rest.runpod.io). */
function stubGlobalFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      restCalls.push({ url: String(input), method: init?.method ?? 'GET' });
      return jsonResponse({ workersMin: 1 });
    }),
  );
}

describe('Visual-Pfade respektieren den AI-Schalter (INFRA-FEAT-001/002)', () => {
  beforeEach(() => {
    fetchCalls = [];
    restCalls = [];
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
    const doFetch = jobFetch({ status: 'COMPLETED', output: { image_url: 'data:image/png;base64,AAAA' } });

    await expect(
      generateVisionImage('neonstadt', { endpointId: 'image-ep', apiKey: 'rp_test', fetchImpl: doFetch }),
    ).rejects.toMatchObject({ code: 'AI_VISUALS_OFF' });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('weigert die Video-Generierung bei „AI aus“', async () => {
    setAiOperatingMode('off', { source: 'test' });
    const doFetch = jobFetch({ status: 'COMPLETED', output: { video: 'AAA' } });

    await expect(
      generateVideo('AAAA', 'langsam zoomen', { endpointId: 'video-ep', apiKey: 'rp_test', fetchImpl: doFetch }),
    ).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('generiert ein Bild mit Visual-Freigabe und startet die Rolle bei Abruf', async () => {
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    process.env.RP_AGENT_KEY = 'rp_test';
    process.env.RP_ENDPOINT_ID_IMAGE = 'image-ep';
    process.env.AI_VISUAL_IDLE_MS = '600000';
    stubGlobalFetch();
    const doFetch = jobFetch({ status: 'COMPLETED', output: { image_url: 'data:image/png;base64,AAAA', seed: 7 } });

    const result = await generateVisionImage('neonstadt', { fetchImpl: doFetch });
    expect(result.image).toBe('data:image/png;base64,AAAA');
    expect(result.seed).toBe(7);
    // Der Job selbst lief über den injizierten Client (nur EIN Aufruf: runsync).
    expect(fetchCalls.map((c) => c.url)).toEqual(['https://api.runpod.ai/v2/image-ep/runsync']);

    // INFRA-FEAT-002: Der Abruf hat die Visual-Rolle gestartet (workersMin=1).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(restCalls).toHaveLength(1);
    expect(restCalls[0].url).toBe('https://rest.runpod.io/v1/endpoints/image-ep');
    expect(restCalls[0].method).toBe('PATCH');
  });

  it('generiert ein Video mit Visual-Freigabe', async () => {
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    // Rohes base64 (der Worker liefert kein data:-Praefix) – `extractVideo`
    // akzeptiert Strings erst ab 100 Zeichen als Video-Payload.
    const videoBase64 = 'A'.repeat(200);
    // Der Video-Pfad geht über POST /run; die Antwort kommt hier direkt terminal.
    const doFetch = jobFetch({ id: 'job-1', status: 'COMPLETED', output: { video: videoBase64 } });

    const result = await generateVideo('BBBB', 'zoomen', {
      endpointId: 'video-real-ep',
      apiKey: 'rp_test',
      fetchImpl: doFetch,
    });
    expect(result.video).toBe(`data:video/mp4;base64,${videoBase64}`);
    expect(fetchCalls.map((c) => c.url)).toEqual(['https://api.runpod.ai/v2/video-real-ep/run']);
  });
});
