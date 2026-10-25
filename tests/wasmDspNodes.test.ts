/**
 * tests/wasmDspNodes.test.ts
 * ===========================
 * ZUK-003 – V2-DSP-Nodes, die den WASM-Kern nutzen (oder die TS-Referenz als Fallback).
 *
 * Die Tests belegen:
 *  1. Disabled-Node ist bit-transparent
 *  2. Biquad attenuiert 10 kHz bei 500 Hz Cutoff, lässt 100 Hz passieren
 *  3. Saturation ist monoton und auf |trim| beschränkt
 *  4. Compressor reduziert Gain nach Attack-Zeit und ist stereo-verkoppelt
 *  5. null-Kernel fällt auf die Referenz zurück und ist sample-genau (<1e-6) identisch zum WASM-Pfad
 *  6. reset() räumt Filter-/Kompressor-Zustand auf
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WasmBiquadNode, WasmSaturationNode, WasmCompressorNode } from '../src/core/audio/nodes/wasmDspNodes';
import { DspKernelWasm } from '../src/audio/wasm/dspKernelWasm';
import { ReferenceDspKernel } from '../src/audio/wasm/dspReference';
import type { IProcessingContext } from '../src/core/audio/types';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { SourceNode } from '../src/core/audio/nodes/basicNodes';

const SR = 48000;
const BLOCK = 128;

/** Minimaler Kontext für eine Block-Verarbeitung (keine Automation). */
function makeCtx(time = 0): IProcessingContext {
  return { sampleRate: SR, bufferSize: BLOCK, quantum: BLOCK / SR, currentTime: time };
}

/** Hängt eine Node an einen Source-Node und liefert den Output-Buffer zurück. */
function renderNode(nodeId: string, node: any, inbuf: Float32Array[]) {
  const graph = new AudioGraph();
  const src = new SourceNode('src', inbuf);
  graph.addNode(src);
  // Disconnect existing connections to avoid accumulation across calls
  for (const inp of node.inputs) inp.connections.length = 0;
  for (const outp of node.outputs) outp.connections.length = 0;
  graph.addNode(node);
  graph.connect(src.outputs[0], node.inputs[0]);
  const ctx = makeCtx();
  graph.process(ctx);
  return node.outputs[0].buffer;
}

/** Erzeugt einen Sinus-Block bei `freq` Hz. */
function sineBlock(freq: number, len = BLOCK, sr = SR): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** RMS eines Float32Arrays. */
function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

/** Laden des WASM-Moduls, falls vorhanden. */
const wasmPath = path.resolve(process.cwd(), 'public/wasm/dspKernel.wasm');
const wasmBytes = (() => {
  try { return readFileSync(wasmPath); } catch { return null; }
})();
let wasmKernelPromise: Promise<DspKernelWasm | null> | null = null;
const getWasmKernel = async () => {
  if (!wasmBytes || !wasmKernelPromise) return null;
  return wasmKernelPromise;
};
if (wasmBytes) {
  wasmKernelPromise = DspKernelWasm.fromBytes(wasmBytes).then(k => k).catch(() => null);
}

