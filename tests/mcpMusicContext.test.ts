// @vitest-environment node
/**
 * LEGO-P1-001: music.lego / music.extract / music.complete / music.repaint
 * Vertrag + Mock-Pfad (kein Live-GPU-Lauf): Schema-Validierung, Vorspuren als
 * Kontext an die Musik-Rolle, stille Bibliotheks-Ablage, Kostenbremse.
 */
import { describe, expect, it, vi } from 'vitest';
import { CostTracker } from '../src/core/ai/orchestrator/costTracker';
import { createDefaultMcpRuntime } from '../src/core/ai/orchestrator/mcpRuntime';
import {
  ACE_STEP_BASE_MODEL,
  ACE_STEP_REPAINT_DEFAULT_MODEL,
  MusicContextGuard,
  REPAINT_MODE_COVER_STRENGTH,
  aceInstruction,
  extractAudioOutput,
  normalizeKeyscale,
  parseMusicContextArgs,
  resolveMusicContextLimits,
  runMusicContextTool,
  type LibraryAudio,
  type LibrarySaveEntry,
  type MusicLibraryPort,
} from '../src/core/ai/orchestrator/musicContextTools';
import { createMusicLibraryAdapter } from '../server/musicLibraryAdapter';

const EXEC = { permission: 'EXECUTION' };

function fakeLibrary(ids: string[] = ['drums-1', 'bass-1', 'mix-1']) {
  const saved: LibrarySaveEntry[] = [];
  const library: MusicLibraryPort = {
    resolveAudio: vi.fn(async (id: string): Promise<LibraryAudio | null> =>
      ids.includes(id) ? { id, name: id, audioBase64: Buffer.from(id).toString('base64'), bytes: 1000 } : null,
    ),
    save: vi.fn(async (entry: LibrarySaveEntry) => {
      saved.push(entry);
      return { id: `stem-${saved.length}`, url: `/api/media/uploads/stem-${saved.length}.wav` };
    }),
  };
  return { library, saved };
}

function setup(opts: { library?: MusicLibraryPort | null; output?: unknown } = {}) {
  const calls: Array<{ task: string; model: string; input: Record<string, unknown> }> = [];
  const costs = new CostTracker();
  const { library, saved } = fakeLibrary();
  const lib = opts.library === undefined ? library : opts.library;
  const runtime = createDefaultMcpRuntime({
    runTask: async (task, model, input) => {
      calls.push({ task, model, input: input as Record<string, unknown> });
      return opts.output ?? { audioBase64: 'UklGRg==', sampleRate: 48000 };
    },
    getSessionState: () => ({}),
    searchSamples: () => [],
    getRuntimeStatus: () => ({}),
    loadModel: async () => {},
    unloadModel: async () => {},
    musicContext: { getLibrary: () => lib, costs, getSessionId: () => 'sess-1' },
  });
  return { runtime, calls, costs, saved, library };
}

