import { describe, expect, it, vi } from 'vitest';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { SourceNode } from '../src/core/audio/nodes/basicNodes';
import { HqReverbNode, ModMatrixNode } from '../src/core/audio/nodes/optionalDspNodes';
import { V2SinkEngine } from '../src/core/audio/live/V2SinkEngine';
import {
  defaultOptionalDspPreset,
  OPTIONAL_DSP_BLOCKS,
  parseOptionalDspPreset,
  parseOptionalDspPresets,
  serializeOptionalDspPresets,
} from '../src/core/dsp/dspPresets';
import { createPluginAdapters } from '../src/plugins/adapters';
import { audioEngine } from '../src/utils/audioEngine';
import type { IProcessingContext } from '../src/core/audio/types';

// ---------------------------------------------------------------------------
// FEAT-P3-002: Die Bausteine aus FEAT-P3-001 sind jetzt angebunden. Geprüft
// wird die *Wirkung am hörbaren V2-Pfad* (V2SinkEngine = genau die Engine, die
// der v2-sink-processor im AudioWorklet hostet) plus Preset-Schema und Adapter.
// ---------------------------------------------------------------------------

const SR = 48000;
const BLOCK = 128;

function makeCtx(): IProcessingContext {
  return { sampleRate: SR, bufferSize: BLOCK, quantum: BLOCK / SR, currentTime: 0 };
}

function rms(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / Math.max(1, signal.length));
}

function maxAbs(signal: Float32Array): number {
  let m = 0;
  for (let i = 0; i < signal.length; i++) m = Math.max(m, Math.abs(signal[i]));
  return m;
}

/** Rendert `blocks` Blöcke und liefert den RMS je Block. */
function renderRms(engine: V2SinkEngine, blocks: number): number[] {
  const ctx = makeCtx();
  const levels: number[] = [];
  for (let i = 0; i < blocks; i++) {
    const out = engine.render(ctx);
    levels.push(rms(out[0]));
    ctx.currentTime += ctx.quantum;
  }
  return levels;
}

function tone(freq: number, len = BLOCK, sr = SR): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** Führt eine Node über einen echten AudioGraph aus. */
function runNode(node: ModMatrixNode | HqReverbNode, input: Float32Array): Float32Array[] {
  const graph = new AudioGraph();
  const source = new SourceNode('test:src', [input]);
  graph.addNode(source);
  graph.addNode(node);
  graph.connect(source.outputs[0], node.inputs[0]);
  graph.compile();
  graph.process(makeCtx());
  return node.outputs[0].buffer ?? [];
}

// ---------------------------------------------------------------------------
// 1) Hörbarer V2-Pfad: HQ-Reverb
// ---------------------------------------------------------------------------

describe('HQ-Reverb im hörbaren V2-Pfad (FEAT-P3-002)', () => {
  it('lässt nach dem Abschalten des Tons einen messbaren Hall-Tail (nur wenn an)', () => {
    const withReverb = new V2SinkEngine(SR, BLOCK);
    withReverb.setMasterReverb(true, 0.6, 3, 0.2);
    withReverb.setTestTone(true, 440, 0.3);
    renderRms(withReverb, 40);
    withReverb.setTestTone(false);
    const tailWith = renderRms(withReverb, 30).slice(-5);
    const tailRmsWith = tailWith.reduce((a, b) => a + b, 0) / tailWith.length;

    const withoutReverb = new V2SinkEngine(SR, BLOCK);
    withoutReverb.setTestTone(true, 440, 0.3);
    renderRms(withoutReverb, 40);
    withoutReverb.setTestTone(false);
    const tailWithout = renderRms(withoutReverb, 30).slice(-5);
    const tailRmsWithout = tailWithout.reduce((a, b) => a + b, 0) / tailWithout.length;

    expect(tailRmsWith).toBeGreaterThan(0.005);
    expect(tailRmsWithout).toBeLessThan(tailRmsWith / 5);
  });

  it('Bypass (aus) ist bit-transparent', () => {
    const node = new HqReverbNode('reverb');
    node.setEnabled(false);
    node.mix.setValue(0.8);
    const input = tone(440, BLOCK * 4);
    const out = runNode(node, input);
    expect(Array.from(out[0])).toEqual(Array.from(input));
  });
});

// ---------------------------------------------------------------------------
// 2) Hörbarer V2-Pfad: Modulations-Matrix
// ---------------------------------------------------------------------------

