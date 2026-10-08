// @vitest-environment node
/**
 * RT-AUDIT-P0-002 (+ RT-AUDIT-P2-017): Audio-Thread allokationsfrei
 * ==================================================================
 * Vorher legte jeder Node pro Block über `BufferPool.acquire()` neue Puffer an
 * (`release()` wurde nie aufgerufen): 46 Arrays pro Block, GC-Pausen bis
 * 9,6 ms. Jetzt hält jeder Ausgangsport EINEN festen Puffersatz.
 *
 * Diese Tests belegen:
 *  - feste Puffer: die Ausgangsarray-Referenzen ALLER Nodes im Plan sind in
 *    Block 10 und Block 1000 identisch (V2-Studio- und Output-Graph, mit
 *    Events, allen Master-Inserts, Testton, Sample, 2.1/5.1-Layout);
 *  - `V2MonitorGraph.render()` liefert immer dasselbe Ergebnisobjekt;
 *  - Bypass-/Fan-out-Pfade geben nie den Eingangspuffer weiter;
 *  - P2-017: DspFilterNode bei statischer Hüllkurve identisch zur alten
 *    Implementierung (Koeffizienten pro Sample), bei bewegter Hüllkurve nahe.
 */
import { describe, expect, it } from 'vitest';
import { V2SinkEngine, type V2StepRenderEvent } from '../src/core/audio/live/V2SinkEngine';
import { V2MonitorGraph } from '../src/core/audio/V2MonitorGraph';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { getPortBufferAllocations } from '../src/core/audio/PortBuffers';
import { GainNode, SourceNode } from '../src/core/audio/nodes/basicNodes';
import {
  DspFilterNode,
  DynamicsNode,
  EffectNode,
  smoothingCoefficient,
} from '../src/core/audio/nodes/processingNodes';
import { V2_CHANNELS, type V2Channel } from '../src/core/audio/V2StudioGraph';
import type { IAudioNode, IProcessingContext } from '../src/core/audio/types';

const SR = 48000;
const N = 128;

const ctx = (block: number): IProcessingContext => ({
  sampleRate: SR,
  bufferSize: N,
  quantum: N / SR,
  currentTime: (block * N) / SR,
});

/** Alle Ausgangs-Referenzen (Port-Satz + jeder Kanal) aller Nodes eines Plans. */
function outputRefs(nodes: readonly IAudioNode[]): Map<string, unknown> {
  const refs = new Map<string, unknown>();
  for (const node of nodes) {
    node.outputs.forEach((port, p) => {
      refs.set(`${node.id}:out${p}`, port.buffer);
      port.buffer?.forEach((ch, c) => refs.set(`${node.id}:out${p}:ch${c}`, ch));
    });
  }
  return refs;
}

