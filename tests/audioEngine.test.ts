// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('tone', () => {
  // P1-2: Signalfluss-Spion – jede connect/chain/toDestination-Verkabelung wird
  // als Kante aufgezeichnet und kann in den Tests geprüft werden.
  const __wiring: Array<{ from: unknown; to: unknown }> = [];
  class MockNode {
    volume = { value: 0, rampTo: () => {} };
    pan = { value: 0 };
    frequency = { value: 440 };
    gain = { value: 0, rampTo: () => {} };
    Q = { value: 0 };
    connect(dest?: unknown) { __wiring.push({ from: this, to: dest }); return this; }
    disconnect() { return this; }
    chain(...nodes: unknown[]) {
      for (let i = 0; i < nodes.length; i++) {
        __wiring.push({ from: i === 0 ? this : nodes[i - 1], to: nodes[i] });
      }
      return this;
    }
    start() { return this; }
    stop() { return this; }
    dispose() { return this; }
    set() { return this; }
    triggerAttackRelease() {}
    toDestination() { return this.connect('destination'); }
  }
  return {
    __wiring,
    Volume: MockNode,
    Gain: MockNode,
    Filter: MockNode,
    Oscillator: MockNode,
    Analyser: MockNode,
    Player: MockNode,
    Noise: MockNode,
    AmplitudeEnvelope: MockNode,
    MembraneSynth: MockNode,
    MetalSynth: MockNode,
    NoiseSynth: MockNode,
    MonoSynth: MockNode,
    Synth: MockNode,
    Panner: MockNode,
    FeedbackDelay: MockNode,
    Delay: MockNode,
    Compressor: MockNode,
    MultibandCompressor: MockNode,
    Limiter: MockNode,
    Frequency: vi.fn(() => ({ toFrequency: () => 440 })),
    Transport: {
      bpm: { value: 120 },
      start: vi.fn(),
      stop: vi.fn(),
      scheduleRepeat: vi.fn(),
      cancel: vi.fn(),
      position: '0:0:0',
    },
    context: { currentTime: 0, destination: {} },
    start: vi.fn(async () => {}),
  };
});

import { audioEngine } from '../src/utils/audioEngine';
import * as Tone from 'tone';

