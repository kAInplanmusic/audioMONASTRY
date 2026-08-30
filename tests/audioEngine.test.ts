// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('tone', () => {
  class MockNode {
    volume = { value: 0 };
    pan = { value: 0 };
    frequency = { value: 440 };
    connect() { return this; }
    disconnect() { return this; }
    chain() { return this; }
    start() { return this; }
    stop() { return this; }
    dispose() { return this; }
    set() { return this; }
    triggerAttackRelease() {}
    toDestination() { return this; }
  }
  return {
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
    FeedbackDelay: MockNode,
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