function sine(freq: number, length: number, amp = 0.4): Float32Array {
  const a = new Float32Array(length);
  for (let i = 0; i < length; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}

interface Scenario {
  name: string;
  setup(engine: V2SinkEngine): void;
}

const SCENARIOS: Scenario[] = [
  { name: 'Default (Bypass-Inserts, Stereo)', setup: () => {} },
  {
    name: 'alle Master-Inserts aktiv + Testton + Sample, 2.1',
    setup: (e) => {
      e.setMasterEq(4, -3, 2);
      e.setMasterDsp(900, 0.6, 0.7, 0.3);
      e.setMasterModMatrix(true, 1.5, 0.4);
      e.setMasterReverb(true, 0.3, 1.2, 0.3, 1);
      e.setMasterFx(0.4, 0.5, 0.6, 0.4);
      e.setMasterDynamics(true, -22, 3, 2);
      e.setTestTone(true, 330, 0.2);
      e.setSampleBuffer('channel2', sine(220, 20000), sine(221, 20000), 44100);
      e.triggerSample('channel2', { loop: true });
      e.setOutputLayout('2.1');
    },
  },
  {
    name: 'Mehrkanal 5.1 + Cue-Monitor',
    setup: (e) => {
      e.setOutputLayout('5.1');
      e.applyMonitorRouting({ ...e.getMonitorRouting(), mainMonitorGain: 0.7, cueGain: 0.6 });
    },
  },
];

describe('RT-AUDIT-P0-002 – feste Port-Puffer im V2-Live-Pfad', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: Ausgangsarrays aller Nodes in Block 10 und 1000 identisch`, () => {
      const engine = new V2SinkEngine(SR, N);
      scenario.setup(engine);
      const tracks: V2Channel[] = ['channel1', 'channel3', 'channel5', 'channel8'];
      const events: V2StepRenderEvent[] = tracks.map((track, i) => ({ track, startSample: 7 + i * 11, velocity: 0.8, freq: 60 + i * 50 }));
      const noEvents: V2StepRenderEvent[] = [];
      const plan = () => [...engine.studio.graph.compile().nodes, ...engine.outputGraph.graph.compile().nodes];

      let refs10: Map<string, unknown> | null = null;
      let out10: Float32Array[] | null = null;
      let alloc10 = 0;
      let lastOut: Float32Array[] | null = null;
      for (let b = 1; b <= 1000; b++) {
        lastOut = engine.render(ctx(b), b % 9 === 0 ? events : noEvents);
        if (b === 10) {
          refs10 = outputRefs(plan());
          out10 = lastOut;
          alloc10 = getPortBufferAllocations();
        }
      }
      const refs1000 = outputRefs(plan());

      expect(refs10).not.toBeNull();
      expect(refs1000.size).toBe(refs10!.size);
      // Mind. die 32 Kanalzug-Nodes + Busse + 7 Master-Inserts + Output-Node.
      expect(refs1000.size).toBeGreaterThan(40);
      for (const [key, ref] of refs1000) {
        expect(ref, `${key} wurde neu angelegt`).toBe(refs10!.get(key));
      }
      // render() liefert immer dieselben Ausgangsarrays.
      expect(lastOut).toBe(out10);
      // Zwischen Block 10 und 1000 wurde kein einziger Port-Puffer angelegt.
      expect(getPortBufferAllocations()).toBe(alloc10);
      // Und es kam weiterhin Signal heraus (keine stillgelegte Kette).
      expect(lastOut!.some((ch) => ch.some((v) => v !== 0))).toBe(true);
    });
  }

  it('V2MonitorGraph.render() liefert in jedem Block dasselbe Ergebnisobjekt', () => {
    const graph = new V2MonitorGraph(SR, N);
    graph.setMasterEq(2, 1, -1);
    const first = graph.render(ctx(0));
    const main0 = first.main;
    const monitor0 = first.monitor;
    let last = first;
    for (let b = 1; b < 1000; b++) {
      for (const ch of V2_CHANNELS) graph.setSourceBuffer(ch, [sine(100 + b, N)]);
      last = graph.render(ctx(b));
    }
    expect(last).toBe(first);
    expect(last.main).toBe(main0);
    expect(last.monitor).toBe(monitor0);
  });
});

describe('RT-AUDIT-P0-002 – Bypass und Fan-out geben nie den Eingang weiter', () => {
  function chain(node: IAudioNode) {
    const graph = new AudioGraph();
    const input = [sine(440, N), sine(660, N)];
    const src = new SourceNode('src', input);
    graph.addNode(src);
    graph.addNode(node);
    graph.connect(src.outputs[0], node.inputs[0]);
    graph.process(ctx(0));
    return { src, out: node.outputs[0].buffer! };
  }

  const fx = new EffectNode('fx');
  fx.wet.setValue(0);
  const dsp = new DspFilterNode('dsp');
  dsp.depth.setValue(0);
  dsp.drive.setValue(0);
  const dyn = new DynamicsNode('dyn');
  dyn.setEnabled(false);

  for (const [name, node] of [['EffectNode wet 0', fx], ['DspFilterNode depth/drive 0', dsp], ['DynamicsNode aus', dyn]] as const) {
    it(`${name}: bit-transparente Kopie im EIGENEN Puffer`, () => {
      const { src, out } = chain(node);
      const input = src.outputs[0].buffer!;
      expect(out).not.toBe(input);
      for (let ch = 0; ch < input.length; ch++) {
        expect(out[ch]).not.toBe(input[ch]);
        expect(Array.from(out[ch])).toEqual(Array.from(input[ch]));
      }
      // In-Place-Schreiben downstream darf den Eingang (Fan-out) nicht verändern.
      const before = input[0][5];
      out[0][5] = 123;
      expect(input[0][5]).toBe(before);
    });
  }

  it('Fan-out Source → Gain UND CueGain: getrennte Ausgangspuffer', () => {
    const graph = new V2MonitorGraph(SR, N);
    graph.setSourceBuffer('channel1', [sine(200, N)]);
    graph.render(ctx(0));
    const source = graph.sources.get('channel1')!.outputs[0].buffer!;
    const gain = (graph.gains.get('channel1') as GainNode).outputs[0].buffer!;
    const cue = graph.cueGains.get('channel1')!.outputs[0].buffer!;
    expect(gain[0]).not.toBe(source[0]);
    expect(cue[0]).not.toBe(source[0]);
    expect(cue[0]).not.toBe(gain[0]);
  });
});

// ---------------------------------------------------------------------------
// RT-AUDIT-P2-017: Referenz = alte DspFilterNode-Rechnung (Koeffizienten pro
// Sample bei > 0,1 Hz Änderung, Array pro Berechnung) – hier nachgebaut.
// ---------------------------------------------------------------------------
function referenceLowpass(freq: number, q: number, sampleRate: number): number[] {
  const sr = Math.max(8000, sampleRate);
  const f = Math.max(5, Math.min(sr / 2 - 1, freq));
  const qq = Math.max(0.1, Math.min(18, q));
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * qq);
  const a0 = 1 + alpha;
  const b0 = (1 - cw) / 2;
  const co = [b0 / a0, (1 - cw) / a0, b0 / a0, (-2 * cw) / a0, (1 - alpha) / a0];
  return co.map((v) => (Number.isFinite(v) ? v : 0));
}

class ReferenceDspFilter {
  private env = 0;
  private co = [1, 0, 0, 0, 0];
  private readonly z = [[0, 0], [0, 0]];

  constructor(private readonly cutoff: number, private readonly q: number, private readonly depth: number, private readonly drive: number) {}

  process(input: Float32Array[], out: Float32Array[]): void {
    const att = smoothingCoefficient(0.02, SR);
    const rel = smoothingCoefficient(0.08, SR);
    const driveNorm = Math.tanh(1 + this.drive * 1.6);
    let lastCutoff = -1;
    for (let i = 0; i < N; i++) {
      let mono = 0;
      for (let ch = 0; ch < input.length; ch++) mono += Math.abs(input[ch][i]);
      mono /= Math.max(1, input.length);
      this.env += (mono > this.env ? att : rel) * (mono - this.env);
      if (this.env < 0) this.env = 0;
      const modCutoff = Math.min(SR / 2 - 1, Math.max(20, this.cutoff + this.depth * this.env * 4000));
      if (Math.abs(modCutoff - lastCutoff) > 0.1) {
        lastCutoff = modCutoff;
        this.co = referenceLowpass(modCutoff, this.q, SR);
      }
      for (let ch = 0; ch < out.length; ch++) {
        const [b0, b1, b2, a1, a2] = this.co;
        const x = input[ch][i];
        const z = this.z[ch];
        let y = b0 * x + z[0];
        if (!Number.isFinite(y)) y = 0;
        let z1 = b1 * x - a1 * y + z[1];
        let z2 = b2 * x - a2 * y;
        if (!Number.isFinite(z1)) z1 = 0;
        if (!Number.isFinite(z2)) z2 = 0;
        z[0] = z1;
        z[1] = z2;
        let s = y;
        if (this.drive > 0) s = Math.tanh(s * (1 + this.drive * 2)) / driveNorm;
        out[ch][i] = Number.isFinite(s) ? s : 0;
      }
    }
  }
}

function compareDsp(depth: number, drive: number, signal: (n: number) => number): { maxAbs: number; relErrDb: number } {
  const cutoff = 1200;
  const q = 0.7;
  const graph = new AudioGraph();
  const left = new Float32Array(N);
  const right = new Float32Array(N);
  const src = new SourceNode('src', [left, right]);
  const node = new DspFilterNode('dsp');
  node.cutoff.setValue(cutoff);
  node.resonance.setValue(q);
  node.depth.setValue(depth);
  node.drive.setValue(drive);
  graph.addNode(src);
  graph.addNode(node);
  graph.connect(src.outputs[0], node.inputs[0]);
  const ref = new ReferenceDspFilter(cutoff, q, depth, drive);
  const refOut = [new Float32Array(N), new Float32Array(N)];
  let maxAbs = 0;
  let err = 0;
  let energy = 0;
  for (let b = 0; b < 300; b++) {
    for (let i = 0; i < N; i++) {
      left[i] = signal(b * N + i);
      right[i] = 0.6 * signal(b * N + i + 5);
    }
    graph.process(ctx(b));
    ref.process([left, right], refOut);
    const out = node.outputs[0].buffer!;
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < N; i++) {
        const d = Math.abs(out[ch][i] - refOut[ch][i]);
        maxAbs = Math.max(maxAbs, d);
        err += d * d;
        energy += refOut[ch][i] * refOut[ch][i];
      }
    }
  }
  return { maxAbs, relErrDb: 10 * Math.log10(Math.max(1e-30, err) / energy) };
}

describe('RT-AUDIT-P2-017 – DspFilterNode: Koeffizienten gedrosselt, allokationsfrei', () => {
  it('statische Hüllkurve (Tiefe 0, Drive an): Frequenzgang identisch zur alten Implementierung (Toleranz 1e-5)', () => {
    for (const freq of [80, 500, 1200, 4000, 12000]) {
      const { maxAbs } = compareDsp(0, 0.4, (n) => 0.5 * Math.sin((2 * Math.PI * freq * n) / SR));
      expect(maxAbs, `${freq} Hz`).toBeLessThan(1e-5);
    }
  });

  it('bewegte Hüllkurve: Abweichung durch das 16-Sample-Raster bleibt klein (< −40 dB)', () => {
    const burst = (n: number) => (Math.floor(n / 6000) % 2 ? 0.8 : 0.05) * Math.sin((2 * Math.PI * 3000 * n) / SR);
    const { relErrDb } = compareDsp(0.8, 0.3, burst);
    expect(relErrDb).toBeLessThan(-40);
  });
});
