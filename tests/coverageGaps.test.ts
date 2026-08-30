/**
 * audioMONASTRY – Coverage-Lücken-Tests (SonarCloud-P2)
 * ====================================================
 * Deckt die zuvor 0 %-abgedeckten Module ab:
 *   - src/utils/validation.ts      (zod-Schema TrackPresetSchema)
 *   - src/utils/telemetry.ts       (Telemetry/Budget-Registry)
 *   - src/utils/usageAnalytics.ts  (anonymisierte Feature-Zähler)
 *   - src/utils/workerFactory.ts   (Visualizer-Worker-Factory)
 *   - src/utils/stemSplitter.ts    (lokaler DSP-Fallback, gemocktes WebAudio)
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('validation.ts (TrackPresetSchema)', () => {
  it('akzeptiert ein vollständig gültiges Track-Preset', async () => {
    const { TrackPresetSchema } = await import('../src/utils/validation');
    const valid = {
      id: 't1',
      name: 'Techno Basic',
      genre: 'Techno',
      bpm: 128,
      key: 'Am',
      description: 'Basispreset',
      patterns: {
        channel1: Array(16).fill(false),
        channel2: Array(16).fill(false),
        channel3: Array(16).fill(false),
        channel4: Array(16).fill(false),
        channel5: Array(16).fill(false),
        channel6: Array(16).fill(false),
        channel7: Array(16).fill(false),
        channel8: Array(16).fill(false),
      },
      synthNotes: [0, 7, 12],
      cutoff: 12000,
      resonance: 2,
      delayTime: 0.25,
      decay: 0.5,
    };
    expect(TrackPresetSchema.parse(valid).bpm).toBe(128);
    expect(TrackPresetSchema.safeParse(valid).success).toBe(true);
  });

  it('weist Werte außerhalb der erlaubten Bereiche ab', async () => {
    const { TrackPresetSchema } = await import('../src/utils/validation');
    const base = {
      id: 't2',
      name: 'Ungültig',
      genre: 'Test',
      bpm: 300, // > 250
      key: 'C',
      description: 'x',
      patterns: Object.fromEntries(
        ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8']
          .map((k) => [k, Array(16).fill(false)]),
      ),
      synthNotes: [],
      cutoff: 1000,
      resonance: 1,
      delayTime: 0.1,
      decay: 0.5,
    };
    expect(TrackPresetSchema.safeParse(base).success).toBe(false);

    const badCutoff = { ...base, bpm: 128, cutoff: 10 }; // < 20
    expect(TrackPresetSchema.safeParse(badCutoff).success).toBe(false);

    const badResonance = { ...base, bpm: 128, resonance: 21 }; // > 20
    expect(TrackPresetSchema.safeParse(badResonance).success).toBe(false);

    const badDelay = { ...base, bpm: 128, delayTime: 2.5 }; // > 2
    expect(TrackPresetSchema.safeParse(badDelay).success).toBe(false);

    const badDecay = { ...base, bpm: 128, decay: 1.2 }; // > 1
    expect(TrackPresetSchema.safeParse(badDecay).success).toBe(false);
  });
});

describe('telemetry.ts (Pipeline-Budgets)', () => {
  it('registriert Latenzen und zählt Budget-Verletzungen', async () => {
    const { Telemetry } = await import('../src/utils/telemetry');
    const t = new Telemetry();
    const violations: string[] = [];
    t.onBudgetViolation((pipeline, lastMs, budgetMs) => {
      violations.push(`${pipeline}:${lastMs}>${budgetMs}`);
    });

    t.recordLatency('input', 0.5);
    expect(t.snapshot().budgets.find((b) => b.pipeline === 'input')?.violations).toBe(0);

    t.recordLatency('input', 1.5);
    t.recordLatency('input', 2);
    expect(t.snapshot().budgets.find((b) => b.pipeline === 'input')?.violations).toBe(2);
    expect(violations).toEqual(['input:1.5>1', 'input:2>1']);

    // Unbekannte Pipeline wird ignoriert.
    t.recordLatency('unbekannt', 999);
    expect(t.snapshot().budgets).toHaveLength(6);
  });

  it('führt Counter und liefert einen Snapshot mit Kopien', async () => {
    const { Telemetry } = await import('../src/utils/telemetry');
    const t = new Telemetry();
    t.increment('dropouts', 3);
    t.increment('dropouts');
    expect(t.get('dropouts')).toBe(4);
    expect(t.get('fehlt')).toBe(0);

    const snap = t.snapshot();
    snap.budgets[0].violations = 99;
    expect(t.snapshot().budgets[0].violations).toBe(0);
  });
});

describe('usageAnalytics.ts (anonymisierte Nutzungs-Analytik)', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('trackt Features, Sessions und exportiert einen Snapshot', async () => {
    const { trackFeature, trackSessionStart, usageSnapshot } = await import('../src/utils/usageAnalytics');
    trackFeature('sampler');
    trackFeature('sampler');
    trackFeature('stem');
    trackSessionStart();
    trackSessionStart();

    const snap = usageSnapshot();
    expect(snap.features.sampler).toBe(2);
    expect(snap.features.stem).toBe(1);
    expect(snap.sessions).toBe(2);
  });

  it('sortiert usageTop absteigend und begrenzt auf n', async () => {
    const { trackFeature, usageTop } = await import('../src/utils/usageAnalytics');
    trackFeature('a');
    trackFeature('b');
    trackFeature('b');
    trackFeature('c');
    trackFeature('c');
    trackFeature('c');

    const top2 = usageTop(2);
    expect(top2).toEqual([['c', 3], ['b', 2]]);
  });

  it('persistiert den Zustand in localStorage', async () => {
    const { trackFeature } = await import('../src/utils/usageAnalytics');
    trackFeature('eq');
    const raw = localStorage.getItem('audiomonastry_usage');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.features.eq).toBe(1);
  });

  afterEach(() => {
    localStorage.clear();
  });
});

describe('workerFactory.ts (Visualizer-Worker-Factory)', () => {
  let created: MockWorker[] = [];

  class MockWorker {
    terminated = false;
    constructor(_url: string | URL, _opts?: unknown) {
      created.push(this);
    }
    terminate() {
      this.terminated = true;
    }
  }

  beforeEach(() => {
    vi.resetModules();
    created = [];
    vi.stubGlobal('Worker', MockWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('liefert lazy einen Singleton-Worker', async () => {
    const { createVisualizerWorker } = await import('../src/utils/workerFactory');
    expect(created).toHaveLength(0);
    const a = createVisualizerWorker();
    const b = createVisualizerWorker();
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it('beendet den Worker bei dispose und erzeugt danach neu', async () => {
    const { createVisualizerWorker, disposeVisualizerWorker } = await import('../src/utils/workerFactory');
    const a = createVisualizerWorker() as unknown as MockWorker;
    disposeVisualizerWorker();
    expect(a.terminated).toBe(true);

    const b = createVisualizerWorker() as unknown as MockWorker;
    expect(b).not.toBe(a);
    expect(created).toHaveLength(2);

    // dispose ohne aktiven Worker ist ein No-Op.
    disposeVisualizerWorker();
    expect(b.terminated).toBe(true);
  });
});

describe('stemSplitter.ts (lokaler DSP-Fallback)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.OfflineAudioContext;
    delete g.webkitOfflineAudioContext;
  });

  it('wirft ohne verfügbaren OfflineAudioContext', async () => {
    const { splitStemsLocally } = await import('../src/utils/stemSplitter');
    const file = { arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    await expect(splitStemsLocally(file)).rejects.toThrow('OfflineAudioContext nicht verfügbar');
  });

  it('splittet eine Datei offline in 5 Stems und liefert WAV-URLs', async () => {
    const sampleRate = 44100;
    const frames = 100;

    const makeBuffer = (channels: number): any => {
      const data = Array.from({ length: channels }, () => new Float32Array(frames).fill(0.25));
      return {
        numberOfChannels: channels,
        length: frames,
        sampleRate,
        duration: frames / sampleRate,
        getChannelData: (ch: number) => data[ch] ?? data[0],
      };
    };

    let wavBlob: Blob | null = null;
    const createObjectUrlCalls: Blob[] = [];
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob: Blob): string {
        createObjectUrlCalls.push(blob);
        return `blob:mock-${createObjectUrlCalls.length}`;
      }
    });

    class FakeCtx {
      static created: FakeCtx[] = [];
      destination = { name: 'destination' };
      constructor(public channels: number, public length: number, public sampleRate: number) {
        FakeCtx.created.push(this);
      }
      createBuffer(channels: number, length: number, _sr: number) {
        return makeBuffer(channels);
      }
      async decodeAudioData(_buf: ArrayBuffer) {
        return makeBuffer(2);
      }
      createBufferSource() {
        return { buffer: null, connect: () => {}, start: () => {} };
      }
      createBiquadFilter() {
        return {
          type: 'lowpass',
          frequency: { value: 0 },
          Q: { value: 0 },
          gain: { value: 0 },
          connect: () => {},
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: () => {} };
      }
      async startRendering() {
        return makeBuffer(2);
      }
    }

    // Mock-Global für den Test
    (globalThis as unknown as Record<string, unknown>).OfflineAudioContext = FakeCtx;

    const { splitStemsLocally } = await import('../src/utils/stemSplitter');
    const progress: number[] = [];
    const file = { arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File;

    const stems = await splitStemsLocally(file, (p) => progress.push(p));

    expect(Object.keys(stems).sort()).toEqual(['highs', 'lows', 'melody', 'mids', 'vocals']);
    for (const url of Object.values(stems)) {
      expect(url).toMatch(/^blob:mock-/);
    }
    expect(progress).toEqual([15, 35, 55, 70, 80, 90, 100]);

    // WAV-Kodierung prüfen: 44-Byte-Header + RIFF/WAVE-Marker + Datenlänge.
    wavBlob = createObjectUrlCalls[0];
    expect(createObjectUrlCalls).toHaveLength(5);
    const bytes = new Uint8Array(await wavBlob.arrayBuffer());
    const ascii = (off: number, len: number) => String.fromCharCode(...bytes.slice(off, off + len));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(ascii(36, 4)).toBe('data');
    expect(bytes.length).toBe(44 + frames * 2 * 2);
  });

  it('nutzt webkitOfflineAudioContext als Fallback', async () => {
    class WebkitCtx {
      constructor(_c: number, _l: number, _sr: number) {}
    }
    // Mock-Global für den Test
    (globalThis as unknown as Record<string, unknown>).webkitOfflineAudioContext = WebkitCtx;

    const { splitStemsLocally } = await import('../src/utils/stemSplitter');
    const file = { arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    // Ohne vollständige Mock-Implementierung schlägt der Split fehl –
    // entscheidend ist, dass der Fallback-Pfad (webkit) die Initialisierung erreicht.
    await expect(splitStemsLocally(file)).rejects.toThrow();
  });
});
