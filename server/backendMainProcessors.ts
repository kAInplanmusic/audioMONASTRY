import { DspFilterNode, EffectNode, ParametricEqNode } from '../src/core/audio/nodes/processingNodes';
import { AudioPort } from '../src/core/audio/AudioGraph';
import type { IProcessingContext } from '../src/core/audio/types';

export type ProcessorPlugin = 'eq' | 'dsp' | 'effect' | 'spatial' | 'mixer' | 'master';
export interface ProcessorConfig { active: boolean; parameters: Record<string, unknown>; epoch: string | number }
export type ProcessorSnapshot = Partial<Record<ProcessorPlugin, ProcessorConfig>>;
export type MainProcessorSnapshot = ProcessorSnapshot;
type Node = ParametricEqNode | DspFilterNode | EffectNode;
type Stereo = [Float32Array, Float32Array];
export interface ProcessorStageReport { active: boolean; inputEnergy: number; outputEnergy: number; returnEnergy?: number }
export interface ProcessorReport { stages: Record<ProcessorPlugin, ProcessorStageReport>; sourceIds: string[] }
const energy = (channels: [Float32Array | Float64Array, Float32Array | Float64Array]): number => { let sum = 0; for (let ch = 0; ch < 2; ch++) { const channel = channels[ch]; for (let i = 0; i < channel.length; i++) { const value = channel[i]; sum += value * value; } } return sum; };
const blockEnergy = (samples: Float32Array): number => { let sum = 0; for (let i = 0; i < samples.length; i++) { const value = samples[i]; sum += value * value; } return sum; };

const number = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/**
 * R16: fixed twelve-band master EQ on the finished backend sum. The frequencies and
 * Q values are the existing masterMONK preset ("techno_club.tone_shift"), so the
 * backend applies exactly what the operator already knows from the rack; only the
 * gains are session settings. Every band is peaking unless it is a shelf.
 */
export const MASTER_EQ_BANDS: readonly { freq: number; q: number; type: 'peaking' | 'lowshelf' | 'highshelf' }[] = [
  { freq: 40, q: 1.5, type: 'lowshelf' },
  { freq: 80, q: 2.0, type: 'peaking' },
  { freq: 150, q: 2.5, type: 'peaking' },
  { freq: 300, q: 2.0, type: 'peaking' },
  { freq: 500, q: 1.0, type: 'peaking' },
  { freq: 1000, q: 1.5, type: 'peaking' },
  { freq: 2500, q: 2.0, type: 'peaking' },
  { freq: 4000, q: 1.5, type: 'peaking' },
  { freq: 8000, q: 1.0, type: 'highshelf' },
  { freq: 12000, q: 1.0, type: 'highshelf' },
  { freq: 16000, q: 1.0, type: 'peaking' },
  { freq: 20000, q: 1.0, type: 'peaking' },
];
const MASTER_EQ_SPECS = MASTER_EQ_BANDS.map((band, index) => ({ id: `b${index}`, type: band.type, freq: band.freq, q: band.q }));
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stereo = (length: number): Stereo => [new Float32Array(length), new Float32Array(length)];
const targeted = (params: Record<string, unknown>, id: string): boolean => !Array.isArray(params.targets) || params.targets.length === 0 || params.targets.includes(id);

/**
 * P1 classification: EQ and the spatial matrix are linear for fixed settings;
 * DSP can be nonlinear (envelope/drive), and EffectNode includes quantization,
 * feedback and modulation. Process each send bus once: F(sum sends) - sum sends.
 * The subtraction uses the exact aligned input block, so both dry and return
 * paths have zero additional sample offset; intentional effect delays remain.
 */
