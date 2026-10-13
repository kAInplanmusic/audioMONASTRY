// @vitest-environment node
/**
 * FLEET-P1-009 · LEGO auf RP4 voice + TTS-Vorrang (gemockte Flotte).
 *
 *   - Routing: song mit aceTask lego/extract/complete (acestep-v15-xl-base) → voice-Pod,
 *     sft/turbo/repaint → music-Pod
 *   - Warteschlange je Pod: tts > sfx > lego/extract/complete
 *   - TTS unterbricht einen laufenden LEGO-Job: klare Wiederholungsmeldung,
 *     kein lokaler Fallback, keine Kostenbuchung für den unterbrochenen Lauf
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAiGate } from '../src/core/ai/aiGate';
import { CostTracker } from '../src/core/ai/orchestrator/costTracker';
import { __resetFleetWakeState } from '../src/core/ai/orchestrator/fleetWake';
import { runMusicContextTool, type MusicLibraryPort } from '../src/core/ai/orchestrator/musicContextTools';
import {
  classifyPodJob,
  PodJobQueue,
  PodPreemption,
  podQueue,
  PREEMPTED_CODE,
} from '../src/core/ai/orchestrator/podJobQueue';
import { isLegoJob, POD_ROLE_IDS, podRoleFor } from '../src/core/ai/orchestrator/podRouting';
import { ProviderRouter } from '../src/core/ai/orchestrator/providerRouter';
import { RunPodProvider } from '../src/core/ai/orchestrator/runpodProvider';
import { AiProviderError } from '../src/core/ai/orchestrator/types';

const TOKEN = 'q'.repeat(40);
const KEYS = [
  'AI_FLEET_MODE', 'AI_POD_TOKEN', 'AI_MODE', 'AI_OPERATING_MODE', 'AI_FLEET_WAKE', 'AI_POD_QUEUE_SLOTS_VOICE',
  ...POD_ROLE_IDS.flatMap((r) => [`RP_POD_ID_${r.toUpperCase()}`, `RP_POD_URL_${r.toUpperCase()}`]),
];

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const lego = { aceTask: 'lego', taskType: 'lego' };

describe('FLEET-P1-009: Routing an den voice-Pod', () => {
  it('lego/extract/complete (xl-base) → voice; sft/turbo/repaint → music', () => {
    for (const aceTask of ['lego', 'extract', 'complete']) {
      expect(podRoleFor('music', 'song', 'acestep-v15-xl-base', { aceTask }), aceTask).toBe('voice');
    }
    expect(podRoleFor('music', 'song', 'acestep-v15-xl-base', {})).toBe('voice');
    expect(podRoleFor('music', 'song', 'acestep-v15-xl-sft', { prompt: 'x' })).toBe('music');
    expect(podRoleFor('music', 'song', 'acestep-v15-xl-turbo', {})).toBe('music');
    expect(podRoleFor('music', 'song', 'acestep-v15-xl-base', { aceTask: 'repaint' })).toBe('music');
    expect(podRoleFor('music', 'song', 'acestep-v15-xl-sft', { aceTask: 'repaint' })).toBe('music');
    expect(podRoleFor('music', 'sing', 'bark-small', {})).toBe('music');
    expect(podRoleFor('music')).toBe('music');
    expect(isLegoJob('tts', 'acestep-v15-xl-base', lego)).toBe(false);
  });

  it('Klassen: tts > sfx > sonstige > lego', () => {
    expect(classifyPodJob('tts', 'qwen3-tts-17b')).toBe('tts');
    expect(classifyPodJob('audio.generate', 'stable-audio-open-1.0')).toBe('sfx');
    expect(classifyPodJob('song', 'acestep-v15-xl-base', { aceTask: 'extract' })).toBe('lego');
    expect(classifyPodJob('song', 'acestep-v15-xl-sft', {})).toBe('default');
  });
});

describe('FLEET-P1-009: Warteschlange mit Priorität', () => {
  it('ein Slot: wartende Jobs laufen in der Reihenfolge tts, sfx, lego (nicht FIFO)', async () => {
    const q = new PodJobQueue('voice', () => 1);
    const order: string[] = [];
    const blocker = deferred();
    const first = q.run('default', 'blocker', () => blocker.promise);
    const jobs = [
      q.run('lego', 'lego', async () => { order.push('lego'); }),
      q.run('sfx', 'sfx', async () => { order.push('sfx'); }),
      q.run('tts', 'tts', async () => { order.push('tts'); }),
    ];
    expect(q.snapshot().waiting.map((w) => w.cls)).toEqual(['tts', 'sfx', 'lego']);
    blocker.resolve('ok');
    await first;
    await Promise.all(jobs);
    expect(order).toEqual(['tts', 'sfx', 'lego']);
  });

  it('TTS unterbricht einen laufenden LEGO-Job sofort (klare Wiederholungsmeldung, Signal mit PodPreemption)', async () => {
    const q = new PodJobQueue('voice', () => 1);
    let legoSignal: AbortSignal | null = null;
    const legoJob = q.run('lego', 'song:acestep-v15-xl-base', (signal) => {
      legoSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }, undefined, 'runpod-music');
    const tts = q.run('tts', 'tts:qwen3-tts-17b', async () => 'gesprochen');

    const error = await legoJob.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ code: PREEMPTED_CODE, retryable: true, provider: 'runpod-music' });
    expect((error as Error).message).toMatch(/unterbrochen.*erneut starten/);
    expect(legoSignal!.aborted).toBe(true);
    expect(legoSignal!.reason).toBeInstanceOf(PodPreemption);
    await expect(tts).resolves.toBe('gesprochen');
    expect(q.snapshot().preemptions).toBe(1);
  });

  it('SFX unterbricht LEGO nicht (wartet), ein zweiter Slot verhindert die Unterbrechung', async () => {
    const q = new PodJobQueue('voice', () => 1);
    const legoDone = deferred();
    const legoJob = q.run('lego', 'lego', () => legoDone.promise);
    const sfx = q.run('sfx', 'sfx', async () => 'sfx');
    expect(q.snapshot().running.map((r) => r.cls)).toEqual(['lego']);
    legoDone.resolve('stem');
    await expect(legoJob).resolves.toBe('stem');
    await expect(sfx).resolves.toBe('sfx');

    const wide = new PodJobQueue('voice', () => 2);
    const longLego = deferred();
    const l2 = wide.run('lego', 'lego', () => longLego.promise);
    await expect(wide.run('tts', 'tts', async () => 'tts')).resolves.toBe('tts');
    longLego.resolve('fertig');
    await expect(l2).resolves.toBe('fertig');
    expect(wide.snapshot().preemptions).toBe(0);
  });

  it('Abbruch des Aufrufers entfernt einen wartenden Job', async () => {
    const q = new PodJobQueue('voice', () => 1);
    const blocker = deferred();
    const b = q.run('default', 'b', () => blocker.promise);
    const ctrl = new AbortController();
    const waiting = q.run('lego', 'lego', async () => 'nie', ctrl.signal);
    ctrl.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(q.snapshot().waiting).toHaveLength(0);
    blocker.resolve(1);
    await b;
  });
});

describe('FLEET-P1-009: Ende-zu-Ende über Provider (Pod-Modus, gemockte Flotte)', () => {
  let calls: Array<{ url: string; method: string; body?: unknown }> = [];

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
    __resetAiGate();
    __resetFleetWakeState();
    process.env.AI_FLEET_MODE = 'pods';
    process.env.AI_POD_TOKEN = TOKEN;
    for (const r of POD_ROLE_IDS) process.env[`RP_POD_ID_${r.toUpperCase()}`] = `${r}pod1`;
    calls = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.endsWith('/ready')) return json({ status: 'ready' });
      if (url.includes('/cancel/')) return json({ detail: 'Not Found' }, 404);
      if (url.endsWith('/runsync')) return json({ id: 't1', status: 'COMPLETED', output: { status: 'success', result: { audio: 'tts' } } });
      if (url.endsWith('/run')) return json({ id: 'lego-1', status: 'IN_QUEUE' });
      // Der LEGO-Lauf rechnet "ewig".
      return json({ id: 'lego-1', status: 'IN_PROGRESS' });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const k of KEYS) delete process.env[k];
    __resetFleetWakeState();
    __resetAiGate();
  });

  it('LEGO geht an den voice-Pod; TTS unterbricht ihn; kein lokaler Fallback; Abbruch-Wunsch an den Pod', async () => {
    const router = new ProviderRouter();
    const legoRun = router.run('song', 'acestep-v15-xl-base', { ...lego, prompt: 'bass dazu' });
    await vi.waitFor(() => expect(calls.some((c) => c.url === 'https://voicepod1-8000.proxy.runpod.net/run')).toBe(true));
    expect(calls.some((c) => c.url.startsWith('https://musicpod1-8000.proxy.runpod.net/run'))).toBe(false);
    expect(podQueue('voice').snapshot().running.map((r) => r.cls)).toEqual(['lego']);

    const tts = await new RunPodProvider('voiceGen').run('tts', 'qwen3-tts-17b', { text: 'Ansage' });
    expect(tts).toMatchObject({ status: 'success' });

    const error = await legoRun.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: PREEMPTED_CODE, retryable: true });
    // Kein deterministischer Ersatz (der LocalProvider kann 'song' und hätte Text geliefert).
    expect((error as { provider?: string }).provider).toBe('runpod-music');
    await vi.waitFor(() => expect(calls.some((c) => c.url === 'https://voicepod1-8000.proxy.runpod.net/cancel/lego-1' && c.method === 'POST')).toBe(true), { timeout: 4000 });
    expect(podQueue('voice').snapshot().preemptions).toBe(1);
  });

  it('runMusicContextTool: unterbrochener Lauf bucht nichts, die Wiederholung genau einmal (runpod-voice)', async () => {
    const costs = new CostTracker();
    const record = vi.spyOn(costs, 'record');
    const library: MusicLibraryPort = {
      resolveAudio: async (id) => ({ id, name: id, audioBase64: 'AAAA', bytes: 3 }),
      save: async () => ({ id: 'lib-1' }),
    };
    let attempt = 0;
    const deps = {
      runTask: async () => {
        attempt += 1;
        if (attempt === 1) throw new AiProviderError('runpod-music', PREEMPTED_CODE, 'unterbrochen', true);
        return { audioBase64: 'UklGRg==', format: 'wav' };
      },
      getLibrary: () => library,
      costs,
      getSessionId: () => 'sess-lego',
    };
    const args = { contextIds: ['drums-1'], track: 'bass', prompt: 'warmer bass' };
    await expect(runMusicContextTool('lego', args, deps)).rejects.toMatchObject({ code: PREEMPTED_CODE });
    expect(record).not.toHaveBeenCalled();
    const ok = await runMusicContextTool('lego', args, deps);
    expect(ok.libraryId).toBe('lib-1');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ provider: 'runpod-voice', task: 'song', model: 'acestep-v15-xl-base' });
  });
});