describe('WasmBiquadNode', () => {
  it('ist im deaktivierten Zustand bit-transparent', () => {
    const node = new WasmBiquadNode('bq1', null);
    const inL = sineBlock(1000);
    const inR = sineBlock(1000);
    const out = renderNode('bq1', node, [inL, inR]);
    expect(out?.[0]).toBeTruthy();
    for (let i = 0; i < BLOCK; i++) {
      expect(out![0][i]).toBeCloseTo(inL[i], 6);
      expect(out![1][i]).toBeCloseTo(inR[i], 6);
    }
  });

  it('dämpft 10 kHz stark bei 500 Hz Lowpass, lässt 100 Hz durch', async () => {
    const kernel = (await getWasmKernel()) ?? new ReferenceDspKernel();
    const blocks = 200;
    const len = blocks * BLOCK;

    // Helper, erzeugt einen langen Sinus-Buffer und rendert in einem Block.
    const measureGain = (nodeFactory: () => WasmBiquadNode, freq: number) => {
      const node = nodeFactory();
      node.setEnabled(true);
      (node as any).cutoff.setValue(500);
      (node as any).q.setValue(0.707);
      (node as any).mode.setValue(0);
      const buf = new Float32Array(len);
      for (let i = 0; i < len; i++) buf[i] = Math.sin((2 * Math.PI * freq * i) / SR);
      const out = renderNode('bq2', node, [buf, buf]);
      const tailStart = Math.floor(len * 0.25);
      let sumSq = 0;
      for (let i = tailStart; i < len; i++) sumSq += out![0][i] * out![0][i];
      const n = len - tailStart;
      const rms = Math.sqrt(sumSq / n);
      return rms / (1 / Math.sqrt(2)); // normiere auf Einheitssinus
    };

    const gain100 = measureGain(() => new WasmBiquadNode('bq2', kernel), 100);
    const gain10k = measureGain(() => new WasmBiquadNode('bq2', kernel), 10000);
    expect(gain100).toBeGreaterThan(0.9);
    expect(gain10k).toBeLessThan(0.05);
  });

  it('reset() räumt den Filterzustand auf (keine Nachkling-Tail)', () => {
    const makeNode = () => {
      const node = new WasmBiquadNode('bq3', null);
      node.setEnabled(true);
      return node;
    };

    // Node ohne Reset: nach lauter Erregung muss Stille noch einen Tail erzeugen.
    const nodeNoReset = makeNode();
    const loud = Float32Array.from(Array(BLOCK * 10).fill(1));
    renderNode('bq3', nodeNoReset, [loud, loud]);
    const silent = new Float32Array(BLOCK * 5).fill(0);
    const outNoReset = renderNode('bq3', nodeNoReset, [silent, silent]);
    const hasTail = outNoReset![0].some(v => Math.abs(v) > 1e-6);

    // Node mit Reset: Tail muss verschwinden.
    const nodeReset = makeNode();
    renderNode('bq3', nodeReset, [loud, loud]);
    nodeReset.reset();
    const outReset = renderNode('bq3', nodeReset, [silent, silent]);
    const isSilent = outReset![0].every(v => Math.abs(v) < 1e-9);

    expect(hasTail).toBe(true);
    expect(isSilent).toBe(true);
  });

  it('null-Kernel = Referenz; Output identisch zu WASM (<1e-6)', async () => {
    const wasmKernel = await getWasmKernel();
    if (!wasmKernel) {
      // Ohne WASM überspringen – Referenz-zu-Referenz ist trivial.
      return;
    }
    const nodeWasm = new WasmBiquadNode('bq-wasm', wasmKernel);
    const nodeRef = new WasmBiquadNode('bq-ref', null);
    nodeWasm.setEnabled(true);
    nodeRef.setEnabled(true);
    (nodeWasm as any).cutoff.setValue(1200);
    (nodeWasm as any).q.setValue(0.707);
    (nodeWasm as any).mode.setValue(0);
    (nodeRef as any).cutoff.setValue(1200);
    (nodeRef as any).q.setValue(0.707);
    (nodeRef as any).mode.setValue(0);

    const inL = sineBlock(440);
    const inR = sineBlock(550);
    const outWasm = renderNode('bq-wasm', nodeWasm, [inL, inR]);
    const outRef = renderNode('bq-ref', nodeRef, [inL, inR]);

    for (let i = 0; i < BLOCK; i++) {
      expect(Math.abs(outWasm![0][i] - outRef![0][i])).toBeLessThan(1e-6);
      expect(Math.abs(outWasm![1][i] - outRef![1][i])).toBeLessThan(1e-6);
    }
  });
});