export class BackendMainProcessors {
  private readonly perSource = new Map<string, { eq: ParametricEqNode; dsp: DspFilterNode }>();
  private effect = new EffectNode('backend-effect');
  private masterEq = new ParametricEqNode('backend-master-eq', MASTER_EQ_SPECS);
  private masterEqBus: Stereo = stereo(0);
  private signatures = new Map<ProcessorPlugin, string>();
  private frames = 0;
  private scratchLength = -1;
  private dry: [Float64Array, Float64Array] = [new Float64Array(0), new Float64Array(0)];
  private effectBus: Stereo = stereo(0);
  private spatialBus: Stereo = stereo(0);
  private readonly sourceScratch = new Map<string, Stereo>();
  private readonly rampScratch = new Map<string, Float32Array>();
  private readonly runScratch = new WeakMap<Node, { port: AudioPort; ctx: IProcessingContext }>();
  private readonly lastConfigs = new Map<ProcessorPlugin, ProcessorConfig>();
  private readonly ramps = new Map<string, { value: number; target: number; remaining: number }>();
  private ramp(key: string, target: number, length: number): Float32Array {
    let state = this.ramps.get(key);
    if (!state) { state = { value: target, target, remaining: 0 }; this.ramps.set(key, state); }
    if (state.target !== target) { state.target = target; state.remaining = Math.max(1, Math.round(this.sampleRate * 0.005)); }
    let result = this.rampScratch.get(key);
    if (!result || result.length !== length) { result = new Float32Array(length); this.rampScratch.set(key, result); }
    for (let i = 0; i < length; i++) {
      if (state.remaining > 0) { state.value += (state.target - state.value) / state.remaining; state.remaining--; }
      result[i] = state.value;
    }
    return result;
  }
  lastReport: ProcessorReport = { stages: Object.fromEntries(['eq', 'dsp', 'effect', 'spatial', 'mixer', 'master'].map(id => [id, { active: false, inputEnergy: 0, outputEnergy: 0 }])) as Record<ProcessorPlugin, ProcessorStageReport>, sourceIds: [] };

  constructor(private readonly sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('Invalid sample rate');
  }

