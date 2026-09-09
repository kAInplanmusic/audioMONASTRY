import { describe, expect, it, vi } from 'vitest';
import {
  initialPlaybackMode, isV1PlaybackAllowed, isV2PlaybackAllowed, resolvePlaybackMode,
} from '../src/utils/v2FeatureFlags';
import { V2TerminalBridge, type V2TerminalEngine } from '../src/core/audio/compat/V2TerminalBridge';
import { planMonitorRouting } from '../src/core/audio/monitorRouting';

describe('Phase 9 · V2-only Feature-Flags (V1-Cutover)', () => {
  it('startet ohne Flag in v2 (V1 existiert nicht mehr)', () => {
    expect(initialPlaybackMode({})).toBe('v2');
  });

  it('VITE_V2_AUDIO_MODE=v2 bleibt der einzige gültige Modus', () => {
    expect(initialPlaybackMode({ VITE_V2_AUDIO_MODE: 'v2' })).toBe('v2');
    expect(initialPlaybackMode({ VITE_V2_AUDIO_MODE: '1' })).toBe('v2');
  });

  it('V1 ist nach Phase 9 nie erlaubt; resolvePlaybackMode erzwingt v2', () => {
    expect(isV1PlaybackAllowed({})).toBe(false);
    expect(isV1PlaybackAllowed({ VITE_V2_AUDIO_ONLY: '0' })).toBe(false);
    expect(isV2PlaybackAllowed({})).toBe(true);
    expect(resolvePlaybackMode('v2', {})).toBe('v2');
  });

  it('resolvePlaybackMode fällt bei jedem Wunschmodus auf v2 zurück', () => {
    expect(resolvePlaybackMode('v2', { VITE_V2_AUDIO_MODE: 'v1' })).toBe('v2');
  });
});

describe('Phase 7 · V2TerminalBridge (zentrale Terminal-/Plugin-Bridge)', () => {
  function makeEngine(): V2TerminalEngine & { syncCalls: number; calls: string[] } {
    const engine: V2TerminalEngine & { syncCalls: number; calls: string[] } = {
      playbackMode: 'v2',
      syncCalls: 0,
      calls: [],
      setPlaybackMode: vi.fn((mode: 'v2') => { engine.playbackMode = mode; }),
      syncV2FromV1: vi.fn(() => { engine.syncCalls++; }),
      play: vi.fn(async () => { engine.calls.push('play'); }),
      stop: vi.fn(() => { engine.calls.push('stop'); }),
      triggerEvent: vi.fn(() => { engine.calls.push('trigger'); }),
      setStep: vi.fn(() => { engine.calls.push('step'); }),
      setPattern: vi.fn(() => { engine.calls.push('pattern'); }),
      setBpm: vi.fn(() => { engine.calls.push('bpm'); }),
      setSwing: vi.fn(() => { engine.calls.push('swing'); }),
      setChannelGain: vi.fn(() => { engine.calls.push('gain'); }),
      setChannelPan: vi.fn(() => { engine.calls.push('pan'); }),
      setMasterVolume: vi.fn(() => { engine.calls.push('master'); }),
      setMonitorSource: vi.fn(() => { engine.calls.push('monitor'); }),
    };
    return engine;
  }

  it("setMode('v2') schaltet um und synchronisiert den V2-Graph", () => {
    const engine = makeEngine();
    const bridge = new V2TerminalBridge(engine);
    bridge.setMode('v2');
    expect(bridge.mode).toBe('v2');
    expect(engine.setPlaybackMode).toHaveBeenCalledWith('v2');
    expect(engine.syncCalls).toBe(1);
  });

  it('Terminal-Aktionen synchronisieren im V2-Modus vor jedem Zugriff', () => {
    const engine = makeEngine();
    engine.playbackMode = 'v2';
    const bridge = new V2TerminalBridge(engine);

    void bridge.play();
    bridge.setChannelGain('channel1', 0.8);
    bridge.setChannelPan('channel1', -0.5);
    bridge.setMasterVolume(1);
    bridge.triggerEvent('channel2', 0.9);

    expect(engine.syncCalls).toBeGreaterThanOrEqual(4);
    expect(engine.calls).toEqual(expect.arrayContaining(['play', 'gain', 'pan', 'master', 'trigger']));
  });

  it('setMonitorRouting reicht den Plan an die Engine durch', () => {
    const engine = makeEngine();
    const bridge = new V2TerminalBridge(engine);
    const plan = planMonitorRouting({ source: 'PLUGIN', mon: 'MON1', track: 'channel4', baseMix: {} });
    bridge.setMonitorRouting(plan);
    expect(engine.calls).toContain('monitor');
    expect(engine.setMonitorSource).toHaveBeenCalledWith('PLUGIN', 'MON1', 'channel4');
  });
});
