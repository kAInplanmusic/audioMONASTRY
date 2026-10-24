/**
 * ZUK-004 · Partitionierter Faltungshall, latenzfrei
 * ===================================================
 * Geprüft wird die Wirkung, nicht „läuft ohne Fehler":
 *
 *  (a) IR = Impuls bei 0            → Ausgabe == Eingabe (Einheitspfad, Latenz 0)
 *  (b) IR = Impuls bei N            → Ausgabe == Eingabe um genau N verzögert
 *  (c) Zufalls-IR                   → RMS-Abweichung < 1e-5 gegen direkte Faltung
 *  (d) Blockgrößen 64/128/256/1024  → bit-identisches Ergebnis
 *  (e) Latenzmessung                → erster Ausgangssample = h[0]·x[0], Onset 0
 *
 * Referenz für (c) ist die naive direkte Faltung in Float64 – der einzige
 * Vergleich, der nicht dieselbe FFT-Kette benutzt (sonst prüft der Test sich
 * selbst).
 */
import { describe, expect, it } from 'vitest';
import { PartitionedConvolver } from '../src/core/audio/partitionedConvolver';

/** Deterministisches Rauschen (kein Math.random → reproduzierbare Fehlschläge). */
function noise(length: number, seed = 0x2545f491): Float32Array {
  const out = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state / 4294967296) * 2 - 1;
  }
  return out;
}

/** Naive direkte Faltung y[n] = Σ h[k]·x[n−k] in Float64, Länge `outLength`. */
function directConvolve(ir: Float32Array, input: Float32Array, outLength: number): Float32Array {
  const out = new Float32Array(outLength);
  for (let n = 0; n < outLength; n++) {
    let acc = 0;
    const first = Math.max(0, n - input.length + 1);
    const last = Math.min(ir.length - 1, n);
    for (let k = first; k <= last; k++) acc += ir[k] * input[n - k];
    out[n] = acc;
  }
  return out;
}

function rmsDiff(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / Math.max(1, length));
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let max = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

/** Erster Index mit |Wert| > Schwelle – die gemessene Onset-Latenz. */
function onsetIndex(signal: Float32Array, threshold = 1e-7): number {
  for (let i = 0; i < signal.length; i++) {
    if (Math.abs(signal[i]) > threshold) return i;
  }
  return -1;
}

/** Rendert `input` in Blöcken der Größe `blockSize` (Restblock am Ende). */
function renderBlockwise(conv: PartitionedConvolver, input: Float32Array, blockSize: number): Float32Array {
  const channels = conv.channels;
  const out = new Float32Array(input.length * channels);
  for (let offset = 0; offset < input.length; offset += blockSize) {
    const end = Math.min(input.length, offset + blockSize);
    conv.process(input.subarray(offset, end), out.subarray(offset * channels, end * channels));
  }
  return out;
}

describe('PartitionedConvolver · Konstruktor und IR-Loader', () => {
  it('akzeptiert nur Zweierpotenzen als Partitionsgröße', () => {
    for (const size of [4, 16, 64, 128, 256, 1024]) {
      const conv = new PartitionedConvolver(size);
      expect(conv.partitionSize).toBe(size);
      expect(conv.fftSize).toBe(size * 2);
      expect(conv.latencySamples).toBe(0);
    }
    for (const size of [0, 2, 3, 100, 255, 200, 1023, Number.NaN, 1.5]) {
      expect(() => new PartitionedConvolver(size)).toThrow(RangeError);
    }
  });

  it('teilt die Impulsantwort in Partitionen und meldet die Länge', () => {
    const conv = new PartitionedConvolver(256);
    conv.loadImpulseResponse(new Float32Array(1000));
    expect(conv.impulseLength).toBe(1000);
    // ceil(1000 / 256) = 4
    expect(conv.partitions).toBe(4);
    expect(conv.channels).toBe(1);

    conv.loadImpulseResponse([new Float32Array(256), new Float32Array(512)]);
    expect(conv.channels).toBe(2);
    expect(conv.impulseLength).toBe(512);
    expect(conv.partitions).toBe(2);
  });

  it('weist leere IRs, falsche Kanalzahl und Processing ohne IR ab', () => {
    const conv = new PartitionedConvolver(64);
    expect(() => conv.process(new Float32Array(8), new Float32Array(8))).toThrow(/keine Impulsantwort/);
    expect(() => conv.loadImpulseResponse(new Float32Array(0))).toThrow(RangeError);
    expect(() => conv.loadImpulseResponse([new Float32Array(4), new Float32Array(4), new Float32Array(4)])).toThrow(RangeError);
    expect(() => conv.loadImpulseResponse([])).toThrow(RangeError);

    conv.loadImpulseResponse(new Float32Array(4));
    expect(() => conv.process(new Float32Array(8), new Float32Array(4))).toThrow(RangeError);
  });

  it('ersetzt NaN/Infinity in der IR durch 0 (kein vergifteter Frequenzbereich)', () => {
    const conv = new PartitionedConvolver(64);
    const ir = new Float32Array(300);
    ir[0] = 1;
    ir[5] = Number.NaN;
    ir[200] = Number.POSITIVE_INFINITY;
    conv.loadImpulseResponse(ir);
    const out = new Float32Array(512);
    conv.process(noise(512), out);
    expect(out.some((value) => !Number.isFinite(value))).toBe(false);
  });
});

