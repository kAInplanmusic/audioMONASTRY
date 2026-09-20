/**
 * INFRA-RUNPOD-007 – Nachweis für den gemeinsamen Visual-Job-Pfad
 * =====================================================================
 * Der Audit-Befund V3-5 verlangte einen Beleg, dass ein RunPod-Ausfall auf dem
 * Visual-Pfad (Bild/Video) genauso behandelt wird wie bei den übrigen Rollen:
 * Retry nur bei wiederholbaren Fehlern, Deadline, und ein Circuit Breaker, der
 * nach wiederholten Fehlern öffnet (fail-fast) und diagnostizierbar ist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVisionImage } from '../src/core/ai/vision/runpodVision';
import { generateVideo } from '../src/core/ai/vision/runpodVideo';
import { __resetVisionBreakers, visionBreakerStates } from '../src/core/ai/vision/runpodJobClient';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';
import { __resetFleetWakeState, fleetStatus } from '../src/core/ai/orchestrator/fleetWake';
import { resetBudgetLimits } from '../src/config/aiInfrastructure';

const ENV_KEYS = [
  'AI_MODE',
  'AI_OPERATING_MODE',
  'AI_VISUAL_IDLE_MS',
  'AI_CB_FAILURE_THRESHOLD',
  'AI_CB_RESET_MS',
  'RP_AGENT_KEY',
  'RP_API_KEY',
  'RUNPOD_API_KEY',
  'RUNPOD_API_BASE',
  'RP_ENDPOINT_ID',
  'RP_ENDPOINT_ID_IMAGE',
  'RP_ENDPOINT_ID_VIDEO_REAL',
] as const;

interface RecordedCall {
  url: string;
  method: string;
}

let fetchCalls: RecordedCall[] = [];
let sleeps: number[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Stub für den Weck-Pfad (rest.runpod.io) – der Job läuft über `fetchImpl`. */
function stubGlobalFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ workersMin: 1 })));
}

/** Job-Fetch, dessen Antworten die Testliste der Reihe nach abarbeitet. */
function sequenceFetch(responses: Array<() => Response>): ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), method: init?.method ?? 'GET' });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next();
  });
}

/** Testbare Wartezeit: sammelt die Backoff-/Polling-Zeiten, wartet nicht. */
async function instantSleep(ms: number): Promise<void> {
  sleeps.push(ms);
}