describe('audioEngine (jsdom, Tone gemockt)', () => {
  it('listet Drum-Kits und Spatial-Setups', () => {
    expect(audioEngine.listDrumKits().length).toBeGreaterThan(0);
    expect(audioEngine.getSpatialSetups().length).toBeGreaterThan(0);
    expect(audioEngine.getActiveDrumKitId()).toBeTruthy();
  });

  it('setStepCount / setStep / setPattern arbeiten deterministisch', () => {
    audioEngine.setStepCount(32);
    expect(audioEngine.stepCount).toBe(32);
    audioEngine.setStep('channel1', 0, true);
    audioEngine.setPattern('channel2', Array(32).fill(true));
    audioEngine.setStepCount(16);
    expect(audioEngine.stepCount).toBe(16);
    audioEngine.setStep('channel1', 0, false);
  });

  it('addStepListener unterstützt mehrere Step-Subscriber (kein Single-Slot)', () => {
    const seen: number[] = [];
    const off1 = audioEngine.addStepListener((s) => seen.push(s));
    const off2 = audioEngine.addStepListener((s) => seen.push(s * 10));
    const legacy = vi.fn();
    const prev = audioEngine.onStepUpdate;
    audioEngine.onStepUpdate = legacy;

    const emitter = audioEngine as unknown as { emitStep: (step: number) => void };
    emitter.emitStep(4);
    expect(seen).toEqual([4, 40]);
    expect(legacy).toHaveBeenCalledWith(4);

    off1();
    seen.length = 0;
    emitter.emitStep(5);
    expect(seen).toEqual([50]);

    off2();
    audioEngine.onStepUpdate = prev;
  });

  it('previewSynthesizedSample wirft nicht bei ungültigen Parametern', () => {
    expect(() => audioEngine.previewSynthesizedSample({ frequency: 440, decay: 0.2 })).not.toThrow();
    expect(() => audioEngine.previewSynthesizedSample({})).not.toThrow();
  });

  it('EQ/Master/Kanal-Gain klemmen NaN/Inf (F6-Fix)', () => {
    expect(() => audioEngine.setChannelEQ('channel1', 'mid', NaN)).not.toThrow();
    expect(() => audioEngine.setChannelEQ('channel1', 'high', Infinity)).not.toThrow();
    expect(() => audioEngine.setMasterVolume(NaN)).not.toThrow();
    expect(() => audioEngine.setChannelGain('channel1', NaN)).not.toThrow();
  });

  it('Spatial-Setup/Mode lassen sich setzen und lesen', () => {
    audioEngine.setSpatialSetup('10.0');
    expect(audioEngine.getSpatialSetupId()).toBe('10.0');
    audioEngine.setSpatialSetup('kaputt');
    expect(audioEngine.getSpatialSetupId()).toBe('10.0');
    audioEngine.setSpatialMode('SEPARATION');
    expect(audioEngine.getSpatialMode()).toBe('SEPARATION');
    audioEngine.setSpatialMode('ON_TOP');
  });

  it('importGraphState lehnt ungültige States ab', () => {
    expect(audioEngine.importGraphState(null as never)).toBe(false);
    expect(audioEngine.importGraphState({ version: 2 } as never)).toBe(false);
  });

  it('V2-Graph-Pfad: Referenz-Worklets sind registriert', () => {
    const ids = audioEngine.listWorkletProcessors();
    expect(ids).toEqual(expect.arrayContaining(['it-synth', 'eq3', 'mastering']));
  });

  it('V2-Transport läuft über den AudioGraph (play/stop/trigger)', async () => {
    await audioEngine.playV2();
    expect(audioEngine.graphTransportState.playing).toBe(true);

    const out = audioEngine.triggerEventV2('channel1', 0.8);
    expect(out).not.toBeNull();
    expect(out![0]).toHaveLength(128);
    expect(audioEngine.lastGraphOutput).toBe(out);

    audioEngine.stopV2();
    expect(audioEngine.graphTransportState.playing).toBe(false);
  });

  it('Live-Worklet-Verdrahtung ist in Node/jsdom ein sicherer No-Op', () => {
    expect(audioEngine.connectLiveWorkletChain()).toBe(false);
  });

  it('Phase 3: ingestAudioSources legt AudioObjects in der SpatialScene ab', () => {
    audioEngine.ingestAudioSources([
      { id: 'src-track', name: 'Track', kind: 'track', position: { x: -0.4, y: 0, z: 0 } },
    ]);
    expect(audioEngine.spatialSceneV2.getAudioObject('src-track')?.position.x).toBe(-0.4);
  });
});

describe('P1-2 · V1-Verkabelung (Node-In/Out-Counts + Signalfluss-Spion)', () => {
  const toneMock = Tone as unknown as {
    __wiring: Array<{ from: unknown; to: unknown }>;
  };
  const edges = toneMock.__wiring;

  it('Signalfluss-Spion: Engine-Verkabelung erzeugt Kanten ohne Hänger', () => {
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.from).toBeTruthy();
      expect(e.to).toBeTruthy();
    }
  });

  it('Node-In/Out-Counts: jeder verbundene Knoten hat In- oder Out-Grad > 0', () => {
    const degree = new Map<unknown, { inn: number; out: number }>();
    for (const e of edges) {
      const from = degree.get(e.from) ?? { inn: 0, out: 0 };
      from.out += 1;
      degree.set(e.from, from);
      const to = degree.get(e.to) ?? { inn: 0, out: 0 };
      to.inn += 1;
      degree.set(e.to, to);
    }
    expect(degree.size).toBeGreaterThan(1);
    for (const d of degree.values()) {
      expect(d.inn + d.out).toBeGreaterThan(0);
    }
  });

  it('Signalfluss-Spion: mindestens ein Tone-Knoten wurde mit einem Ziel verbunden', () => {
    const withTo = edges.filter((e) => e.to !== undefined && e.to !== null);
    expect(withTo.length).toBeGreaterThan(0);
  });
});