describe('LEGO-P1-001: Kontext-Werkzeuge im MCP-Katalog', () => {
  it('registriert music.lego/extract/complete/repaint als EXECUTION-Generierung', () => {
    const { runtime } = setup();
    for (const name of ['music.lego', 'music.extract', 'music.complete', 'music.repaint']) {
      expect(runtime.listTools().find((t) => t.name === name)).toMatchObject({ category: 'generation', permission: 'EXECUTION' });
    }
  });

  it('verweigert ohne EXECUTION-Permission', async () => {
    const { runtime, calls } = setup();
    const res = await runtime.invoke('music.lego', { contextIds: ['drums-1'], track: 'bass', prompt: 'x', permission: 'WRITE' });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('LEGO-P1-001: Schema-Validierung', () => {
  it.each([
    ['music.lego', { contextIds: [], track: 'bass', prompt: 'x' }, 'contextIds'],
    ['music.lego', { contextIds: ['drums-1'], track: 'kazoo', prompt: 'x' }, 'track'],
    ['music.lego', { contextIds: ['drums-1'], track: 'bass', prompt: '' }, 'prompt'],
    ['music.lego', { contextIds: ['drums-1', 'drums-1'], track: 'bass', prompt: 'x' }, 'doppelt'],
    ['music.lego', { contextIds: ['../etc/passwd'], track: 'bass', prompt: 'x' }, 'Bibliotheks-ID'],
    ['music.lego', { contextIds: ['drums-1'], track: 'bass', prompt: 'x', bpm: 1000 }, 'bpm'],
    ['music.lego', { contextIds: ['drums-1'], track: 'bass', prompt: 'x', key: 'H dur' }, 'key'],
    ['music.lego', { contextIds: ['drums-1'], track: 'bass', prompt: 'x', model: 'acestep-v15-xl-turbo' }, 'model'],
    ['music.lego', { contextIds: ['drums-1'], track: 'bass', prompt: 'x', evil: true }, 'evil'],
    ['music.extract', { sourceId: 'mix-1' }, 'track'],
    ['music.complete', { contextIds: ['drums-1'], tracks: [], prompt: 'x' }, 'tracks'],
    ['music.repaint', { sourceId: 'mix-1', start: 10, end: 5, prompt: 'x' }, 'end'],
    ['music.repaint', { sourceId: 'mix-1', start: 0, end: 5, prompt: 'x', mode: 'wild' }, 'mode'],
    // Betreiber 2026-10-13: xl-base NUR fuer lego/extract/complete (RP4), nie repaint (RP3).
    ['music.repaint', { sourceId: 'mix-1', start: 0, end: 5, prompt: 'x', model: 'acestep-v15-xl-base' }, 'model'],
  ])('%s lehnt %j ab', async (tool, args, hint) => {
    const { runtime, calls } = setup();
    const res = await runtime.invoke(tool, { ...args, ...EXEC });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ungueltige Argumente');
    expect(res.error).toContain(hint);
    expect(calls).toHaveLength(0);
  });

  it('begrenzt die Zahl der Vorspuren (Server-Kontext-Limit)', () => {
    const limits = { ...resolveMusicContextLimits(), maxContextTracks: 2 };
    expect(() =>
      parseMusicContextArgs('lego', { contextIds: ['a1', 'a2', 'a3'], track: 'bass', prompt: 'x' }, limits),
    ).toThrow(/hoechstens 2 Vorspuren/);
  });

  it('normalisiert Tonarten auf ACE-Step-keyscale', () => {
    expect(normalizeKeyscale('Am')).toBe('A Minor');
    expect(normalizeKeyscale('f# minor')).toBe('F# Minor');
    expect(normalizeKeyscale('C')).toBe('C Major');
    expect(normalizeKeyscale('H')).toBeNull();
  });

  it('nutzt den ACE-Step-Wortlaut fuer instruction', () => {
    expect(aceInstruction('lego', { track: 'bass' })).toBe('Generate the bass track based on the audio context:');
    expect(aceInstruction('extract', { track: 'vocals' })).toBe('Extract the vocals track from the audio:');
    expect(aceInstruction('complete', { tracks: ['drums', 'bass'] })).toBe('Complete the input track with drums, bass:');
    expect(aceInstruction('repaint', {})).toBeUndefined();
  });
});

describe('LEGO-P1-001: Kontext an die Musik-Rolle + stille Bibliotheks-Ablage', () => {
  it('music.lego reicht Vorspuren als Kontext-Audio an `song` und speichert still', async () => {
    const { runtime, calls, saved, costs } = setup();
    const res = await runtime.invoke('music.lego', {
      contextIds: ['drums-1', 'bass-1'],
      track: 'guitar',
      prompt: 'funky rhythm guitar',
      bpm: 118,
      key: 'Em',
      ...EXEC,
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toBe('song');
    expect(calls[0].model).toBe(ACE_STEP_BASE_MODEL);
    expect(calls[0].input).toMatchObject({
      aceTask: 'lego',
      taskType: 'lego',
      instruction: 'Generate the guitar track based on the audio context:',
      prompt: 'funky rhythm guitar',
      track: 'guitar',
      bpm: 118,
      keyscale: 'E Minor',
      contextIds: ['drums-1', 'bass-1'],
    });
    expect((calls[0].input.contextAudio as LibraryAudio[]).map((a) => a.id)).toEqual(['drums-1', 'bass-1']);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: 'stem', format: 'wav', bpm: 118, key: 'E Minor' });
    expect(saved[0].tags).toEqual(expect.arrayContaining(['ai', 'ai-lego', 'guitar', 'ctx:drums-1', 'ctx:bass-1']));
    expect(res.result).toMatchObject({ task: 'lego', libraryId: 'stem-1', contextIds: ['drums-1', 'bass-1'] });
    expect(costs.costForSession('sess-1')).toBeGreaterThan(0);
  });

  it('Reihenfolge frei: Bass zuerst, dann Drums dazu', async () => {
    const { runtime, calls } = setup();
    await runtime.invoke('music.lego', { contextIds: ['bass-1'], track: 'drums', prompt: 'x', ...EXEC });
    await runtime.invoke('music.lego', { contextIds: ['bass-1', 'drums-1'], track: 'synth', prompt: 'y', ...EXEC });
    expect(calls.map((c) => c.input.track)).toEqual(['drums', 'synth']);
  });

  it('music.extract und music.complete', async () => {
    const { runtime, calls, saved } = setup();
    expect((await runtime.invoke('music.extract', { sourceId: 'mix-1', track: 'vocals', ...EXEC })).ok).toBe(true);
    expect(
      (await runtime.invoke('music.complete', { contextIds: ['drums-1'], tracks: ['bass', 'keyboard'], prompt: 'house', ...EXEC })).ok,
    ).toBe(true);
    expect(calls[0].input).toMatchObject({ aceTask: 'extract', instruction: 'Extract the vocals track from the audio:', contextIds: ['mix-1'] });
    expect(calls[1].input).toMatchObject({ aceTask: 'complete', instruction: 'Complete the input track with bass, keyboard:' });
    expect(saved.map((s) => s.kind)).toEqual(['stem', 'sound']);
  });

  it.each(['conservative', 'balanced', 'aggressive'] as const)('music.repaint Modus %s mit Zeitbereich', async (mode) => {
    const { runtime, calls } = setup();
    const res = await runtime.invoke('music.repaint', { sourceId: 'mix-1', start: 8, end: 16, mode, prompt: 'new break', ...EXEC });
    expect(res.ok).toBe(true);
    expect(calls[0].input).toMatchObject({
      aceTask: 'repaint',
      repaintStart: 8,
      repaintEnd: 16,
      repaintMode: mode,
      audioCoverStrength: REPAINT_MODE_COVER_STRENGTH[mode],
      lmModel: 'acestep-5hz-lm-4b',
    });
    // Standard fuer repaint ist xl-sft (RP3), nicht mehr xl-base.
    expect(calls[0].model).toBe('acestep-v15-xl-sft');
  });

  it('music.repaint: Default-Modus balanced, Turbo erlaubt, -1 = Dateiende', async () => {
    const { runtime, calls } = setup();
    const res = await runtime.invoke('music.repaint', { sourceId: 'mix-1', start: 30, end: -1, prompt: 'outro', model: 'acestep-v15-xl-turbo', ...EXEC });
    expect(res.ok).toBe(true);
    expect(calls[0].model).toBe('acestep-v15-xl-turbo');
    expect(calls[0].input).toMatchObject({ repaintMode: 'balanced', repaintEnd: -1 });
  });

  it('music.repaint ohne Modell laeuft mit xl-sft - xl-base liegt nicht auf dem music-Pod (FLEET-P1-009)', async () => {
    const { runtime, calls } = setup();
    const res = await runtime.invoke('music.repaint', { sourceId: 'mix-1', start: 0, end: 8, prompt: 'break', ...EXEC });
    expect(res.ok).toBe(true);
    // repaint bleibt auf RP3 (music); dort sind xl-sft/xl-turbo/5hz-lm ausgerollt,
    // xl-base liegt auf RP4 (voice, LEGO). Der Default muss deshalb xl-sft sein.
    expect(calls[0].model).toBe(ACE_STEP_REPAINT_DEFAULT_MODEL);
    expect(ACE_STEP_REPAINT_DEFAULT_MODEL).toBe('acestep-v15-xl-sft');
    // lego bleibt unveraendert auf dem Base-Modell.
    const lego = setup();
    await lego.runtime.invoke('music.lego', { contextIds: ['drums-1'], track: 'bass', prompt: 'x', ...EXEC });
    expect(lego.calls[0].model).toBe(ACE_STEP_BASE_MODEL);
  });

  it('unbekannte Bibliotheks-ID → Fehler ohne GPU-Aufruf', async () => {
    const { runtime, calls } = setup();
    const res = await runtime.invoke('music.lego', { contextIds: ['ghost-1'], track: 'bass', prompt: 'x', ...EXEC });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ghost-1');
    expect(calls).toHaveLength(0);
  });

  it('ohne angebundene Bibliothek: klarer Fehler', async () => {
    const { runtime, calls } = setup({ library: null });
    const res = await runtime.invoke('music.extract', { sourceId: 'mix-1', track: 'bass', ...EXEC });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Bibliothek nicht angebunden');
    expect(calls).toHaveLength(0);
  });

  it('Ablage-Fehler geht nicht verloren, Ergebnis bleibt erhalten', async () => {
    const { library } = fakeLibrary();
    library.save = vi.fn(async () => {
      throw new Error('R2 down');
    });
    const { runtime } = setup({ library });
    const res = await runtime.invoke('music.extract', { sourceId: 'mix-1', track: 'bass', ...EXEC });
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ libraryId: null, libraryWarning: expect.stringContaining('R2 down') });
  });

  it('erkennt Audio in normierter Worker-Antwort (data:-URI)', () => {
    expect(extractAudioOutput({ items: [{ kind: 'audio', data: 'data:audio/mpeg;base64,SUQz' }] })).toEqual({ audioBase64: 'SUQz', format: 'mp3' });
    expect(extractAudioOutput({ text: 'nope' })).toBeNull();
  });
});

describe('LEGO-P1-001: Kostenbremse', () => {
  it('Ratenbremse je Session (gleitendes Fenster)', () => {
    let now = 0;
    const guard = new MusicContextGuard({ ...resolveMusicContextLimits(), rateMax: 2, rateWindowMs: 1000 }, () => now);
    guard.check('s', 0, 0);
    guard.check('s', 0, 0);
    expect(() => guard.check('s', 0, 0)).toThrow(/MUSIC_CONTEXT_RATE_LIMIT/);
    guard.check('other', 0, 0);
    now = 1500;
    expect(() => guard.check('s', 0, 0)).not.toThrow();
  });

  it('Session-Budget bricht vor dem GPU-Aufruf ab', async () => {
    const runTask = vi.fn(async () => ({ audioBase64: 'x' }));
    const costs = new CostTracker();
    const { library } = fakeLibrary();
    await expect(
      runMusicContextTool('lego', { contextIds: ['drums-1'], track: 'bass', prompt: 'x' }, {
        runTask,
        getLibrary: () => library,
        costs,
        getSessionId: () => 's',
        limits: { ...resolveMusicContextLimits(), sessionBudgetUsd: 0.001 },
      }),
    ).rejects.toThrow(/MUSIC_CONTEXT_BUDGET/);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('Kontext-Audio ueber dem Byte-Limit wird abgelehnt', async () => {
    const runTask = vi.fn(async () => ({}));
    const { library } = fakeLibrary();
    await expect(
      runMusicContextTool('lego', { contextIds: ['drums-1', 'bass-1'], track: 'synth', prompt: 'x' }, {
        runTask,
        getLibrary: () => library,
        costs: new CostTracker(),
        getSessionId: () => 's',
        limits: { ...resolveMusicContextLimits(), maxContextBytes: 1500 },
      }),
    ).rejects.toThrow(/Server-Kontext-Limit/);
    expect(runTask).not.toHaveBeenCalled();
  });
});

describe('LEGO-P1-001: Server-Bibliotheks-Adapter', () => {
  it('loest Server-Ablage-Eintraege auf und speichert ueber den Upload-Pfad', async () => {
    const upload = vi.fn(async (input: { filename: string; fields: Record<string, string> }) => ({
      httpStatus: 200,
      body: { status: 'ok', sample: { id: 'stem-abc', url: `/api/media/uploads/${input.filename}` } },
    }));
    const adapter = createMusicLibraryAdapter({
      getMasterPlayerUrl: () => 'http://mp',
      listSamples: async () => [
        { id: 'drums-1', name: 'Drums', category: 'lows', type: 'stem', url: '/api/media/uploads/drums.wav', description: '', tags: [], parameters: {}, createdAt: '' },
        { id: 'cloud-1', name: 'Cloud', category: 'lows', type: 'stem', url: 'https://r2.example/x.wav', description: '', tags: [], parameters: {}, createdAt: '' },
      ],
      readMedia: async (file) => (file === 'drums.wav' ? Buffer.from('RIFF') : null),
      upload: upload as never,
    });
    expect(await adapter.resolveAudio('drums-1')).toMatchObject({ id: 'drums-1', audioBase64: Buffer.from('RIFF').toString('base64'), bytes: 4 });
    expect(await adapter.resolveAudio('cloud-1')).toBeNull();
    expect(await adapter.resolveAudio('missing')).toBeNull();

    const saved = await adapter.save({ name: 'AI lego bass', audioBase64: 'UklGRg==', format: 'wav', kind: 'stem', tags: ['ai', 'bass'], bpm: 120, key: 'A Minor' });
    expect(saved).toEqual({ id: 'stem-abc', url: '/api/media/uploads/ai-lego-bass.wav' });
    expect(upload.mock.calls[0][0]).toMatchObject({ filename: 'ai-lego-bass.wav', fields: { kind: 'stem', tags: 'ai,bass', bpm: '120', key: 'A Minor' } });
  });

  it('meldet eine gescheiterte Ablage als Fehler', async () => {
    const adapter = createMusicLibraryAdapter({
      getMasterPlayerUrl: () => '',
      upload: (async () => ({ httpStatus: 502, body: { status: 'error', message: 'Supabase-Ablage fehlgeschlagen' } })) as never,
    });
    await expect(adapter.save({ name: 'x', audioBase64: 'AA==', format: 'wav', kind: 'sound', tags: [] })).rejects.toThrow(/Supabase/);
  });
});