beforeEach(() => {
  fetchCalls = [];
  sleeps = [];
  __resetAiGate();
  __resetFleetWakeState();
  __resetVisionBreakers();
  resetBudgetLimits();
  for (const key of ENV_KEYS) delete process.env[key];
  // Der Visual-Pfad startet die Rolle bei Abruf (wakeRoleOnDemand) – der
  // Weck-Pfad läuft über den GLOBALEN fetch, nicht über den Job-Fetch.
  stubGlobalFetch();
  setAiOperatingMode('on-with-visuals', { source: 'test' });
  process.env.RP_AGENT_KEY = 'rp_test';
  process.env.RP_ENDPOINT_ID_IMAGE = 'image-ep';
  process.env.RP_ENDPOINT_ID_VIDEO_REAL = 'video-real-ep';
  process.env.AI_VISUAL_IDLE_MS = '600000';
  process.env.AI_CB_FAILURE_THRESHOLD = '5';
  process.env.AI_CB_RESET_MS = '60000';
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAiGate();
  __resetFleetWakeState();
  __resetVisionBreakers();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('Visual-Rollen laufen über den gemeinsamen Retry-/Breaker-Pfad (INFRA-RUNPOD-007)', () => {
  it('wiederholt 429/5xx mit Backoff und liefert dann das Bild', async () => {
    const doFetch = sequenceFetch([
      () => jsonResponse({ error: 'too many requests' }, 429),
      () => jsonResponse({ status: 'COMPLETED', output: { image_url: 'data:image/png;base64,AAAA' } }),
    ]);

    const result = await generateVisionImage('neonstadt', {
      fetchImpl: doFetch as unknown as typeof fetch,
      sleepImpl: instantSleep,
      retryBaseMs: 0,
    });

    expect(result.image).toBe('data:image/png;base64,AAAA');
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'https://api.runpod.ai/v2/image-ep/runsync',
      'https://api.runpod.ai/v2/image-ep/runsync',
    ]);
    // Genau EIN Aussetzer wurde wiederholt (kein Polling, weil COMPLETED).
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it('wiederholt NICHT bei 4xx (400) – genau ein Versuch', async () => {
    const doFetch = sequenceFetch([() => new Response('bad payload', { status: 400 })]);

    await expect(
      generateVisionImage('neonstadt', {
        fetchImpl: doFetch as unknown as typeof fetch,
        sleepImpl: instantSleep,
        retryBaseMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'HTTP' });
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('hält die Deadline ein und bricht mit TIMEOUT ab (Job bleibt IN_PROGRESS)', async () => {
    const doFetch = sequenceFetch([
      () => jsonResponse({ id: 'job-1', status: 'IN_QUEUE' }),
      () => jsonResponse({ id: 'job-1', status: 'IN_PROGRESS' }),
    ]);

    await expect(
      generateVisionImage('neonstadt', {
        fetchImpl: doFetch as unknown as typeof fetch,
        sleepImpl: instantSleep,
        pollIntervalMs: 5,
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('öffnet bei einem RunPod-Ausfall den Circuit Breaker der Rolle (fail-fast, ohne Netzwerk)', async () => {
    // RunPod antwortet dauerhaft mit 500 – die Visual-Rolle scheitert wiederholt.
    const outage = sequenceFetch([() => new Response('boom', { status: 500 })]);
    const failing = {
      fetchImpl: outage as unknown as typeof fetch,
      sleepImpl: instantSleep,
      retryBaseMs: 0,
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(generateVisionImage('neonstadt', failing)).rejects.toMatchObject({ code: 'HTTP' });
    }
    expect(visionBreakerStates().imageHq).toBe('OPEN');

    // Diagnose sichtbar im Flotten-Status (kein Netzwerkaufruf).
    const status = fleetStatus() as { visionBreakers: Record<string, string> };
    expect(status.visionBreakers.imageHq).toBe('OPEN');

    // Der offene Breaker lehnt ohne weiteren RunPod-Kontakt ab.
    const callsBefore = outage.mock.calls.length;
    await expect(generateVisionImage('neonstadt', failing)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(outage.mock.calls.length).toBe(callsBefore);
    // Der Breaker ist rollen-eigen: nur die fehlerhafte Rolle ist betroffen.
    expect(Object.keys(visionBreakerStates())).toEqual(['imageHq']);
  });

  it('öffnet den Breaker je Rolle getrennt (Video-Ausfall trifft die Bild-Rolle nicht)', async () => {
    const videoOutage = sequenceFetch([() => new Response('boom', { status: 500 })]);
    const failing = {
      fetchImpl: videoOutage as unknown as typeof fetch,
      sleepImpl: instantSleep,
      retryBaseMs: 0,
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(generateVideo('AAAA', 'zoomen', failing)).rejects.toMatchObject({ code: 'HTTP' });
    }
    expect(visionBreakerStates().videoReal).toBe('OPEN');
    expect(visionBreakerStates().imageHq).toBeUndefined();

    // Die Bild-Rolle läuft weiter (eigener Breaker, eigener Endpoint).
    const imageFetch = sequenceFetch([
      () => jsonResponse({ status: 'COMPLETED', output: { image_url: 'data:image/png;base64,BBBB' } }),
    ]);
    const result = await generateVisionImage('neonstadt', {
      fetchImpl: imageFetch as unknown as typeof fetch,
      sleepImpl: instantSleep,
      retryBaseMs: 0,
    });
    expect(result.image).toBe('data:image/png;base64,BBBB');
  });

  it('nutzt dieselbe API-Basis wie der übrige Provider-Pfad (RUNPOD_API_BASE)', async () => {
    process.env.RUNPOD_API_BASE = 'http://127.0.0.1:9/v2'; // Test-Mock-Basis
    const doFetch = sequenceFetch([
      () => jsonResponse({ status: 'COMPLETED', output: { image_url: 'data:image/png;base64,CCCC' } }),
    ]);

    await generateVisionImage('neonstadt', {
      fetchImpl: doFetch as unknown as typeof fetch,
      sleepImpl: instantSleep,
    });

    expect(fetchCalls.map((c) => c.url)).toEqual(['http://127.0.0.1:9/v2/image-ep/runsync']);
  });
});