describe('ZUK-004 (a) · Impuls bei 0 → Ausgabe == Eingabe', () => {
  it('Einheits-IR ([1]) liefert die Eingabe exakt zurück', () => {
    const conv = new PartitionedConvolver(256);
    conv.loadImpulseResponse(Float32Array.of(1));
    const input = noise(1024);
    const out = new Float32Array(input.length);
    conv.process(input, out);
    expect(out).toEqual(input);
  });

  it('Impuls bei 0 mit langer IR (Partitionen > 1) bleibt exakt', () => {
    const conv = new PartitionedConvolver(256);
    const ir = new Float32Array(4096);
    ir[0] = 1;
    conv.loadImpulseResponse(ir);
    expect(conv.partitions).toBe(16);
    const input = noise(2048, 0x9e3779b9);
    const out = new Float32Array(input.length);
    conv.process(input, out);
    expect(out).toEqual(input);
    expect(maxAbsDiff(out, input)).toBe(0);
  });

  it('skaliert den Einheitspfad exakt mit h[0]', () => {
    const conv = new PartitionedConvolver(64);
    conv.loadImpulseResponse(Float32Array.of(0.5));
    const input = noise(300);
    const out = new Float32Array(input.length);
    conv.process(input, out);
    for (let i = 0; i < input.length; i++) expect(out[i]).toBe(Math.fround(input[i] * 0.5));
  });
});

describe('ZUK-004 (b) · Impuls bei N → Verzögerung um genau N Samples', () => {
  const p = 256;
  /** Innerhalb der ersten Partition: zeitdiskreter Pfad, deshalb exakt. */
  const timeDomainDelays = [1, 7, 128, 255];
  /** Ab Partition 1: FFT-Pfad, deshalb mit Gleitkommatoleranz. */
  const fftDelays = [256, 300, 777, 1500];

  it('verzögert exakt (N < Partitionsgröße, zeitdiskreter Pfad)', () => {
    const length = 2048;
    for (const delay of timeDomainDelays) {
      const ir = new Float32Array(length);
      ir[delay] = 1;
      const conv = new PartitionedConvolver(p);
      conv.loadImpulseResponse(ir);
      const input = noise(length, 0x1234 + delay);
      const out = new Float32Array(length);
      conv.process(input, out);
      for (let n = 0; n < length; n++) {
        expect(out[n]).toBe(n >= delay ? input[n - delay] : 0);
      }
    }
  });

  it('verzögert exakt (N ≥ Partitionsgröße, FFT-Pfad)', () => {
    const length = 4096;
    for (const delay of fftDelays) {
      const ir = new Float32Array(length);
      ir[delay] = 1;
      const conv = new PartitionedConvolver(p);
      conv.loadImpulseResponse(ir);
      expect(conv.partitions).toBe(Math.ceil(length / p));
      const input = noise(length, 0x5678 + delay);
      const out = new Float32Array(length);
      conv.process(input, out);
      let maxError = 0;
      for (let n = 0; n < length; n++) {
        const expected = n >= delay ? input[n - delay] : 0;
        const error = Math.abs(out[n] - expected);
        if (error > maxError) maxError = error;
      }
      expect(maxError).toBeLessThan(1e-6);
      expect(onsetIndex(out)).toBe(delay);
    }
  });

  it('gibt die IR als Ganzes verschoben aus (Impuls-Eingang)', () => {
    const p2 = 128;
    const ir = noise(700, 0xfeed);
    const conv = new PartitionedConvolver(p2);
    conv.loadImpulseResponse(ir);
    const input = new Float32Array(1024);
    input[0] = 1;
    const out = new Float32Array(1024);
    conv.process(input, out);
    for (let n = 0; n < ir.length; n++) expect(out[n]).toBeCloseTo(ir[n], 5);
    for (let n = ir.length; n < 300; n++) expect(out[n]).toBe(0);
  });
});