describe('Modulations-Matrix im hörbaren V2-Pfad (FEAT-P3-002)', () => {
  it('erzeugt ein hörbares Tremolo, wenn sie eingeschaltet ist', () => {
    const modded = new V2SinkEngine(SR, BLOCK);
    modded.setMasterModMatrix(true, 8, 0.9);
    modded.setTestTone(true, 440, 0.3);
    const withMod = renderRms(modded, 40).slice(15);
    const spreadWith = Math.max(...withMod) - Math.min(...withMod);

    const plain = new V2SinkEngine(SR, BLOCK);
    plain.setTestTone(true, 440, 0.3);
    const without = renderRms(plain, 40).slice(15);
    const spreadWithout = Math.max(...without) - Math.min(...without);

    expect(spreadWith).toBeGreaterThan(0.02);
    expect(spreadWithout).toBeLessThan(spreadWith / 3);
  });

  it('Bypass (aus) ist bit-transparent, eingeschaltet verändert sie das Signal', () => {
    const input = tone(220, BLOCK * 4);
    const off = new ModMatrixNode('mod');
    off.setEnabled(false);
    expect(Array.from(runNode(off, input)[0])).toEqual(Array.from(input));

    const on = new ModMatrixNode('mod');
    on.setEnabled(true);
    on.rate.setValue(6);
    on.depth.setValue(1);
    const changed = runNode(on, input)[0];
    let diff = 0;
    for (let i = 0; i < input.length; i++) diff += Math.abs(changed[i] - input[i]);
    expect(diff).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3) Hörbarer V2-Pfad: optionale Quellen (Phase-Distortion, E-Piano)
// ---------------------------------------------------------------------------

describe('Optionale Quellen im hörbaren V2-Pfad (FEAT-P3-002)', () => {
  it('triggert Phase-Distortion und E-Piano als hörbare V2-Quelle', () => {
    for (const voice of ['phase', 'epiano'] as const) {
      const engine = new V2SinkEngine(SR, BLOCK);
      engine.setSynthSource('channel5', { freq: 220, voice, amount: 0.8, modIndex: 3 });
      const out = engine.render(makeCtx(), [{ track: 'channel5', startSample: 0, velocity: 1, freq: 220 }]);
      expect(maxAbs(out[0]), voice).toBeGreaterThan(0.05);
    }
  });

  it('Phase-Distortion-Tiefe ändert den Klang messbar', () => {
    const renderPhase = (amount: number): Float32Array => {
      const engine = new V2SinkEngine(SR, BLOCK);
      engine.setSynthSource('channel5', { freq: 220, voice: 'phase', amount });
      return engine.render(makeCtx(), [{ track: 'channel5', startSample: 0, velocity: 1, freq: 220 }])[0];
    };
    const sine = renderPhase(0);
    const distorted = renderPhase(0.95);
    let diff = 0;
    for (let i = 0; i < sine.length; i++) diff += Math.abs(sine[i] - distorted[i]);
    expect(diff / sine.length).toBeGreaterThan(0.001);
  });
});

// ---------------------------------------------------------------------------
// 4) Preset-Schema (Persistenz) + Default-Synchronität mit der Engine
// ---------------------------------------------------------------------------

describe('Preset-Schema der optionalen Bausteine (FEAT-P3-002)', () => {
  it('ordnet jeden Baustein einem MONK zu und ist standardmäßig aus', () => {
    expect(OPTIONAL_DSP_BLOCKS['mod-matrix'].monk).toBe('dsp');
    expect(OPTIONAL_DSP_BLOCKS['hq-reverb'].monk).toBe('effect');
    expect(OPTIONAL_DSP_BLOCKS['phase-distortion'].monk).toBe('syntisampler');
    expect(OPTIONAL_DSP_BLOCKS['electric-piano'].monk).toBe('instru');
    for (const block of ['mod-matrix', 'hq-reverb', 'phase-distortion', 'electric-piano'] as const) {
      expect(defaultOptionalDspPreset(block).enabled).toBe(false);
    }
  });

  it('klemmt Werte außerhalb des Bereichs und meldet das', () => {
    const { preset, clamped } = parseOptionalDspPreset({
      block: 'hq-reverb',
      enabled: true,
      params: { mix: 5, decayS: -1, damping: 0.5, sizeScale: 1 },
    });
    expect(preset.params.mix).toBe(1);
    expect(preset.params.decayS).toBe(0.05);
    expect(clamped).toHaveLength(2);
  });

  it('wirft bei unbekanntem Baustein/Parameter (kein stiller Default)', () => {
    expect(() => parseOptionalDspPreset({ block: 'gibt-es-nicht' })).toThrow(/unbekannter DSP-Baustein/);
    expect(() => parseOptionalDspPreset({ block: 'hq-reverb', params: { nope: 1 } })).toThrow(/unbekannter Parameter/);
    expect(() => parseOptionalDspPreset({ block: 'hq-reverb', params: { mix: 'laut' } })).toThrow(/endliche Zahl/);
  });

  it('serialisiert und liest Presets verlustfrei zurück', () => {
    const presets = [
      { block: 'mod-matrix' as const, enabled: true, params: { rate: 1.5, depth: 0.6 } },
      { block: 'phase-distortion' as const, enabled: false, params: { freq: 330, amount: 0.4 } },
    ];
    const json = serializeOptionalDspPresets(presets);
    expect(parseOptionalDspPresets(json)).toEqual(presets);
    expect(() => parseOptionalDspPresets('{kaputt')).toThrow(/kein gültiges JSON/);
  });

  it('Engine-Defaults sind identisch mit dem Schema (keine Drift)', () => {
    const state = audioEngine.getOptionalDspState();
    const mod = defaultOptionalDspPreset('mod-matrix');
    const reverb = defaultOptionalDspPreset('hq-reverb');
    expect(state.modMatrix).toEqual({ enabled: mod.enabled, rate: mod.params.rate, depth: mod.params.depth });
    expect(state.reverb).toEqual({
      enabled: reverb.enabled,
      mix: reverb.params.mix,
      decayS: reverb.params.decayS,
      damping: reverb.params.damping,
      sizeScale: reverb.params.sizeScale,
    });
  });
});

// ---------------------------------------------------------------------------
// 5) Adapter (kanonische MONK-Steuerfläche) reichen an den Audio-Pfad durch
// ---------------------------------------------------------------------------

describe('MONK-Adapter delegieren die optionalen Bausteine (FEAT-P3-002)', () => {
  it('effectMONK → HQ-Reverb', async () => {
    const adapters = createPluginAdapters();
    const spy = vi.spyOn(audioEngine, 'setOptionalReverb').mockImplementation(() => {});
    const result = await adapters.effect.handleCommand({ name: 'optional-dsp', payload: { enabled: true, mix: 0.4, decayS: 4 } });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, mix: 0.4, decayS: 4 }));
    expect(result).toEqual(expect.objectContaining({ block: 'hq-reverb' }));
    spy.mockRestore();
  });

  it('dspMONK → Modulations-Matrix', async () => {
    const adapters = createPluginAdapters();
    const spy = vi.spyOn(audioEngine, 'setOptionalModMatrix').mockImplementation(() => {});
    const result = await adapters.dsp.handleCommand({ name: 'optional-dsp', payload: { enabled: true, rate: 2, depth: 0.5 } });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, rate: 2, depth: 0.5 }));
    expect(result).toEqual(expect.objectContaining({ block: 'mod-matrix' }));
    spy.mockRestore();
  });

  it('syntisamplerMONK → Phase-Distortion-Quelle', async () => {
    const adapters = createPluginAdapters();
    const spy = vi.spyOn(audioEngine, 'setOptionalSynthVoice').mockImplementation(() => true);
    const result = await adapters.syntisampler.handleCommand({
      name: 'optional-voice',
      payload: { channel: 'channel6', freq: 330, amount: 0.7 },
    });
    expect(spy).toHaveBeenCalledWith('channel6', 'phase', 330, { amount: 0.7 });
    expect(result).toEqual(expect.objectContaining({ block: 'phase-distortion' }));
    spy.mockRestore();
  });

  it('instruMONK → E-Piano-Quelle', async () => {
    const adapters = createPluginAdapters();
    const spy = vi.spyOn(audioEngine, 'setOptionalSynthVoice').mockImplementation(() => true);
    const result = await adapters.instru.handleCommand({
      name: 'optional-voice',
      payload: { channel: 'channel4', freq: 440, modIndex: 5 },
    });
    expect(spy).toHaveBeenCalledWith('channel4', 'epiano', 440, { modIndex: 5 });
    expect(result).toEqual(expect.objectContaining({ block: 'electric-piano' }));
    spy.mockRestore();
  });
});
