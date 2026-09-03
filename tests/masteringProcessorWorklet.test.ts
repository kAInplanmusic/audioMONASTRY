// @vitest-environment node
/**
 * AM-E4-4: funktionaler Test des echten masteringProcessor-Worklets.
 * ------------------------------------------------------------------
 * Der AudioWorkletProcessor-Code läuft normalerweise im Audio-Thread des
 * Browsers. Hier werden die Worklet-Globals (sampleRate, registerProcessor,
 * AudioWorkletProcessor) mit minimalen Stubs nachgebildet, damit der echte
 * Prozessor-Code deterministisch im Node-Test ausgeführt werden kann:
 *   * Lookahead 5 ms (240 Samples @ 48 kHz) wird verifiziert
 *   * Limiter-Ceiling wird eingehalten
 *   * AM-E4-4: Release-Lookup-Tabelle ist äquivalent zur Math.exp-Referenz
 *   * NaN/Inf-Guards liefern endliche Ausgangswerte
 *   * Determinismus über mehrere Instanzen
 */
import { beforeAll, describe, expect, it } from 'vitest';

interface MasteringProcessorInstance {
  port: { onmessage: ((e: { data?: Record<string, unknown> }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorCtor = new () => MasteringProcessorInstance;

let ProcessorCtor: ProcessorCtor | null = null;

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = 48000;
  g.currentFrame = 0;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown as MasteringProcessorInstance['port']['onmessage'] };
  };
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => {
    ProcessorCtor = ctor;
  };

  await import('../src/audio/worklets/masteringProcessor.ts');
  expect(ProcessorCtor).not.toBeNull();
});

function createProcessor(messages: Record<string, unknown>[] = []): MasteringProcessorInstance {
  if (!ProcessorCtor) throw new Error('Processor nicht geladen');
  const p = new ProcessorCtor();
  for (const m of messages) p.port.onmessage?.({ data: m });
  return p;
}

/** Ein Block mit `frames` Samples, Kanal 0 enthält `source`. */
function runBlock(
  p: MasteringProcessorInstance,
  source: Float32Array,
  frames: number,
): Float32Array {
  const input = [source];
  const output = [new Float32Array(frames)];
  const ok = p.process([input], [output]);
  expect(ok).toBe(true);
  return output[0];
}

describe('masteringProcessor (echter Worklet-Code)', () => {
  it('AM-E4-4: Release-Lookup ist äquivalent zur Math.exp-Referenz', async () => {
    const mod = await import('../src/audio/worklets/masteringProcessor.ts');
    const rc = (mod as unknown as { releaseCoefficient: (s: number, sr: number) => number }).releaseCoefficient;
    expect(typeof rc).toBe('function');
    for (const releaseSec of [0.005, 0.05, 0.5, 1.0]) {
      const expected = 1 - Math.exp(-1 / (48000 * releaseSec));
      // Segmentierte LUT mit linearer Interpolation: < 0,1 % Fehler im Bereich.
      expect(Math.abs(rc(releaseSec, 48000) - expected)).toBeLessThan(expected * 0.001 + 1e-6);
    }
  });

  it('Lookahead beträgt 5 ms (Impuls erscheint bei Sample 240, nicht früher)', () => {
    const frames = 1024;
    const source = new Float32Array(frames);
    source[0] = 1.0; // Dirac bei t=0

    const p = createProcessor([
      { reset: true, ceiling: 0.5, threshold: -6, ratio: 2, knee: 0, makeup: 1, release: 0.05 },
    ]);
    const out = runBlock(p, source, frames);

    for (let i = 0; i < 240; i++) {
      expect(out[i], `Sample ${i} sollte vor dem Lookahead stumm sein`).toBe(0);
    }
    expect(out[240]).toBeGreaterThan(0.2);
  });

  it('Limiter hält das Ceiling ein (True-Peak ≤ ceiling)', () => {
    const frames = 4096;
    const source = new Float32Array(frames);
    for (let i = 0; i < frames; i++) source[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);

    const p = createProcessor([
      { reset: true, ceiling: 0.5, threshold: -6, ratio: 2, knee: 0, makeup: 1, release: 0.05 },
    ]);
    const out = runBlock(p, source, frames);

    let maxAbs = 0;
    for (let i = 240; i < frames; i++) maxAbs = Math.max(maxAbs, Math.abs(out[i]));
    expect(maxAbs).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(maxAbs).toBeGreaterThan(0); // Signal kommt durch (nicht stumm)
  });

  it('NaN/Inf-Guards liefern endliche Ausgangswerte', () => {
    const frames = 256;
    const source = new Float32Array(frames);
    source[0] = 1.0;
    source[10] = NaN;
    source[20] = Infinity;

    const p = createProcessor([{ reset: true }]);
    const out = runBlock(p, source, frames);
    for (let i = 0; i < frames; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
    }
  });

  it('Determinismus: zwei Instanzen mit gleicher Konfiguration liefern identische Ausgaben', () => {
    const frames = 2048;
    const source = new Float32Array(frames);
    for (let i = 0; i < frames; i++) source[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.9;

    const cfg = [{ reset: true, ceiling: 0.7, threshold: -12, ratio: 3, knee: 3, makeup: 1.2, release: 0.1 }];
    const a = runBlock(createProcessor(cfg), source, frames);
    const b = runBlock(createProcessor(cfg), source, frames);

    expect(a.length).toBe(b.length);
    for (let i = 0; i < frames; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  it('kleinere Release-Zeit baut die Gain-Reduktion schneller ab', () => {
    // Ein lauter Impuls (1.0) drückt die Limiter-Hüllkurve. Danach läuft ein
    // leiser Dauerton (0.3). Bei kurzer Release-Zeit erholt sich der Gain
    // schneller → mehr Energie im Fenster nach dem (verzögerten) Impuls.
    const frames = 4096;
    const source = new Float32Array(frames);
    for (let i = 0; i < frames; i++) source[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.3;
    source[300] = 1.0;

    const fast = runBlock(
      createProcessor([{ reset: true, ceiling: 0.9, threshold: -12, ratio: 2, knee: 0, makeup: 1, release: 0.02 }]),
      source,
      frames,
    );
    const slow = runBlock(
      createProcessor([{ reset: true, ceiling: 0.9, threshold: -12, ratio: 2, knee: 0, makeup: 1, release: 0.5 }]),
      source,
      frames,
    );

    let fastEnergy = 0;
    let slowEnergy = 0;
    // Impuls erscheint durch das 5-ms-Lookahead bei Output-Sample 540.
    // Fenster danach: Gain-Erholung ist bei release=0.02 deutlich weiter.
    for (let i = 541; i <= 600; i++) {
      fastEnergy += fast[i] * fast[i];
      slowEnergy += slow[i] * slow[i];
    }
    expect(fastEnergy).toBeGreaterThan(slowEnergy);
  });
});
