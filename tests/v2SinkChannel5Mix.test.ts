// @vitest-environment node
/**
 * AUDIT-2026-10-30-P1-010 · Mischlogik auf dem Instrument-Vertragskanal channel5
 * ===========================================================================
 * Seit AUDIO-2026-11-06-001 liegen auf `channel5` drei Quellen:
 *   1. Instrument-SFZ (`SfzVoiceBankCore` → `setExternalSource`)
 *   2. itSynth (`ItSynthBank` → in den SFZ-Scratch summiert, v2SinkProcessor)
 *   3. Pattern-Steps des Kanals (Stimme im Engine-Voice-Pool, wird in den
 *      External-Block gemischt, V2SinkEngine.render)
 *
 * Geprueft wird die Mischlogik selbst – nicht nur „es klingt“:
 *   * jede Quelle allein hoerbar,
 *   * beide Instrumentquellen zusammen = exakt die Summe der Einzellaeufe,
 *   * ein Pattern-Step auf channel5 ADDIERT seine Stimme (ersetzt den
 *     Instrument-Block nicht),
 *   * Mute auf channel5 = Stille, Unmute = wieder hoerbar,
 *   * Block-Offset: aufeinanderfolgende Bloecke tragen je ihren eigenen Inhalt
 *     (kein Rest/kein Aufsummieren des Vorgaengerblocks), nach Note-Off klingt
 *     der Kanal wirklich aus,
 *   * Pegel ueber 1.0 im Kanal verlassen den Prozessor nicht (der
 *     Mastering-Limiter im Monitor-Weg sichert hart auf ±ceiling).
 *
 * Messprinzip: der Test faehrt den ECHTEN Worklet-Prozessor (gestubbte
 * Worklet-Globals). Additivitaet wird VOR der Master-Kette gemessen
 * (`studio.mainBus` ist laut MasterSumNode linear – bewusst ohne Soft-Clip),
 * die Pegelgrenze danach am Prozessor-Ausgang (post Mastering). Nur so sind
 * die Einzellaeufe deterministisch vergleichbar; der Limiter wuerde die
 * Summenprobe sonst komprimieren.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { parseSfz } from '../src/core/instrument/sfzParser';
import type { InstrumentPitchDef } from '../src/core/instrument/itSynthVoice';

const SR = 48000;
const N = 128;
const CHANNEL = 'channel5';

interface Msg {
  type: string;
  [key: string]: unknown;
}

interface ProcessorInstance {
  port: { onmessage: ((e: { data?: unknown }) => void) | null; postMessage: (m: Record<string, unknown>) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  /** Nur fuer die Messung: linearer Vor-Master-Bus (kein Soft-Clip, s. MasterSumNode). */
  engine: { studio: { mainBus: { outputs: { buffer: Float32Array[] }[] } } };
}
type ProcessorCtor = new (options?: { processorOptions?: Record<string, unknown> }) => ProcessorInstance;

let Processor: ProcessorCtor | null = null;

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = SR;
  g.currentFrame = 0;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null, postMessage: () => {} };
  };
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => { Processor = ctor; };
  await import('../src/audio/worklets/v2SinkProcessor.ts');
  expect(Processor).not.toBeNull();
});

// --- Quellen ---------------------------------------------------------------

/** Konstantes SFZ-Sample: der Instrument-Block ist damit ein bekannter DC-Pegel. */
const SFZ_LEVEL = 0.25;
const SFZ_TEXT = '<region> sample=dc.wav lokey=0 hikey=127';

const sfzRegions = () => parseSfz(SFZ_TEXT).regions;
const sfzSources = (level = SFZ_LEVEL): Record<string, Float32Array> => ({
  'dc.wav': new Float32Array(SR * 4).fill(level),
});

const IT_DEF: InstrumentPitchDef = {
  id: 1,
  name: 'p1-010-test',
  kind: 'synth',
  osc: 'sine',
  attack: 0.001,
  release: 0.01,
  gain: 1,
};

