import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock AudioContext constructor that captures the options passed to it
class MockAudioContext {
  public sampleRate: number;
  public state: AudioContextState = 'suspended';
  constructor(options: AudioContextOptions = {}) {
    console.log('MockAudioContext constructor called with options:', options);
    this.sampleRate = options.sampleRate ?? 44100;
    // ignore latencyHint for simplicity
  }
  resume() { return Promise.resolve(); }
  // minimal destination mock
  get destination() { 
    console.log('destination getter called');
    return {}; 
  }
}

// Mock storage
const storageMock = new Map<string, string>();
const storageGetMock = vi.fn((key: string) => storageMock.get(key) ?? null);
const storageSetMock = vi.fn((key: string, value: string) => {
  storageMock.set(key, value);
});

describe('AUDIO-P1-012 · AudioContext-Optionen', () => {
  beforeEach(() => {
    // Reset all mocks and module cache
    vi.resetModules();
    vi.restoreAllMocks();
    storageMock.clear();
    storageGetMock.mockReset();
    storageSetMock.mockReset();

    // Mock globalThis to have window and AudioContext constructors
    const win = typeof window !== 'undefined' ? window : {};
    // Ensure window is a global variable (for Node.js environment)
    global.window = win as Window & typeof globalThis;
    // Also set on globalThis for completeness
    globalThis.window = win as Window & typeof globalThis;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    win.AudioContext = MockAudioContext;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    win.webkitAudioContext = MockAudioContext;

    // Mock the storage module
    vi.doMock('../src/utils/storage', () => ({
      storageGet: storageGetMock,
      storageSet: storageSetMock,
    }));
  });

  it('setContextOptions speichert die Optionen, solange noch kein Context existiert', async () => {
    const mod = await import('../src/core/audio/compat/nativeAudioKit');
    console.log('After setContextOptions, isContextCreated:', mod.isContextCreated());
    expect(mod.setContextOptions({ sampleRate: 48000, latencyHint: 'playback' })).toBe(true);
    console.log('After setContextOptions call, isContextCreated:', mod.isContextCreated());
    expect(mod.getContextOptions()).toEqual({ sampleRate: 48000, latencyHint: 'playback' });
  });

  it('setContextOptions gibt false, nachdem der Context erzeugt wurde', async () => {
    const mod = await import('../src/core/audio/compat/nativeAudioKit');
    expect(mod.setContextOptions({ sampleRate: 48000 })).toBe(true);
    expect(mod.isContextCreated()).toBe(false);
    // Trigger lazy Context-Erzeugung (Destination-Proxy) by accessing any property
    const _ = mod.Destination.connect; // access a property to trigger proxy get
    console.log('Accessed Destination.connect, isContextCreated now:', mod.isContextCreated());
    expect(mod.isContextCreated()).toBe(true);
    expect(mod.setContextOptions({ sampleRate: 44100 })).toBe(false);
  });

  it('Destination ist ein Proxy, der den Context erst beim Zugriff erzeugt (nicht beim Import)', async () => {
    const mod = await import('../src/core/audio/compat/nativeAudioKit');
    // Vor dem ersten Zugriff: kein Context existiert
    expect(mod.isContextCreated()).toBe(false);
    // Destination ist definiert, aber der Context noch nicht erzeugt
    expect(mod.Destination).toBeDefined();
    expect(mod.isContextCreated()).toBe(false);
    // Erst beim Zugriff auf eine Eigenschaft wird der Context erzeugt
    const _ = (mod.Destination as unknown as { connect: (x: unknown) => unknown }).connect;
    expect(mod.isContextCreated()).toBe(true);
  });

  it('applyAudioContextSettings liest die gespeicherten Einstellungen aus dem localStorage', async () => {
    const mod = await import('../src/core/audio/compat/nativeAudioKit');
    const { applyAudioContextSettings } = await import('../src/utils/audioEngine');

    storageMock.set('audiomonastry_audio_settings', JSON.stringify({
      sampleRate: 48000,
      bufferHint: 'balanced',
    }));

    expect(applyAudioContextSettings()).toBe(true);
    expect(mod.getContextOptions()).toEqual({ sampleRate: 48000, latencyHint: 'balanced' });
  });

  it('applyAudioContextSettings ignoriert ungültige Werte und ist idempotent', async () => {
    const mod = await import('../src/core/audio/compat/nativeAudioKit');
    const { applyAudioContextSettings } = await import('../src/utils/audioEngine');

    storageMock.set('audiomonastry_audio_settings', JSON.stringify({
      sampleRate: -1,
      bufferHint: 'unknown',
    }));

    expect(applyAudioContextSettings()).toBe(true);
    // Keine ungültigen Optionen wurden gespeichert
    expect(mod.getContextOptions()).toEqual({});
  });

  it('getContextOptions und isContextCreated sind für Diagnose/Tests nutzbar', async () => {
    const mod = await import('../src/core/audio/compat/nativeAudioKit');
    expect(mod.isContextCreated()).toBe(false);
    expect(mod.getContextOptions()).toEqual({});
    expect(mod.getContextOptions().sampleRate).toBeUndefined();
  });
  it('RT-AUDIT-P1-012: nach der Erzeugung bleibt der Wunsch sichtbar, aktiv bleiben die echten Werte', async () => {
    const mod = await import('../src/core/audio/compat/nativeAudioKit');
    expect(mod.activeAudioContextInfo()).toBeNull();
    mod.setContextOptions({ sampleRate: 48000, latencyHint: 'interactive' });
    void (mod.Destination as unknown as { connect: unknown }).connect; // Context erzeugen
    expect(mod.activeAudioContextInfo()).toMatchObject({ sampleRate: 48000, latencyHint: 'interactive', optionsRejected: false });
    // Änderung nach der Erzeugung: Rückgabe false, Wunsch gemerkt, aktiver Context unverändert.
    expect(mod.setContextOptions({ sampleRate: 96000, latencyHint: 'playback' })).toBe(false);
    expect(mod.getContextOptions()).toEqual({ sampleRate: 96000, latencyHint: 'playback' });
    expect(mod.activeAudioContextInfo()).toMatchObject({ sampleRate: 48000, latencyHint: 'interactive' });
  });

  it('RT-AUDIT-P1-012: sampleRate undefined heißt Gerätestandard (Schlüssel entfällt)', async () => {
    const mod = await import('../src/core/audio/compat/nativeAudioKit');
    mod.setContextOptions({ sampleRate: 48000 });
    mod.setContextOptions({ sampleRate: undefined, latencyHint: 'balanced' });
    expect(mod.getContextOptions()).toEqual({ latencyHint: 'balanced' });
  });

  it('RT-AUDIT-P1-012: configureContext ist der kanonische Name und reicht die Optionen an den Konstruktor', async () => {
    const captured: AudioContextOptions[] = [];
    class CapturingCtx {
      sampleRate = 96000;
      state: AudioContextState = 'suspended';
      constructor(options: AudioContextOptions = {}) { captured.push(options); }
      resume() { return Promise.resolve(); }
      get destination() { return {}; }
    }
    (globalThis as unknown as { window: { AudioContext?: unknown } }).window.AudioContext = CapturingCtx as unknown as typeof AudioContext;
    const mod = await import('../src/core/audio/compat/nativeAudioKit');
    expect(mod.configureContext({ sampleRate: 96000, latencyHint: 'playback' })).toBe(true);
    // Erst der Zugriff erzeugt den Context – mit genau diesen Optionen.
    void (mod.Destination as unknown as { connect: unknown }).connect;
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ sampleRate: 96000, latencyHint: 'playback' });
  });

  it('RT-AUDIT-P1-012: Latenz-Budget = base + output + echter Mastering-Lookahead (kein Phantom)', async () => {
    const { audioEngine } = await import('../src/utils/audioEngine');
    const budget = audioEngine.getLatencyBudgetMs();
    const health = audioEngine.getAudioHealth();
    // Zusammensetzung exakt nachvollziehbar (kein zweiter, fester 5-ms-Aufschlag).
    expect(budget.totalMs).toBeCloseTo(
      health.baseLatencyMs + health.outputLatencyMs + budget.masteringLookaheadMs,
      9,
    );
    // Der ausgewiesene Lookahead ist die ECHTE MasteringNode-Latenz (≈ 5 ms @48 kHz).
    expect(budget.masteringLookaheadMs).toBeCloseTo((240 / 48000) * 1000, 3);
    expect(budget.cuePdcMs).toBe(budget.masteringLookaheadMs);
  });
});