describe('WasmSaturationNode', () => {
  it('ist bit-transparent, wenn deaktiviert', () => {
    const node = new WasmSaturationNode('sat1', null);
    const inL = Float32Array.from([0.1, 0.2, -0.3]);
    const inR = Float32Array.from([0.4, -0.5, 0.6]);
    const out = renderNode('sat1', node, [inL, inR]);
    expect(out![0][0]).toBeCloseTo(inL[0], 7);
    expect(out![1][1]).toBeCloseTo(inR[1], 7);
  });

  it('ist monoton und auf |trim| beschränkt', () => {
    const node = new WasmSaturationNode('sat2', null);
    node.setEnabled(true);
    (node as any).drive.setValue(20);
    (node as any).trim.setValue(0.8);

    let prev = -Infinity;
    // Mehrere Blöcke hintereinander, da Saturation zustandslos ist reicht ein Block.
    for (let x = -6; x <= 6; x += 0.01) {
      const inL = new Float32Array([x]);
      const inR = new Float32Array([x]);
      const out = renderNode('sat2', node, [inL, inR]);
      const y = out![0][0];
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.8 + 1e-6);
      prev = y;
    }
  });

  it('null-Kernel ≅ WASM', async () => {
    const wasmKernel = await getWasmKernel();
    if (!wasmKernel) return;
    const nodeWasm = new WasmSaturationNode('sat-wasm', wasmKernel);
    const nodeRef = new WasmSaturationNode('sat-ref', null);
    nodeWasm.setEnabled(true);
    nodeRef.setEnabled(true);
    (nodeWasm as any).drive.setValue(3);
    (nodeWasm as any).trim.setValue(0.7);
    (nodeRef as any).drive.setValue(3);
    (nodeRef as any).trim.setValue(0.7);

    const inL = Float32Array.from(Array(BLOCK).fill(0.5));
    const inR = Float32Array.from(Array(BLOCK).fill(-0.5));
    const outWasm = renderNode('sat-wasm', nodeWasm, [inL, inR]);
    const outRef = renderNode('sat-ref', nodeRef, [inL, inR]);
    for (let i = 0; i < BLOCK; i++) {
      expect(Math.abs(outWasm![0][i] - outRef![0][i])).toBeLessThan(1e-6);
      expect(Math.abs(outWasm![1][i] - outRef![1][i])).toBeLessThan(1e-6);
    }
  });
});

