import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_RESIDENT_FLEET, GPU_ROLE_IDS } from '../src/config/aiInfrastructure';
import { __resetAiGate } from '../src/core/ai/aiGate';
import { POD_ROLE_IDS, fleetMode, podBaseUrl, podRoleFor, podToken } from '../src/core/ai/orchestrator/podRouting';
import { RunPodProvider } from '../src/core/ai/orchestrator/runpodProvider';

const TOKEN = 'p'.repeat(40);
const KEYS = ['AI_FLEET_MODE', 'AI_POD_TOKEN', 'AI_MODE', 'AI_OPERATING_MODE',
  ...POD_ROLE_IDS.flatMap((r) => [`RP_POD_ID_${r.toUpperCase()}`, `RP_POD_URL_${r.toUpperCase()}`])];

interface Fleet { pods: Array<{ role: string; covers: string[]; tasks?: string[] }>; retiredRoles: string[] }
const fleet = JSON.parse(readFileSync(fileURLToPath(new URL('../deploy/runpod/pod-fleet.json', import.meta.url)), 'utf8')) as Fleet;

describe('Pod-Routing (AI_FLEET_MODE=pods)', () => {
  beforeEach(() => {
    __resetAiGate();
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of KEYS) delete process.env[k];
    __resetAiGate();
  });

  it('Zielbild in der Config und Deploy-Quelle haben dieselben Instanzen', () => {
    expect(AI_RESIDENT_FLEET.map((i) => i.id)).toEqual(fleet.pods.map((p) => p.role));
    for (const inst of AI_RESIDENT_FLEET) {
      expect([...inst.covers].sort(), inst.id).toEqual([...(fleet.pods.find((p) => p.role === inst.id)?.covers ?? [])].sort());
    }
  });

  it('Standard bleibt Serverless, bis umgeschaltet wird', () => {
    expect(fleetMode()).toBe('serverless');
    process.env.AI_FLEET_MODE = 'pods';
    expect(fleetMode()).toBe('pods');
  });

  it('ordnet jede GPU-Rolle dem Pod aus pod-fleet.json zu; Visuals haben keinen Pod', () => {
    expect([...POD_ROLE_IDS].sort()).toEqual(fleet.pods.map((p) => p.role).sort());
    for (const role of GPU_ROLE_IDS) {
      const pod = podRoleFor(role);
      if (fleet.retiredRoles.includes(role)) {
        expect(pod, role).toBeNull();
      } else {
        expect(fleet.pods.find((p) => p.role === pod)?.covers, role).toContain(role);
      }
    }
    expect(podRoleFor('voiceGen', 'stem.separate')).toBe('stems');
    expect(fleet.pods.find((p) => p.role === 'stems')?.tasks).toEqual(['stem.separate']);
    expect(podRoleFor('voiceGen', 'tts')).toBe('voice');
  });

  it('baut die Proxy-URL aus der Pod-ID und lehnt Unsinn ab', () => {
    process.env.RP_POD_ID_BRAIN = 'abc123xyz';
    expect(podBaseUrl('brain')).toBe('https://abc123xyz-8000.proxy.runpod.net');
    process.env.RP_POD_ID_EARS = 'x/../evil';
    expect(podBaseUrl('ears')).toBe('');
    process.env.RP_POD_URL_MUSIC = 'http://unverschluesselt';
    expect(podBaseUrl('music')).toBe('');
    process.env.RP_POD_URL_MUSIC = 'https://music.example/';
    expect(podBaseUrl('music')).toBe('https://music.example');
  });

  it('Token unter 32 Zeichen zählt als fehlend', () => {
    process.env.AI_POD_TOKEN = 'kurz';
    expect(podToken()).toBe('');
    process.env.AI_POD_TOKEN = TOKEN;
    expect(podToken()).toBe(TOKEN);
  });

  it('schickt Jobs mit Pod-Token an den Pod; Stem-Trennung an den stems-Pod', async () => {
    process.env.AI_FLEET_MODE = 'pods';
    process.env.AI_POD_TOKEN = TOKEN;
    process.env.RP_POD_ID_VOICE = 'voicepod1';
    process.env.RP_POD_ID_STEMS = 'stemspod1';
    const calls: Array<{ url: string; auth: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: String((init?.headers as Record<string, string>)?.Authorization ?? '') });
      if (url.endsWith('/runsync')) {
        return new Response(JSON.stringify({ id: 'j1', status: 'COMPLETED', output: { status: 'success', result: { ok: 1 } } }), { status: 200 });
      }
      if (url.endsWith('/run')) return new Response(JSON.stringify({ id: 'j2', status: 'IN_QUEUE' }), { status: 200 });
      return new Response(JSON.stringify({ id: 'j2', status: 'COMPLETED', output: { status: 'success', result: { stems: 6 } } }), { status: 200 });
    }));
    const voice = new RunPodProvider('voiceGen');
    expect(voice.available).toBe(true);
    await voice.run('tts', 'qwen3-tts-17b', { text: 'hi' });
    await voice.run('stem.separate', 'htdemucs-6s', { audio: 'x' });
    expect(calls[0]).toEqual({ url: 'https://voicepod1-8000.proxy.runpod.net/runsync', auth: `Bearer ${TOKEN}` });
    expect(calls.slice(1).every((c) => c.url.startsWith('https://stemspod1-8000.proxy.runpod.net/'))).toBe(true);
    expect(calls.some((c) => c.url.includes('api.runpod.ai'))).toBe(false);
  });

  it('Visual-Rolle im Pod-Modus: klarer Fehler, kein Netzaufruf', async () => {
    process.env.AI_FLEET_MODE = 'pods';
    process.env.AI_POD_TOKEN = TOKEN;
    process.env.AI_MODE = 'on-with-visuals';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const image = new RunPodProvider('imageHq');
    expect(image.available).toBe(false);
    await expect(image.run('image.generate', 'flux1-dev', {})).rejects.toMatchObject({ code: 'NO_POD_FOR_ROLE' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fehlende Pod-Adresse oder fehlendes Token: kein Netzaufruf', async () => {
    process.env.AI_FLEET_MODE = 'pods';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const brain = new RunPodProvider('brain');
    await expect(brain.run('llm', 'qwen3-4b', {})).rejects.toMatchObject({ code: 'POD_NOT_CONFIGURED' });
    process.env.RP_POD_ID_BRAIN = 'brainpod1';
    await expect(brain.run('llm', 'qwen3-4b', {})).rejects.toMatchObject({ code: 'NO_POD_TOKEN' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('fleetWake im Pod-Modus', () => {
  const POD_KEYS = [...KEYS, 'AI_FLEET_WAKE', 'AI_FLEET_SLEEP'];
  beforeEach(() => {
    __resetAiGate();
    for (const k of POD_KEYS) delete process.env[k];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of POD_KEYS) delete process.env[k];
    __resetAiGate();
  });

  it('fragt nur /ready der Pods ab und ruft nie die Serverless-API', async () => {
    const { wakeFleet, sleepFleet, __resetFleetWakeState } = await import('../src/core/ai/orchestrator/fleetWake');
    __resetFleetWakeState();
    process.env.AI_FLEET_MODE = 'pods';
    process.env.AI_FLEET_WAKE = '1';
    process.env.AI_FLEET_SLEEP = '1';
    process.env.AI_POD_TOKEN = TOKEN;
    for (const r of POD_ROLE_IDS) process.env[`RP_POD_ID_${r.toUpperCase()}`] = `${r}pod1`;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ status: 'ready' }), { status: 200 });
    }));
    const report = await wakeFleet();
    expect(report.ok).toBe(true);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => /^https:\/\/[a-z]+pod1-8000\.proxy\.runpod\.net\/ready$/.test(u))).toBe(true);
    const sleep = await sleepFleet();
    expect(sleep.ok).toBe(true);
    expect(urls.some((u) => u.includes('runpod.io') || u.includes('api.runpod.ai'))).toBe(false);
  });
});
