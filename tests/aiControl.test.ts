import { describe, expect, it, vi, afterEach } from 'vitest';
import { LlmRouter, type ILlmProvider, type LlmRequest } from '../src/core/ai/LlmRouter';
import { MoaAgent, parseMoaSteps } from '../src/core/ai/MoaAgent';
import { MemorySessionMediaStore } from '../src/core/session/SessionMediaStore';
import {
  DeterministicTtsProvider,
  VoiceMonkService,
  encodeWav,
} from '../src/core/voice/VoiceMonkService';
import { SongGeneratorService } from '../src/core/voice/SongGenerator';
import { songItemToAudioSource } from '../src/core/voice/SongOutputBridge';
import { VoiceControlService, voiceControlService } from '../src/core/voice/VoiceControlService';
import '../src/core/voice/pluginCommandRegistry';

function mockProvider(id: ILlmProvider['id']): ILlmProvider {
  return {
    id,
    available: true,
    complete: vi.fn(async (req: LlmRequest) => ({ provider: id, text: req.prompt, latencyMs: 1 })),
  };
}

describe('LlmRouter (Kosten-Priorität)', () => {
  it('simple: DeepSeek Flash zuerst, HF dahinter, kein Pro', () => {
    const router = new LlmRouter();
    for (const p of ['hf', 'deepseek-flash', 'deepseek-pro', 'gemini', 'openai'] as const) {
      router.register(mockProvider(p));
    }
    const ids = router.rankProviders('simple').map((p) => p.id);
    expect(ids[0]).toBe('deepseek-flash');
    expect(ids[1]).toBe('hf');
    expect(ids).not.toContain('deepseek-pro');
  });

  it('complex: Pro zuerst, dann Free/Flash, Paid zuletzt', () => {
    const router = new LlmRouter();
    for (const p of ['hf', 'deepseek-flash', 'deepseek-pro', 'gemini', 'openai'] as const) {
      router.register(mockProvider(p));
    }
    const ids = router.rankProviders('complex').map((p) => p.id);
    expect(ids[0]).toBe('deepseek-pro');
    expect(ids[ids.length - 1]).toBe('openai');
  });

  it('moderate: DeepSeek-Flash ist der MOA/MCP-Planer (vor Free/Pro)', () => {
    const router = new LlmRouter();
    for (const p of ['hf', 'deepseek-flash', 'deepseek-pro'] as const) {
      router.register(mockProvider(p));
    }
    const ids = router.rankProviders('moderate').map((p) => p.id);
    expect(ids[0]).toBe('deepseek-flash');
    expect(ids[ids.length - 1]).toBe('deepseek-pro');
  });
});

describe('LlmRouter Provider (gemocktes fetch)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.HF_API_KEY;
  });

  it('deepseek-flash ruft den OpenAI-kompatiblen Endpoint auf', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'deepseek ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const router = new LlmRouter();
    const completion = await router.complete({ prompt: 'Hi', complexity: 'simple' });
    expect(completion.provider).toBe('deepseek-flash');
    expect(completion.text).toBe('deepseek ok');
  });

  it('hf-provider liefert JSON-Fallback-Text', async () => {
    process.env.HF_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify([{ generated_text: 'hf ok' }]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const router = new LlmRouter();
    const completion = await router.complete({ prompt: 'Hi', complexity: 'simple' });
    expect(completion.provider).toBe('hf');
    expect(completion.text).toContain('hf ok');
  });

  it('plan() bevorzugt DeepSeek-Flash als MOA/MCP-Planer', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '[{"pluginId":"mixer","command":"Tempo 128","prompt":"x"}]' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const router = new LlmRouter();
    const plan = await router.plan('Mach schneller');
    expect(plan.provider).toBe('deepseek-flash');
    expect(plan.text).toContain('Tempo 128');
  });
});

describe('LlmRouter Notfall-Provider + clientLlm + env', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.AI_EMERGENCY_PROVIDERS;
    delete process.env.HF_TTS_MODEL;
  });

  it('gemini läuft nur mit AI_EMERGENCY_PROVIDERS=true (gemocktes Fetch)', async () => {
    process.env.AI_EMERGENCY_PROVIDERS = 'true';
    process.env.GEMINI_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini ok' }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const router = new LlmRouter();
    const completion = await router.complete({ prompt: 'Hi', complexity: 'complex' });
    expect(completion.provider).toBe('gemini');
    expect(completion.text).toBe('gemini ok');
  });

  it('openai läuft nur mit AI_EMERGENCY_PROVIDERS=true (gemocktes Fetch)', async () => {
    process.env.AI_EMERGENCY_PROVIDERS = 'true';
    process.env.OPENAI_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'openai ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const router = new LlmRouter();
    const completion = await router.complete({ prompt: 'Hi', complexity: 'complex' });
    expect(completion.provider).toBe('openai');
    expect(completion.text).toBe('openai ok');
  });

  it('clientLlm nutzt in Node den LlmRouter (gemocktes Fetch)', async () => {
    const { completeLlm } = await import('../src/core/ai/clientLlm');
    process.env.DEEPSEEK_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'client ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const completion = await completeLlm({ prompt: 'Hi', complexity: 'simple' });
    expect(completion.provider).toBe('deepseek-flash');
    expect(completion.text).toBe('client ok');
  });

  it('envKey + voiceModel lesen process.env mit Fallback', async () => {
    const { envKey, voiceModel } = await import('../src/core/voice/env');
    process.env.HF_TTS_MODEL = 'test-model';
    expect(envKey('HF_TTS_MODEL')).toBe('test-model');
    expect(voiceModel('tts', 'HF_TTS_MODEL')).toBe('test-model');
    delete process.env.HF_TTS_MODEL;
    expect(voiceModel('tts', 'HF_TTS_MODEL')).toBe('facebook/mms-tts-deu');
    expect(voiceModel('song', 'HF_MUSIC_MODEL')).toBe('facebook/musicgen-medium');
  });
});

