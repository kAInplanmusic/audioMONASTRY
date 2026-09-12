import { describe, expect, it, vi } from 'vitest';
import { WorkletParamBridge, type WorkletParamBridgeDeps } from '../src/audio/workletParamBridge';

// ---------------------------------------------------------------------------
// AUDIO-P1-002: Die Worklet-Parameter-Fassade. Geprüft wird, dass dieselben
// Nachrichten/Spiegelungen wie vorher entstehen – mit Fake-Worklet-Nodes.
// ---------------------------------------------------------------------------

function fakeNode() {
  const postMessage = vi.fn();
  const setValueAtTime = vi.fn();
  return {
    node: { port: { postMessage }, parameters: { get: vi.fn(() => ({ setValueAtTime })) }, connect: vi.fn() } as unknown as AudioWorkletNode,
    postMessage,
    setValueAtTime,
  };
}

function makeDeps(overrides: Partial<WorkletParamBridgeDeps> = {}) {
  const mirrors = {
    dynamics: vi.fn(), fx: vi.fn(), dsp: vi.fn(), mastering: vi.fn(),
  };
  const deps: WorkletParamBridgeDeps = {
    getEffectNode: () => null,
    setEffectNode: vi.fn(),
    getDynamicsNode: () => null,
    getDspNode: () => null,
    getMasteringNode: () => null,
    getEqNode: () => null,
    getGranularNode: () => null,
    getFm6Node: () => null,
    getDrumSynthNode: () => null,
    getRawContext: () => null,
    now: () => 1234,
    mirrorDynamics: mirrors.dynamics,
    mirrorFx: mirrors.fx,
    mirrorDsp: mirrors.dsp,
    mirrorMastering: mirrors.mastering,
    ...overrides,
  };
  return { deps, mirrors };
}

describe('WorkletParamBridge – Nachrichten & Spiegelung', () => {
  it('setDspParam postet an den DSP-Worklet und spiegelt Defaults in den V2-Pfad', () => {
    const dsp = fakeNode();
    const { deps, mirrors } = makeDeps({ getDspNode: () => dsp.node });
    new WorkletParamBridge(deps).setDspParam({ drive: 0.7 });
    expect(dsp.postMessage).toHaveBeenCalledWith({ drive: 0.7 });
    expect(mirrors.dsp).toHaveBeenCalledWith(20000, 0.5, 0, 0.7);
  });

  it('setMasteringParams spiegelt Threshold/Ratio/Makeup/Ceiling', () => {
    const { deps, mirrors } = makeDeps();
    new WorkletParamBridge(deps).setMasteringParams({ threshold: -9, ratio: 4 });
    expect(mirrors.mastering).toHaveBeenCalledWith(-9, 4, 1, 0.98);
  });

  it('setDynamicsParams postet das Objekt und spiegelt den Kompressor', () => {
    const dyn = fakeNode();
    const { deps, mirrors } = makeDeps({ getDynamicsNode: () => dyn.node });
    const params = { enabled: true, compressor: { threshold: -12, ratio: 6, makeup: 2 } };
    new WorkletParamBridge(deps).setDynamicsParams(params);
    expect(dyn.postMessage).toHaveBeenCalledWith(params);
    expect(mirrors.dynamics).toHaveBeenCalledWith(true, -12, 6, 2);
  });

  it('setWorkletParam nutzt AudioParam.setValueAtTime mit der injizierten Zeit', () => {
    const dsp = fakeNode();
    const { deps } = makeDeps({ getDspNode: () => dsp.node });
    new WorkletParamBridge(deps).setWorkletParam('cutoff', 900);
    expect(dsp.node.parameters.get).toHaveBeenCalledWith('cutoff');
    expect(dsp.setValueAtTime).toHaveBeenCalledWith(900, 1234);
  });

  it('flushAutomation routet den Key auf den richtigen Node', () => {
    const effect = fakeNode();
    const eq = fakeNode();
    const { deps } = makeDeps({ getEffectNode: () => effect.node, getEqNode: () => eq.node });
    const bridge = new WorkletParamBridge(deps);
    bridge.flushAutomation('effect:wet', { type: 'automate', value: 0.5 });
    bridge.flushAutomation('eq:3', { type: 'automate', band: 3 });
    expect(effect.postMessage).toHaveBeenCalledWith({ type: 'automate', value: 0.5 });
    expect(eq.postMessage).toHaveBeenCalledWith({ type: 'automate', band: 3 });
  });

  it('lazy-Fallback: erzeugt die effect-Node nur mit rohem Kontext und registriert sie', () => {
    class FakeAudioWorkletNode {
      port = { postMessage: vi.fn() };
      constructor(public ctx: unknown, public name: string) {}
    }
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode as unknown as typeof AudioWorkletNode);
    const created: AudioWorkletNode[] = [];
    const ctx = { createGain: () => ({}) } as unknown as BaseAudioContext;
    const { deps, mirrors } = makeDeps({
      getRawContext: () => ctx,
      setEffectNode: (n) => created.push(n),
    });
    new WorkletParamBridge(deps).setEffectParam({ wet: 0.25 });
    expect(created).toHaveLength(1);
    expect(mirrors.fx).toHaveBeenCalledWith(0.25, 0.6, 0.5, 0.5);
    vi.unstubAllGlobals();
  });

  it('ohne rohen Kontext passiert beim effect-Fallback nichts (kein Throw)', () => {
    const { deps, mirrors } = makeDeps();
    expect(() => new WorkletParamBridge(deps).setEffectParam({ wet: 1 })).not.toThrow();
    expect(mirrors.fx).not.toHaveBeenCalled();
  });

  it('Granular/FM6/DrumSynth posten die erwarteten Nachrichten', () => {
    const gran = fakeNode();
    const fm6 = fakeNode();
    const drum = fakeNode();
    const { deps } = makeDeps({
      getGranularNode: () => gran.node,
      getFm6Node: () => fm6.node,
      getDrumSynthNode: () => drum.node,
    });
    const bridge = new WorkletParamBridge(deps);
    bridge.setGranularParams({ density: 0.5 });
    bridge.fm6NoteOn(440, 0.9);
    bridge.setFm6Gain(0.4);
    bridge.triggerDrumSynth('kick');
    expect(gran.postMessage).toHaveBeenCalledWith({ density: 0.5 });
    expect(fm6.postMessage).toHaveBeenCalledWith({ type: 'noteOn', noteHz: 440, velocity: 0.9 });
    expect(fm6.postMessage).toHaveBeenCalledWith({ type: 'gain', value: 0.4 });
    expect(drum.postMessage).toHaveBeenCalledWith({ type: 'kick' });
  });

  it('Readiness folgt dem connect()-Vorhandensein des Nodes', () => {
    const ready = fakeNode();
    const { deps } = makeDeps({ getFm6Node: () => ready.node });
    const bridge = new WorkletParamBridge(deps);
    expect(bridge.isFm6Ready()).toBe(true);
    expect(bridge.isDrumSynthReady()).toBe(false);
  });
});