  process(sources: Map<string, Float32Array>, snapshot: ProcessorSnapshot, frames = 0): Float32Array {
    for (const plugin of ['eq', 'dsp', 'effect', 'spatial', 'mixer', 'master'] as const) {
      const config = snapshot[plugin];
      if (config) this.lastConfigs.set(plugin, config);
      const signature = JSON.stringify([!!config?.active, config?.epoch ?? null]);
      if (this.signatures.get(plugin) !== signature) {
        if (plugin === 'effect') this.effect = new EffectNode('backend-effect');
        if (plugin === 'master') this.masterEq = new ParametricEqNode('backend-master-eq', MASTER_EQ_SPECS);
        if (plugin === 'eq' || plugin === 'dsp') {
          for (const [id, pair] of this.perSource) {
            if (plugin === 'eq') pair.eq = new ParametricEqNode(`backend-eq-${id}`);
            else pair.dsp = new DspFilterNode(`backend-dsp-${id}`);
          }
        }
        this.signatures.set(plugin, signature);
      }
    }
    let length = 0;
    for (const samples of sources.values()) {
      if (samples.length % 2) throw new RangeError('Stereo blocks must contain complete frames');
      if (length && samples.length !== length) throw new RangeError('Source blocks must be aligned');
      length = samples.length;
    }
    if (sources.size === 0) length = frames * 2;
    const stages = Object.fromEntries((['eq', 'dsp', 'effect', 'spatial', 'mixer', 'master'] as const).map(id => [id, { active: !!snapshot[id]?.active, inputEnergy: 0, outputEnergy: 0 }])) as Record<ProcessorPlugin, ProcessorStageReport>;
    const n = length / 2;
    // Float32 DSP blocks; double-precision accumulator preserves neutral PCM24 cancellation with headroom.
    if (this.scratchLength !== n) {
      this.scratchLength = n;
      this.dry = [new Float64Array(n), new Float64Array(n)];
      this.effectBus = stereo(n); this.spatialBus = stereo(n);
      this.sourceScratch.clear(); this.rampScratch.clear();
    }
    const dry = this.dry, effectBus = this.effectBus, spatialBus = this.spatialBus;
    dry[0].fill(0); dry[1].fill(0); effectBus[0].fill(0); effectBus[1].fill(0); spatialBus[0].fill(0); spatialBus[1].fill(0);
    const mixer = record(snapshot.mixer?.parameters.sources);
    for (const [id, samples] of sources) {
      let pair = this.perSource.get(id);
      if (!pair) {
        pair = { eq: new ParametricEqNode(`backend-eq-${id}`), dsp: new DspFilterNode(`backend-dsp-${id}`) };
        this.perSource.set(id, pair);
      }
      let channels = this.sourceScratch.get(id);
      if (!channels) { channels = stereo(n); this.sourceScratch.set(id, channels); }
      for (let i = 0; i < n; i++) { channels[0][i] = samples[2 * i]; channels[1][i] = samples[2 * i + 1]; }
      stages.eq.inputEnergy += energy(channels);
      const eq = snapshot.eq ?? this.lastConfigs.get('eq');
      const eqWet = this.ramp(`eq:${id}`, snapshot.eq?.active && targeted(snapshot.eq.parameters, id) ? 1 : 0, n);
      if (eq && eqWet.some(value => value > 0)) {
        const before = channels;
        for (const band of ['low', 'mid', 'high']) pair.eq.setBandGain(band, number(eq.parameters[band], 0, -24, 24));
        channels = this.run(pair.eq, channels);
        for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) channels[ch][i] = before[ch][i] + (channels[ch][i] - before[ch][i]) * eqWet[i];
      }
      stages.eq.outputEnergy += energy(channels);
      stages.dsp.inputEnergy += energy(channels);
      const dsp = snapshot.dsp ?? this.lastConfigs.get('dsp');
      const dspWet = this.ramp(`dsp:${id}`, snapshot.dsp?.active && targeted(snapshot.dsp.parameters, id) ? 1 : 0, n);
      if (dsp && dspWet.some(value => value > 0)) {
        const before = channels;
        const p = dsp.parameters;
        pair.dsp.cutoff.setValue(number(p.cutoff, 1000, 20, 20000));
        pair.dsp.resonance.setValue(number(p.resonance, 0.5, 0.1, 1));
        pair.dsp.depth.setValue(number(p.depth, 0, 0, 1));
        pair.dsp.drive.setValue(number(p.drive, 0, 0, 1));
        const requestedOversampling = number(p.oversampling, 1, 1, 4);
        const oversampling = requestedOversampling >= 4 ? 4 : requestedOversampling >= 2 ? 2 : 1;
        if (pair.dsp.oversamplingFactor !== oversampling) pair.dsp.setOversampling(oversampling);
        channels = this.run(pair.dsp, channels);
        for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) channels[ch][i] = before[ch][i] + (channels[ch][i] - before[ch][i]) * dspWet[i];
      }
      stages.dsp.outputEnergy += energy(channels);
      stages.mixer.inputEnergy += energy(channels);
      const settings = snapshot.mixer?.active ? record(mixer[id]) : {};
      const gain = settings.mute === true ? 0 : number(settings.gain, 1, 0, 2);
      const pan = number(settings.pan, 0, -1, 1);
      const gains = this.ramp(`gain:${id}`, gain, n), pans = this.ramp(`pan:${id}`, pan, n);
      const fx = number(settings.sendEffect, 0, 0, 1), spatial = number(settings.sendSpatial, 0, 0, 1);
      for (let i = 0; i < n; i++) {
        const l = channels[0][i] * gains[i] * (pans[i] > 0 ? 1 - pans[i] : 1), r = channels[1][i] * gains[i] * (pans[i] < 0 ? 1 + pans[i] : 1);
        dry[0][i] += l; dry[1][i] += r;
        effectBus[0][i] += l * fx; effectBus[1][i] += r * fx;
        spatialBus[0][i] += l * spatial; spatialBus[1][i] += r * spatial;
      }
    }
    stages.mixer.outputEnergy = energy(dry);
    stages.effect.inputEnergy = energy(effectBus);
    stages.spatial.inputEnergy = energy(spatialBus);
    const effect = snapshot.effect ?? this.lastConfigs.get('effect');
    const effectWet = this.ramp('effect:active', snapshot.effect?.active ? 1 : 0, n);
    if (effect && (effect.active || effectWet.some(value => value > 0))) {
      const p = effect.parameters;
      for (const [name, fallback, min, max] of [
        ['wet', 0, 0, 1], ['feedback', 0.6, 0, 0.9], ['rate', 0.5, 0.05, 10],
        ['depth', 0.5, 0, 1], ['bits', 8, 2, 16], ['sampleReduction', 1, 1, 64],
      ] as const) this.effect.getParameter(name)?.setValue(number(p[name], fallback, min, max));
      const out = this.run(this.effect, effectBus);
      stages.effect.outputEnergy = energy(out);
      let returned = 0;
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) returned += (out[ch][i] - effectBus[ch][i]) ** 2;
      stages.effect.returnEnergy = returned;
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) dry[ch][i] += (out[ch][i] - effectBus[ch][i]) * effectWet[i];
    }
    if (!effect?.active) stages.effect.outputEnergy = stages.effect.inputEnergy;
    const spatial = snapshot.spatial ?? this.lastConfigs.get('spatial');
    const spatialWet = this.ramp('spatial:active', snapshot.spatial?.active ? 1 : 0, n);
    if (spatial && (spatial.active || spatialWet.some(value => value > 0))) {
      const pan = number(spatial.parameters.pan, 0, -1, 1), width = number(spatial.parameters.width, 1, 0, 2);
      let outputEnergy = 0, returnEnergy = 0;
      for (let i = 0; i < n; i++) {
        const l = spatialBus[0][i], r = spatialBus[1][i], mid = (l + r) / 2, side = (l - r) * width / 2;
        const outL = (mid + side) * (pan > 0 ? 1 - pan : 1), outR = (mid - side) * (pan < 0 ? 1 + pan : 1);
        outputEnergy += outL * outL + outR * outR;
        returnEnergy += (outL - l) ** 2 + (outR - r) ** 2;
        dry[0][i] += (outL - l) * spatialWet[i];
        dry[1][i] += (outR - r) * spatialWet[i];
      }
      stages.spatial.outputEnergy = outputEnergy;
      stages.spatial.returnEnergy = returnEnergy;
    }
    if (!spatial?.active) stages.spatial.outputEnergy = stages.spatial.inputEnergy;
    stages.master.inputEnergy = energy(dry);
    const master = snapshot.master;
    const p = master?.parameters ?? {};
    // R16 P1: twelve real bands on the finished sum, before the master gain and long
    // before PCM24 rounding. Float32 blocks with a Float64 accumulator keep headroom;
    // OFF is a true bypass and activation/parameter jumps ramp over five milliseconds.
    const settings = Array.isArray(p.bands) ? p.bands : [];
    const bandGains: number[] = MASTER_EQ_BANDS.map((_band, index) => number(settings[index], 0, -24, 24));
    const eqEngaged = Boolean(master?.active) && bandGains.some((value) => value !== 0);
    const eqWet = this.ramp('master:eq', eqEngaged ? 1 : 0, n);
    if (eqWet[n - 1] > 0 || eqWet[0] > 0) {
      if (this.masterEqBus[0].length !== n) this.masterEqBus = stereo(n);
      for (let i = 0; i < n; i++) { this.masterEqBus[0][i] = dry[0][i]; this.masterEqBus[1][i] = dry[1][i]; }
      MASTER_EQ_BANDS.forEach((_band, index) => this.masterEq.setBandGain(`b${index}`, bandGains[index]));
      const shaped = this.run(this.masterEq, this.masterEqBus);
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) this.masterEqBus[ch][i] = dry[ch][i] + (shaped[ch][i] - dry[ch][i]) * eqWet[i];
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) dry[ch][i] = this.masterEqBus[ch][i];
    }
    const dbGain = typeof p.masterVolumeDb === 'number' && Number.isFinite(p.masterVolumeDb) ? Math.pow(10, p.masterVolumeDb / 20) : 1;
    const gain = master?.active ? number(p.gain, Math.min(2, dbGain), 0, 2) : 1;
    const masterGains = this.ramp('master:gain', gain, n);
    const result = new Float32Array(length);
    for (let i = 0; i < n; i++) { result[2 * i] = dry[0][i] * masterGains[i]; result[2 * i + 1] = dry[1][i] * masterGains[i]; }
    stages.master.outputEnergy = blockEnergy(result);
    this.lastReport = { stages, sourceIds: [...sources.keys()] };
    this.frames += n;
    return result;
  }

  private run(node: Node, channels: Stereo): Stereo {
    let scratch = this.runScratch.get(node);
    if (!scratch) {
      scratch = { port: new AudioPort(node, 'output', 'backend-input'), ctx: { sampleRate: this.sampleRate, bufferSize: channels[0].length, currentTime: 0, quantum: channels[0].length } };
      this.runScratch.set(node, scratch);
    }
    scratch.port.buffer = channels;
    node.inputs[0].connections[0] = scratch.port;
    if (scratch.ctx.bufferSize !== channels[0].length) scratch.ctx = { sampleRate: this.sampleRate, bufferSize: channels[0].length, currentTime: 0, quantum: channels[0].length };
    scratch.ctx.currentTime = this.frames / this.sampleRate;
    node.process(scratch.ctx);
    return node.outputs[0].buffer as Stereo;
  }
}