describe('ZUK-004 (c) · Zufalls-IR gegen direkte Faltung', () => {
  it('bleibt unter 1e-5 RMS (inklusive Fahne über das Eingabe-Ende hinaus)', () => {
    const p = 256;
    const ir = noise(1500, 0xc0ffee);
    const input = noise(3000, 0xbadc0de);
    const conv = new PartitionedConvolver(p);
    conv.loadImpulseResponse(ir);
    expect(conv.partitions).toBe(6);

    const total = input.length + ir.length - 1;
    const padded = new Float32Array(total);
    padded.set(input);
    const out = new Float32Array(total);
    conv.process(padded, out);

    const reference = directConvolve(ir, input, total);
    const rms = rmsDiff(out, reference);
    expect(rms).toBeLessThan(1e-5);
    // Die Fahne muss wirklich da sein, nicht nur Nullen.
    let tailEnergy = 0;
    for (let n = input.length; n < total; n++) tailEnergy += reference[n] * reference[n];
    expect(tailEnergy).toBeGreaterThan(1e-3);
  });

  it('bleibt unter 1e-5 RMS bei langer IR (viele Partitionen) und ungerader Länge', () => {
    const p = 128;
    const ir = noise(3001, 0x5eed);
    const input = noise(2000, 0xabcd);
    const conv = new PartitionedConvolver(p);
    conv.loadImpulseResponse(ir);
    expect(conv.partitions).toBe(Math.ceil(ir.length / p));

    const total = input.length + ir.length - 1;
    const padded = new Float32Array(total);
    padded.set(input);
    const out = new Float32Array(total);
    conv.process(padded, out);

    expect(rmsDiff(out, directConvolve(ir, input, total))).toBeLessThan(1e-5);
  });

  it('bleibt unter 1e-5 RMS für kurze IR (nur zeitdiskreter Pfad)', () => {
    const ir = noise(37, 0x777);
    const input = noise(500, 0x888);
    const conv = new PartitionedConvolver(256);
    conv.loadImpulseResponse(ir);
    expect(conv.partitions).toBe(1);
    const out = new Float32Array(input.length);
    conv.process(input, out);
    expect(rmsDiff(out, directConvolve(ir, input, input.length))).toBeLessThan(1e-7);
  });
});

describe('ZUK-004 (d) · Blockgrößenunabhängigkeit', () => {
  it('liefert für 64/128/256/1024 bit-identische Ausgaben', () => {
    const p = 256;
    const ir = noise(2500, 0x31);
    const input = noise(6000, 0x32);

    const reference = new Float32Array(input.length);
    const refConv = new PartitionedConvolver(p);
    refConv.loadImpulseResponse(ir);
    refConv.process(input, reference);

    for (const blockSize of [64, 128, 256, 1024]) {
      const conv = new PartitionedConvolver(p);
      conv.loadImpulseResponse(ir);
      const out = renderBlockwise(conv, input, blockSize);
      expect(maxAbsDiff(out, reference)).toBe(0);
    }
  });

  it('bleibt blockgrößenunabhängig auch für krumme Blockgrößen (1/37/1000/4096)', () => {
    const ir = noise(1200, 0x41);
    const input = noise(4096, 0x42);

    const reference = new Float32Array(input.length);
    const refConv = new PartitionedConvolver(128);
    refConv.loadImpulseResponse(ir);
    refConv.process(input, reference);

    for (const blockSize of [1, 37, 1000, 4096]) {
      const conv = new PartitionedConvolver(128);
      conv.loadImpulseResponse(ir);
      expect(maxAbsDiff(renderBlockwise(conv, input, blockSize), reference)).toBe(0);
    }
  });
});