/** itSynth mit 16 Stimmen und maximaler Velocity (Pegelreserve-Test). */
const LOUD_NOTES = [48, 52, 55, 60, 64, 67, 72, 76, 79, 84, 88, 91, 96, 100, 103, 108];

// --- Harness ---------------------------------------------------------------

interface Proc {
  p: ProcessorInstance;
  errors: Msg[];
}

function makeProc(): Proc {
  const p = new Processor!();
  const errors: Msg[] = [];
  p.port.postMessage = (m) => {
    if (m.type === 'render-error' || m.type === 'message-error') errors.push(m as Msg);
  };
  return { p, errors };
}

/** Eine Rendersitzung: fester Frame-Verlauf, blockweise Ausgabe. */
interface Session {
  proc: Proc;
  frames: number;
  /** Prozessor-Ausgang (post Mastering, Mono = L) je Block. */
  blocks: Float32Array[];
  /** Vor-Master-Summe (linear, Mono = L) je Block. */
  pre: Float32Array[];
  send: (m: Msg) => void;
  render: (count: number) => void;
}

function newSession(prepare: (s: Session) => void): Session {
  const proc = makeProc();
  const g = globalThis as unknown as Record<string, number>;
  const session: Session = {
    proc,
    frames: 0,
    blocks: [],
    pre: [],
    send: (m: Msg) => { proc.p.port.onmessage?.({ data: m }); },
    render: (count: number) => {
      for (let b = 0; b < count; b++) {
        g.currentFrame = session.frames;
        g.currentTime = session.frames / SR;
        const left = new Float32Array(N);
        const right = new Float32Array(N);
        proc.p.process([], [[left, right]]);
        const premaster = proc.p.engine.studio.mainBus.outputs[0].buffer;
        session.blocks.push(left.slice());
        session.pre.push(premaster[0].slice(0, N));
        session.frames += N;
      }
    },
  };
  prepare(session);
  return session;
}

function peakOf(blocks: Float32Array[]): number {
  let peak = 0;
  for (const block of blocks) {
    for (let i = 0; i < block.length; i++) {
      const abs = Math.abs(block[i]);
      if (abs > peak) peak = abs;
    }
  }
  return peak;
}