describe('MoaAgent (DeepSeek-V4-Flash als Planer)', () => {
  it('parseMoaSteps toleriert Markdown-Fences und parsed JSON', () => {
    const steps = parseMoaSteps('```json\n[{"pluginId":"sequencer","command":"Tempo 128","prompt":"Setze BPM"}]\n```');
    expect(steps).toHaveLength(1);
    expect(steps[0].pluginId).toBe('sequencer');
    expect(steps[0].command).toBe('Tempo 128');
  });

  it('plan nutzt den injizierten Router und liefert Schritte + Provider', async () => {
    const agent = new MoaAgent(async (req) => ({
      provider: 'deepseek-flash',
      text: '[{"pluginId":"mixer","command":"Tempo 128","prompt":"x"}]',
      latencyMs: 1,
    }));
    const plan = await agent.plan('Mach den Track schneller');
    expect(plan.provider).toBe('deepseek-flash');
    expect(plan.steps[0].command).toBe('Tempo 128');
  });

  it('executePlan steuert die Plugins über den Kommando-Executor', async () => {
    const calls: string[] = [];
    const agent = new MoaAgent(
      async () => ({ provider: 'deepseek-flash', text: '[]', latencyMs: 1 }),
      { execute: async (_userId, command) => { calls.push(command); return { handled: true, pluginId: 'transport' }; } },
    );
    const plan = { task: 't', provider: 'deepseek-flash', steps: [{ pluginId: 'transport', command: 'Tempo 128', prompt: 'x' }], raw: '', createdAt: 0 };
    const results = await agent.executePlan(plan, 'User1');
    expect(results[0].handled).toBe(true);
    expect(calls).toEqual(['Tempo 128']);
  });

  it('executePlan nutzt plugin-bewusste Kommandos, wenn verfügbar', async () => {
    const routed: string[] = [];
    const agent = new MoaAgent(
      async () => ({ provider: 'deepseek-flash', text: '[]', latencyMs: 1 }),
      {
        execute: async () => ({ handled: false, pluginId: '', error: 'fallback' }),
        executePluginCommand: async (_userId, pluginId, command) => {
          routed.push(`${pluginId}:${command}`);
          return { handled: true, pluginId, action: 'ok' };
        },
      },
    );
    const plan = { task: 't', provider: 'deepseek-flash', steps: [{ pluginId: 'mixer', command: 'gain', prompt: 'x' }], raw: '', createdAt: 0 };
    const results = await agent.executePlan(plan, 'User1');
    expect(results[0].handled).toBe(true);
    expect(routed).toEqual(['mixer:gain']);
  });
});