describe('ZUK-004 · Latenzmessung (Mandat: erste Partition im Audio-Thread)', () => {
  it('erster Ausgangssample ist h[0]·x[0] – keine Blocklatenz', () => {
    const p = 256;
    const ir = noise(2000, 0x99);
    ir[0] = 0.75;
    const input = noise(512, 0xaa);
    const conv = new PartitionedConvolver(p);
    conv.loadImpulseResponse(ir);
    const out = new Float32Array(input.length);
    conv.process(input, out);
    // Kein Vorlauf: Sample 0 ist sofort mit h[0] gewichtet.
    expect(out[0]).toBe(Math.fround(input[0] * 0.75));
    expect(onsetIndex(out)).toBe(0);
  });

  it('Onset bleibt 0 bei jeder Blockgröße (auch 1 Sample)', () => {
    const ir = noise(1024, 0xbb);
    ir[0] = 1;
    const input = noise(256, 0xcc);
    for (const blockSize of [1, 3, 64, 256, 1024]) {
      const conv = new PartitionedConvolver(256);
      conv.loadImpulseResponse(ir);
      const out = renderBlockwise(conv, input, blockSize);
      expect(onsetIndex(out)).toBe(0);
      expect(out[0]).toBe(input[0]);
    }
  });

  it('reset() löscht den Zustand, die IR bleibt geladen', () => {
    const ir = noise(600, 0xdd);
    const input = noise(1000, 0xee);
    const conv = new PartitionedConvolver(64);
    conv.loadImpulseResponse(ir);

    const first = new Float32Array(input.length);
    conv.process(input, first);
    conv.reset();
    const second = new Float32Array(input.length);
    conv.process(input, second);

    expect(maxAbsDiff(first, second)).toBe(0);
    expect(conv.impulseLength).toBe(600);
    expect(conv.channels).toBe(1);
  });
});

describe('ZUK-004 · Stereo und mono→stereo', () => {
  const irL = noise(700, 0x111);
  const irR = noise(900, 0x222);
  const input = noise(1200, 0x333);

  it('mono→stereo (verschränkt) entspricht zwei Mono-Faltungen', () => {
    const conv = new PartitionedConvolver(256);
    conv.loadImpulseResponse([irL, irR]);
    expect(conv.channels).toBe(2);

    const out = new Float32Array(input.length * 2);
    conv.process(input, out);
    expect(() => conv.process(input, new Float32Array(input.length))).toThrow(RangeError);

    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);
    const convL = new PartitionedConvolver(256);
    convL.loadImpulseResponse(irL);
    convL.process(input, left);
    const convR = new PartitionedConvolver(256);
    convR.loadImpulseResponse(irR);
    convR.process(input, right);

    for (let n = 0; n < input.length; n++) {
      expect(out[n * 2]).toBe(left[n]);
      expect(out[n * 2 + 1]).toBe(right[n]);
    }
  });

  it('stereo planar (2→2) faltet je Kanal mit seiner IR', () => {
    const conv = new PartitionedConvolver(128);
    conv.loadImpulseResponse([irL, irR]);
    const inL = noise(800, 0x444);
    const inR = noise(800, 0x555);
    const outL = new Float32Array(800);
    const outR = new Float32Array(800);
    conv.processStereo(inL, inR, outL, outR);

    const refL = new Float32Array(800);
    const cl = new PartitionedConvolver(128);
    cl.loadImpulseResponse(irL);
    cl.process(inL, refL);
    const refR = new Float32Array(800);
    const cr = new PartitionedConvolver(128);
    cr.loadImpulseResponse(irR);
    cr.process(inR, refR);

    expect(maxAbsDiff(outL, refL)).toBe(0);
    expect(maxAbsDiff(outR, refR)).toBe(0);
    // Kein Cross-Feed: linker Kanal darf nicht von inR abhängen.
    expect(maxAbsDiff(outL, refR)).toBeGreaterThan(1e-3);
  });

  it('processStereo verlangt eine stereofone IR', () => {
    const conv = new PartitionedConvolver(64);
    conv.loadImpulseResponse(irL);
    expect(() =>
      conv.processStereo(new Float32Array(8), new Float32Array(8), new Float32Array(8), new Float32Array(8)),
    ).toThrow(/stereofon/);
  });
});