describe('WasmCompressorNode', () => {
  it('ist bit-transparent, wenn deaktiviert', () => {
    const node = new WasmCompressorNode('comp1', null);
    const inL = Float32Array.from([0.1, 0.2, 0.3]);
    const inR = Float32Array.from([0.4, -0.2, -0.1]);
    const out = renderNode('comp1', node, [inL, inR]);
    for (let i = 0; i < 3; i++) {
      expect(out![0][i]).toBeCloseTo(inL[i], 7);
      expect(out![1][i]).toBeCloseTo(inR[i], 7);
    }
  });

  it('reduziert Gain nach Attack-Zeit bei lautem Sprung und ist stereo-verkoppelt', async () => {
    const kernel = (await getWasmKernel()) ?? new ReferenceDspKernel();
    const node = new WasmCompressorNode('comp2', kernel);
    node.setEnabled(true);
    (node as any).threshold.setValue(-18);
    (node as any).ratio.setValue(4);
    (node as any).attack.setValue(0.01);
    (node as any).release.setValue(0.2);

    // Baue einen langen Buffer: 50 ms leise, 200 ms laut (L), leise (R),
    // dann 200 ms Release-Stille.
    const sr = SR;
    const quietSamples = Math.floor(0.05 * sr);
    const loudSamples  = Math.floor(0.2 * sr);
    const releaseSamples = Math.floor(0.2 * sr);
    const total = quietSamples + loudSamples + releaseSamples;

    const bufL = new Float32Array(total);
    const bufR = new Float32Array(total);
    for (let i = 0; i < quietSamples; i++) { bufL[i] = 0.01; bufR[i] = 0.01; }
    for (let i = quietSamples; i < quietSamples + loudSamples; i++) { bufL[i] = 0.9; bufR[i] = 0.01; }
    // Release-Teil bleibt 0

    const out = renderNode('comp2', node, [bufL, bufR]);
    if (!out) { throw new Error('Kein Output'); }

    // Prüfe, dass der Kompressor während der lauten Phase Gain drückt.
    const loudStart = quietSamples + Math.floor(0.05 * sr);
    const loudEnd   = quietSamples + loudSamples;
    let maxGainReduction = 0;
    // Wir prüfen den Endzustand des Kompressors (nach dem lauten Teil).
    // Da wir nur den Endwert über node.gainReductionDb abfragen können,
    // machen wir zwei Durchläufe: einmal bis zum Ende des lauten Teils,
    // dann Release.
    const node2 = new WasmCompressorNode('comp2b', kernel);
    node2.setEnabled(true);
    (node2 as any).threshold.setValue(-18);
    (node2 as any).ratio.setValue(4);
    (node2 as any).attack.setValue(0.01);
    (node2 as any).release.setValue(0.2);

    const bufL2 = new Float32Array(quietSamples + loudSamples);
    const bufR2 = new Float32Array(quietSamples + loudSamples);
    for (let i = 0; i < quietSamples; i++) { bufL2[i] = 0.01; bufR2[i] = 0.01; }
    for (let i = quietSamples; i < quietSamples + loudSamples; i++) { bufL2[i] = 0.9; bufR2[i] = 0.01; }
    renderNode('comp2b', node2, [bufL2, bufR2]);

    expect(node2.gainReductionDb).toBeLessThan(-5);

    // Stereo-Link: das Verhältnis L/R muss erhalten bleiben (identischer Gain).
    const peakL = Math.max(...out[0].slice(quietSamples, quietSamples + loudSamples).map(Math.abs));
    const peakR = Math.max(...out[1].slice(quietSamples, quietSamples + loudSamples).map(Math.abs));
    // Eingangsverhältnis 0.9/0.01 = 90 → nach identischem Gain bleibt es ≈90
    expect(peakL / Math.max(1e-9, peakR)).toBeCloseTo(90, 0.2);

    // Release-Phase: Gain soll wieder auf 0 zurückgehen.
    const node3 = new WasmCompressorNode('comp2c', kernel);
    node3.setEnabled(true);
    (node3 as any).threshold.setValue(-18);
    (node3 as any).ratio.setValue(4);
    (node3 as any).attack.setValue(0.01);
    (node3 as any).release.setValue(0.2);
    // Erst laut fahren
    renderNode('comp2c', node3, [bufL2, bufR2]);
    // Dann Release mit Stille
    const releaseBuf = new Float32Array(releaseSamples);
    renderNode('comp2c', node3, [releaseBuf, releaseBuf]);
    expect(node3.gainReductionDb).toBeGreaterThan(-0.1);
  });

  it('reset() setzt den Kompressor-Zustand (gain 0)', () => {
    const node = new WasmCompressorNode('comp3', null);
    node.setEnabled(true);
    (node as any).threshold.setValue(-12);
    (node as any).ratio.setValue(4);
    // Laut → Gain entsteht.
    renderNode('comp3', node, [Float32Array.from(Array(BLOCK).fill(0.8)), Float32Array.from(Array(BLOCK).fill(0.8))]);
    // Warte, bis Gain aufgebaut ist.
    for (let i = 0; i < 5; i++) renderNode('comp3', node, [Float32Array.from(Array(BLOCK).fill(0.8)), Float32Array.from(Array(BLOCK).fill(0.8))]);
    expect(node.gainReductionDb).toBeLessThan(-3);
    node.reset();
    expect(node.gainReductionDb).toBeCloseTo(0, 5);
  });

  it('null-Kernel ≅ WASM', async () => {
    const wasmKernel = await getWasmKernel();
    if (!wasmKernel) return;
    const nodeWasm = new WasmCompressorNode('comp-wasm', wasmKernel);
    const nodeRef = new WasmCompressorNode('comp-ref', null);
    [nodeWasm, nodeRef].forEach(n => {
      n.setEnabled(true);
      (n as any).threshold.setValue(-20);
      (n as any).ratio.setValue(4);
      (n as any).attack.setValue(0.005);
      (n as any).release.setValue(0.1);
    });

    const inL = new Float32Array(BLOCK).fill(0.5);
    const inR = new Float32Array(BLOCK).fill(0.3);
    const outWasm = renderNode('comp-wasm', nodeWasm, [inL, inR]);
    const outRef = renderNode('comp-ref', nodeRef, [inL, inR]);
    for (let i = 0; i < BLOCK; i++) {
      expect(Math.abs(outWasm![0][i] - outRef![0][i])).toBeLessThan(1e-6);
      expect(Math.abs(outWasm![1][i] - outRef![1][i])).toBeLessThan(1e-6);
    }
    expect(Math.abs(nodeWasm.gainReductionDb - nodeRef.gainReductionDb)).toBeLessThan(1e-6);
  });
});