describe('VoiceControlService (alle 4 User, alle Plugins)', () => {
  it('führt registrierte Befehle user-scoped aus', async () => {
    const svc = new VoiceControlService();
    const calls: string[] = [];
    svc.registerCommand('transport', 'set_tempo', (ctx) => {
      calls.push(`${ctx.userId}:${ctx.pluginId}:${ctx.intent.parameters.bpm}`);
    });

    for (const user of ['User1', 'User2', 'User3', 'User4']) {
      const res = await svc.execute(user, 'Tempo 128');
      expect(res.handled).toBe(true);
    }
    expect(calls).toEqual(['User1:transport:128', 'User2:transport:128', 'User3:transport:128', 'User4:transport:128']);
  });

  it('meldet fehlende Handler', async () => {
    const svc = new VoiceControlService();
    const res = await svc.execute('User1', 'Stopp');
    expect(res.handled).toBe(false);
  });

  it('executePluginCommand matcht exakte Action und Keywords', async () => {
    const svc = new VoiceControlService();
    const calls: string[] = [];
    svc.registerPluginCommand('mixer', 'gain', (ctx) => {
      calls.push(`gain:${String(ctx.intent.parameters.gain ?? '')}`);
    }, ['lautstärke', 'pegel']);

    const exact = await svc.executePluginCommand('User1', 'mixer', 'gain', { gain: -6 });
    expect(exact.handled).toBe(true);
    expect(exact.action).toBe('gain');

    const keyword = await svc.executePluginCommand('User1', 'mixer', 'Pegel auf -3 dB');
    expect(keyword.handled).toBe(true);

    const miss = await svc.executePluginCommand('User1', 'mixer', 'unbekannt');
    expect(miss.handled).toBe(false);
    expect(calls.length).toBe(2);
  });

  it('Registry deckt alle Plugin-IDs ab (Side-Effect-Registrierung)', () => {
    const ids = voiceControlService.listPlugins();
    for (const id of [
      'sequencer', 'drum', 'mixer', 'spatial', 'instrument', 'fx', 'eq', 'dsp',
      'synthesizer', 'voice', 'library', 'controller', 'sampler', 'stem', 'recording',
      'mastering', 'performance', 'sound', 'drop', 'ai',
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe('VoiceMonkService (TTS + Gesang in Session-DB)', () => {
  it('spricht Text und legt WAV in der Session-DB ab', async () => {
    const store = new MemorySessionMediaStore();
    const svc = new VoiceMonkService(store, [new DeterministicTtsProvider()]);

    const item = await svc.speak('User1', 'Hallo meine Freunde der Tanykultur', {
      gender: 'male', character: 'dark', loudness: 'soft',
    });
    expect(item.kind).toBe('tts');
    expect(item.provider).toBe('deterministic');
    expect(store.listByUser('User1')).toHaveLength(1);
  });

  it('preview liefert in Node false (kein Live-Speech-Provider)', () => {
    const svc = new VoiceMonkService(new MemorySessionMediaStore(), [new DeterministicTtsProvider()]);
    expect(svc.preview('Hallo')).toBe(false);
  });

  it('singt Noten und markiert sie als singing', async () => {
    const store = new MemorySessionMediaStore();
    const svc = new VoiceMonkService(store, [new DeterministicTtsProvider()]);

    const item = await svc.sing('User2', {
      notes: [
        { lyric: 'Hal', midi: 60 },
        { lyric: 'lo', midi: 64 },
      ],
      bpm: 120,
    });
    expect(item.kind).toBe('singing');
    expect(store.listByUser('User2')).toHaveLength(1);
  });

  it('encodeWav erzeugt gültige WAV-Header', async () => {
    const blob = encodeWav(new Float32Array(64), 22050);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBeGreaterThan(44);
  });

  it('generiert einen Song und legt ihn als song in der Session-DB ab', async () => {
    const store = new MemorySessionMediaStore();
    const svc = new VoiceMonkService(store, [new DeterministicTtsProvider()]);

    const item = await svc.generateSong('User3', 'Hallo meine Freunde der Tanykultur', {
      bpm: 120,
      style: 'dark-techno',
    });
    expect(item.kind).toBe('song');
    expect(item.provider).toBe('local-formant-song');
    expect(item.mimeType).toBe('audio/wav');
    expect(store.listByUser('User3')).toHaveLength(1);
  });

  it('veröffentlicht Songs über die V2-Ausgabe-Bridge', async () => {
    const store = new MemorySessionMediaStore();
    const published: ReturnType<typeof songItemToAudioSource>[] = [];
    const svc = new VoiceMonkService(
      store,
      [new DeterministicTtsProvider()],
      new SongGeneratorService(),
      { publish: (source) => published.push(source) },
    );

    await svc.generateSong('User4', 'Bridge Song', { bpm: 100 });
    expect(published).toHaveLength(1);
    expect(published[0].kind).toBe('sample');
    expect(published[0].metadata?.sessionKind).toBe('song');
  });

  it('songItemToAudioSource überführt Session-Medien in V2-AudioSources', () => {
    const source = songItemToAudioSource({
      id: 'song-1',
      userId: 'User5',
      kind: 'song',
      text: 'Mein Song',
      audioUrl: 'blob:song-1',
      mimeType: 'audio/wav',
      createdAt: 123,
      metadata: { provider: 'local-formant-song' },
    });
    expect(source.id).toBe('song-1');
    expect(source.kind).toBe('sample');
    expect(source.sourceRef).toBe('blob:song-1');
    expect(source.metadata?.sessionKind).toBe('song');
  });
});

describe('AI-Failure-Handling (DCT-114)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.HF_API_KEY;
  });

  it('Provider-429 (Rate-Limit) führt zum Fehler (kein Retry-Storm)', async () => {
    process.env.DEEPSEEK_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    const router = new LlmRouter();
    await expect(router.complete({ prompt: 'Hi', complexity: 'simple' })).rejects.toThrow(/429/);
  });

  it('Malformed-Response (kein JSON) wird als Fehler geworfen', async () => {
    process.env.DEEPSEEK_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('kein json', { status: 200 })));
    const router = new LlmRouter();
    await expect(router.complete({ prompt: 'Hi', complexity: 'simple' })).rejects.toThrow();
  });

  it('Alle Provider down → Router wirft mit klarer Meldung', async () => {
    process.env.DEEPSEEK_API_KEY = 'test';
    process.env.HF_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('kaputt', { status: 500 })));
    const router = new LlmRouter();
    await expect(router.complete({ prompt: 'Hi', complexity: 'simple' })).rejects.toThrow(/HTTP 500/);
  });
});