function meanOf(blocks: Float32Array[]): number {
  let sum = 0;
  let n = 0;
  for (const block of blocks) {
    for (let i = 0; i < block.length; i++) {
      sum += block[i];
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** Groesste Abweichung der Summenprobe C == A + B ueber alle Samples. */
function maxDeviation(a: Float32Array[], b: Float32Array[], sum: Float32Array[], fromBlock: number): number {
  let worst = 0;
  const count = Math.min(a.length, b.length, sum.length);
  for (let blk = fromBlock; blk < count; blk++) {
    for (let i = 0; i < sum[blk].length; i++) {
      const dev = Math.abs(sum[blk][i] - (a[blk][i] + b[blk][i]));
      if (dev > worst) worst = dev;
    }
  }
  return worst;
}

/**
 * Sprung an der Blockgrenze: letztes Sample von Block k gegen erstes Sample von
 * Block k+1. Ein Ueberlauf/Rest des Vorgaengerblocks oder ein Reset mitten im
 * Signal waere hier als Sprung sichtbar (bei 60 Hz ist der echte Schritt klein).
 */
function maxBoundaryJump(blocks: Float32Array[], fromBlock: number, toBlock: number): number {
  let worst = 0;
  const end = Math.min(toBlock, blocks.length);
  for (let blk = fromBlock; blk < end; blk++) {
    const prev = blocks[blk - 1];
    const cur = blocks[blk];
    const dev = Math.abs(cur[0] - prev[prev.length - 1]);
    if (dev > worst) worst = dev;
  }
  return worst;
}

const send = (session: Session, msg: Msg): void => session.send(msg);

/** Instrument-SFZ auf channel5 laden + Note an. */
function startSfz(session: Session, level = SFZ_LEVEL, velocity = 100): void {
  send(session, { type: 'sfz-regions', channel: CHANNEL, regions: sfzRegions(), sources: sfzSources(level) });
  send(session, { type: 'sfz-note-on', channel: CHANNEL, note: 60, velocity });
}

/** itSynth (zweite Instrumentquelle) konfigurieren + Note(n) an. */
function startItSynth(session: Session, notes: number[] = [60], velocity = 0.8): void {
  send(session, { type: 'it-config', def: IT_DEF });
  for (const note of notes) send(session, { type: 'it-note-on', note, velocity });
}

/** Transport mit einem einzigen Pattern-Step (Step 0) auf channel5. */
function startPattern(session: Session): void {
  // 300 BPM (Maximum) → Step 0 liegt bei Frame 2400, d. h. nach ~19 Bloecken.
  send(session, {
    type: 'transport',
    bpm: 300,
    swing: 0,
    gate: 0.9,
    stepCount: 16,
    playing: true,
    transportEpoch: 1,
  });
  const steps = new Array<number>(16).fill(0);
  steps[0] = 1;
  send(session, { type: 'pattern', channel: CHANNEL, steps });
}

/** Startet SFZ + itSynth + Pattern auf channel5. */
const startAll = (s: Session): void => { startSfz(s); startItSynth(s); startPattern(s); };

// Bloecke bis zum Einschwingen (Mastering-Lookahead + Channel-Rampen).
const SETTLE = 6;
// Bloecke, bis Step 0 (Frame 2400) sicher durch ist.
const PATTERN_BLOCKS = SETTLE + 40;

// ---------------------------------------------------------------------------
// 0. Messwerte (Beleg fuer das Ticket)
// ---------------------------------------------------------------------------
describe('P1-010 · Messwerte: Peaks je Quelle und Summe', () => {
  it('liefert reproduzierbare Pegel fuer SFZ, itSynth, Summe und Pattern', () => {
    const sfz = newSession(startSfz);
    sfz.render(SETTLE);
    const it = newSession(startItSynth);
    it.render(SETTLE);
    const both = newSession((s) => { startSfz(s); startItSynth(s); });
    both.render(SETTLE);
    const pattern = newSession(startPattern);
    pattern.render(PATTERN_BLOCKS);
    const instPlusPattern = newSession(startAll);
    instPlusPattern.render(PATTERN_BLOCKS);
    const loud = newSession((s) => { startSfz(s, 1, 127); startItSynth(s, LOUD_NOTES, 1.5); });
    loud.render(SETTLE + 10);

    const m = {
      sfzPeak: +peakOf(sfz.pre).toFixed(6),
      itSynthPeak: +peakOf(it.pre).toFixed(6),
      sumPeak: +peakOf(both.pre).toFixed(6),
      sfzPlusItPeak: +(peakOf(sfz.pre) + peakOf(it.pre)).toFixed(6),
      patternPeak: +peakOf(pattern.pre).toFixed(6),
      sumPeakWithPattern: +peakOf(instPlusPattern.pre).toFixed(6),
      loudPreMasterPeak: +peakOf(loud.pre).toFixed(6),
      loudProcessorPeak: +peakOf(loud.blocks).toFixed(6),
      sumDeviation: +maxDeviation(sfz.pre, it.pre, both.pre, SETTLE).toExponential(2),
      errors: [sfz, it, both, pattern, instPlusPattern, loud].flatMap((s) => s.proc.errors).length,
    };
    console.log('P1-010 Messwerte: ' + JSON.stringify(m));

    expect(m.sfzPeak).toBeGreaterThan(0.1);
    expect(m.itSynthPeak).toBeGreaterThan(0.1);
    expect(m.patternPeak).toBeGreaterThan(0.1);
    expect(m.sumPeak).toBeGreaterThan(Math.max(m.sfzPeak, m.itSynthPeak));
    expect(m.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 1. Additivitaet der beiden Instrumentquellen
// ---------------------------------------------------------------------------
describe('P1-010 · itSynth + Instrument-SFZ werden addiert', () => {
  it('beide Quellen zusammen = Summe der Einzellaeufe (Toleranz 1e-5)', () => {
    const sfz = newSession(startSfz);
    sfz.render(SETTLE);
    const it = newSession(startItSynth);
    it.render(SETTLE);
    const both = newSession((s) => { startSfz(s); startItSynth(s); });
    both.render(SETTLE);

    // float32-Addition im Kanal: Abweichung nur Rundung, kein Pegelverlust.
    expect(maxDeviation(sfz.pre, it.pre, both.pre, SETTLE)).toBeLessThan(1e-5);
    // Gegenprobe: keine Quelle verschwindet (Max statt Summe waere ~0.25 Abweichung).
    expect(peakOf(both.pre)).toBeCloseTo(peakOf(sfz.pre) + peakOf(it.pre), 1);
  });

  it('der SFZ-Grundpegel bleibt erhalten, obwohl itSynth denselben Kanal belegt', () => {
    const sfz = newSession(startSfz);
    sfz.render(SETTLE);
    const both = newSession((s) => { startSfz(s); startItSynth(s); });
    both.render(SETTLE);
    expect(meanOf(both.pre)).toBeGreaterThan(0.9 * meanOf(sfz.pre));
  });
});

// ---------------------------------------------------------------------------
// 2. Pattern-Step auf channel5 addiert seine Stimme
// ---------------------------------------------------------------------------
describe('P1-010 · Pattern-Step auf channel5 addiert in den Instrument-Block', () => {
  it('Instrument + Pattern = Instrument + Pattern-Stimme (Toleranz 1e-4)', () => {
    const inst = newSession((s) => { startSfz(s); startItSynth(s); });
    inst.render(PATTERN_BLOCKS);
    const pattern = newSession(startPattern);
    pattern.render(PATTERN_BLOCKS);
    const both = newSession(startAll);
    both.render(PATTERN_BLOCKS);

    // Die Step-Stimme startet sample-genau am selben Frame in beiden Laeufen.
    expect(maxDeviation(inst.pre, pattern.pre, both.pre, SETTLE)).toBeLessThan(1e-4);
    // Der Instrument-Block wird nicht ersetzt: Pegel mit Pattern liegt ueber
    // dem Pattern-Alleinpegel und ueber dem Instrument-Alleinpegel.
    expect(peakOf(both.pre)).toBeGreaterThan(peakOf(pattern.pre));
    expect(peakOf(both.pre)).toBeGreaterThan(peakOf(inst.pre));
  });

  it('der Instrument-DC bleibt unter dem Step-Burst erhalten', () => {
    const pattern = newSession(startPattern);
    pattern.render(PATTERN_BLOCKS);
    const both = newSession(startAll);
    both.render(PATTERN_BLOCKS);
    // Pattern allein ist ein Burst um 0 (Mittelwert ~0); mit Instrument kommt
    // der DC-Anteil des Instrument-Blocks hinzu.
    expect(Math.abs(meanOf(pattern.pre))).toBeLessThan(0.02);
    expect(meanOf(both.pre)).toBeGreaterThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// 3. Mute / Unmute
// ---------------------------------------------------------------------------
describe('P1-010 · Mute auf channel5 schaltet alle drei Quellen still', () => {
  it('Mute = Stille (bei laufendem itSynth + SFZ + Pattern), Unmute = wieder hoerbar', () => {
    const session = newSession(startAll);
    session.render(PATTERN_BLOCKS);
    expect(peakOf(session.pre.slice(SETTLE))).toBeGreaterThan(0.1);

    send(session, { type: 'mute', channel: CHANNEL, muted: true });
    session.render(14);
    // Fade des Voice-Pools (64 Samples) + Lookahead: ab dem 2. Block exakt still.
    expect(peakOf(session.pre.slice(PATTERN_BLOCKS + 2))).toBe(0);
    // Der Prozessor-Ausgang ist um den Mastering-Lookahead (240 Samples) spaeter
    // still – deshalb erst ab dem 4. Block pruefen.
    expect(peakOf(session.blocks.slice(PATTERN_BLOCKS + 4))).toBe(0);

    send(session, { type: 'mute', channel: CHANNEL, muted: false });
    session.render(10);
    expect(peakOf(session.pre.slice(PATTERN_BLOCKS + 16))).toBeGreaterThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// 4. Block-Offset: kein Ueberlauf zwischen zwei Bloecken
// ---------------------------------------------------------------------------
describe('P1-010 · Block-Offset: aufeinanderfolgende Bloecke ohne Ueberlauf', () => {
  it('jeder Block traegt seinen eigenen Inhalt (kein Rest des Vorgaengerblocks)', () => {
    const session = newSession(startAll);
    session.render(PATTERN_BLOCKS);

    // Scratch-Puffer werden je Block neu beschrieben: der Pegel waechst nicht
    // ueber die Bloecke (kein Aufsummieren), der Sprung an der Blockgrenze
    // bleibt im Rahmen eines 128-Sample-Fensters.
    const steadyPeaks = session.pre.slice(SETTLE, 18).map((b) => peakOf([b]));
    // Obergrenze = itSynth-Peak (0.434) + SFZ-DC (0.139) = 0.573; Aufsummieren
    // ueber Bloecke wuerde diese Grenze sofort reissen.
    expect(Math.max(...steadyPeaks)).toBeLessThan(0.6);
    expect(Math.min(...steadyPeaks)).toBeGreaterThan(0.2);

    // Der Uebergang Block k → k+1 ist stetig (kein Rest des Vorgaengerblocks,
    // kein Reset der Scratch-Puffer mitten im Signal).
    expect(maxBoundaryJump(session.pre, SETTLE, 18)).toBeLessThan(0.05);
    // Ueber den Step-Onset hinweg gibt es einen echten Sprung (neue Stimme),
    // aber keinen Pegelausreisser ueber die Summe hinaus.
    expect(peakOf(session.pre.slice(SETTLE, 18))).toBeLessThan(0.6);
    expect(peakOf(session.pre.slice(18))).toBeLessThan(0.95);
  });

  it('nach Note-Off klingt channel5 wirklich aus (kein haengenbleibender Scratch)', () => {
    const session = newSession((s) => { startSfz(s); startItSynth(s); });
    session.render(SETTLE + 4);
    send(session, { type: 'sfz-note-off', channel: CHANNEL, note: 60 });
    send(session, { type: 'it-note-off', note: 60, fast: true });
    session.render(200);
    expect(peakOf(session.pre.slice(-20))).toBeLessThan(1e-4);
  });
});

// ---------------------------------------------------------------------------
// 5. Pegelschutz: Summe > 1.0 verlaesst den Prozessor nicht
// ---------------------------------------------------------------------------
describe('P1-010 · Clipping: die Kanal-Summe ueberschreitet 1.0 im Ausgang nicht', () => {
  it('heisse Quellen (SFZ 1.0 + 16 itSynth-Stimmen) werden vom Mastering-Limiter gesichert', () => {
    const session = newSession((s) => { startSfz(s, 1, 127); startItSynth(s, LOUD_NOTES, 1.5); });
    session.render(SETTLE + 10);

    const prePeak = peakOf(session.pre.slice(SETTLE));
    const outPeak = peakOf(session.blocks.slice(SETTLE));

    // Der Kanal summiert wirklich ueber 1.0 (Clipping-Kandidat) …
    expect(prePeak).toBeGreaterThan(1);
    // … aber der Ausgang bleibt unter dem Ceiling (harte Sicherung im
    // Mastering-Weg: V2MonitorGraph → MasteringNode). Kein Fix noetig.
    expect(outPeak).toBeLessThanOrEqual(0.9801);
    for (const block of session.blocks) {
      for (let i = 0; i < block.length; i++) {
        expect(Number.isFinite(block[i])).toBe(true);
      }
    }
  });
});
