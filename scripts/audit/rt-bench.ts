/**
 * audioMONASTRY · Echtzeit-Audit-Benchmark des V2-Live-Pfads (RT-AUDIT-2026-10-07)
 * ================================================================================
 * Misst genau die Klassen, die im AudioWorklet laufen (`V2SinkEngine`,
 * `V2SampleClock`, `V2MonitorGraph`, Processing-Nodes) – in Node/V8, also mit
 * derselben JS-Engine wie Chromium. Jede Messung hat eine SOLL-Grenze; das
 * Skript endet mit Exit 1, wenn eine Grenze verletzt ist (`--gate`).
 *
 *   npm run audit:rt            → Bericht (Exit 0)
 *   npm run audit:rt -- --gate  → Bericht + Exit 1 bei Verletzung
 *   npm run audit:rt -- --json  → maschinenlesbar (eine JSON-Zeile)
 *
 * Messwerte vom 2026-10-07 (Commit 653fa02, Ausgangslage) stehen in
 * docs/audit/AUDIT_2026-10-07_ECHTZEIT.md. Die SOLL-Grenzen sind die
 * Akzeptanzkriterien der RT-AUDIT-Punkte in MASTERTODOENDE.json.
 *
 * Node startet mit `--expose-gc` nicht automatisch; die GC-Zahlen kommen aus
 * dem PerformanceObserver ('gc') und sind ohne Flag verfügbar.
 */
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { V2SinkEngine, type V2StepRenderEvent } from '../../src/core/audio/live/V2SinkEngine';
import { V2SampleClock, type V2ScheduledStep } from '../../src/core/audio/live/V2SampleClock';
import { V2StepQueue, V2_STEP_QUEUE_CAPACITY } from '../../src/core/audio/live/V2StepQueue';
import { V2MonitorGraph } from '../../src/core/audio/V2MonitorGraph';
import { getPortBufferAllocations } from '../../src/core/audio/PortBuffers';
import { AudioGraph } from '../../src/core/audio/AudioGraph';
import { SourceNode } from '../../src/core/audio/nodes/basicNodes';
import { EffectNode } from '../../src/core/audio/nodes/processingNodes';
import { V2_CHANNELS, type V2Channel } from '../../src/core/audio/V2StudioGraph';

const SR = 48000;
const N = 128;
const BUDGET_MS = (N / SR) * 1000;
const args = new Set(process.argv.slice(2));
const ctx = (block: number) => ({ sampleRate: SR, bufferSize: N, quantum: N / SR, currentTime: (block * N) / SR });
const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));

interface Check { id: string; label: string; value: number; unit: string; soll: string; ok: boolean }
const checks: Check[] = [];
function check(id: string, label: string, value: number, unit: string, soll: string, ok: boolean): void {
  checks.push({ id, label, value: Number(value.toFixed(3)), unit, soll, ok });
}

// ---------------------------------------------------------------------------
// [1] Stimmen-Länge: ein Kick-Step muss über mehrere Blöcke ausklingen.
// ---------------------------------------------------------------------------
function burstLength(): void {
  const engine = new V2SinkEngine(SR, N);
  let audibleBlocks = 0;
  for (let b = 0; b < 400; b++) {
    const ev: V2StepRenderEvent[] = b === 0 ? [{ track: 'channel1', startSample: 0, velocity: 0.8, freq: 50 }] : [];
    const out = engine.render(ctx(b), ev);
    if (rms(out[0]) > 1e-3) audibleBlocks++;
  }
  const ms = (audibleBlocks * N / SR) * 1000;
  check('RT-AUDIT-P0-001', 'Kick-Step hörbar (> -60 dBFS RMS)', ms, 'ms', '>= 100 ms', ms >= 100);
}

// ---------------------------------------------------------------------------
// [2] Swing: alle Steps müssen feuern – auch die, deren Frame durch Swing
//     hinter dem aktuellen Block liegt. Gemessen wird exakt die Logik aus
//     v2SinkProcessor.process(): Clock (processBlockInto) → V2StepQueue →
//     popDue. Gezählt werden „nicht gefeuerte Steps“ = geplant − gefeuert
//     (inkl. Queue-Überläufe) plus Steps, die nicht an ihrem Frame feuern.
// ---------------------------------------------------------------------------
function swingSteps(): void {
  for (const swing of [0, 0.5]) {
    const clock = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120, swing });
    clock.playing = true;
    const queue = new V2StepQueue(V2_STEP_QUEUE_CAPACITY);
    const planned: V2ScheduledStep[] = [{ step: 0, frame: 0, time: 0, swing: 0, gate: 0, secondsPerStep: 0 }];
    const starts = new Int32Array(V2_STEP_QUEUE_CAPACITY);
    const steps = new Int32Array(V2_STEP_QUEUE_CAPACITY);
    const frames = new Float64Array(V2_STEP_QUEUE_CAPACITY);
    const sps = new Float64Array(V2_STEP_QUEUE_CAPACITY);
    let plannedCount = 0;
    let fired = 0;
    let misplaced = 0;
    // 2,1 s: 120 BPM → 16tel = 6000 Samples → 16 Steps in 96.000 Samples.
    for (let f = 0; f < SR * 2.1; f += N) {
      const count = clock.processBlockInto(f, N, planned);
      for (let k = 0; k < count; k++) {
        plannedCount++;
        queue.push(planned[k].frame, planned[k].step, planned[k].secondsPerStep);
      }
      const n = queue.popDue(f, N, starts, steps, frames, sps);
      for (let k = 0; k < n; k++) {
        fired++;
        // Sample-genau: Startsample muss exakt dem geplanten Frame entsprechen.
        if (f + starts[k] !== frames[k]) misplaced++;
      }
    }
    // Was noch in der Queue liegt, ist erst NACH dem Messfenster fällig
    // (popDue feuert alles mit frame < Blockende) und zählt nicht als Fehler.
    const notFired = plannedCount - fired - queue.size + misplaced;
    check(`RT-AUDIT-P0-003/swing${swing}`, `Swing ${swing}: nicht gefeuerte Steps (V2StepQueue)`, notFired, 'Steps', '= 0', notFired === 0);
  }
}

// ---------------------------------------------------------------------------
// [3] Echtzeit-Budget + Allokationen + GC im Dauerbetrieb (60 s Audio).
// ---------------------------------------------------------------------------
async function budgetAndGc(): Promise<void> {
  const engine = new V2SinkEngine(SR, N);
  let gcCount = 0;
  let gcMax = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) { gcCount++; gcMax = Math.max(gcMax, e.duration); }
  });
  obs.observe({ entryTypes: ['gc'] });
  const BLOCKS = 375 * 60;
  const times = new Float64Array(BLOCKS);
  // RT-AUDIT-P0-002: BufferPool entfernt – gezählt werden jetzt die von den
  // festen Port-/Scratch-Puffern angelegten Kanäle (einziger Allokationsweg
  // der Nodes). SOLL unverändert: 0 pro Block. Der erste Block legt die festen
  // Puffer einmalig an (Setup, wie das Anlegen der Engine); gezählt wird der
  // Dauerbetrieb ab Block 1. Die Zeitmessung umfasst weiterhin alle Blöcke.
  let before = getPortBufferAllocations();
  const tracks: V2Channel[] = ['channel1', 'channel3', 'channel8'];
  for (let b = 0; b < BLOCKS; b++) {
    const ev: V2StepRenderEvent[] = b % 23 === 0 ? tracks.map((track) => ({ track, startSample: 5, velocity: 0.8, freq: 60 })) : [];
    const t0 = performance.now();
    engine.render(ctx(b), ev);
    times[b] = performance.now() - t0;
    if (b === 0) before = getPortBufferAllocations();
  }
  const after = getPortBufferAllocations();
  await new Promise((r) => setTimeout(r, 50));
  obs.disconnect();
  const sorted = Array.from(times).sort((a, b) => a - b);
  const p999 = sorted[Math.floor(0.999 * (sorted.length - 1))];
  const over = sorted.filter((t) => t > BUDGET_MS).length;
  const allocPerBlock = (after - before) / (BLOCKS - 1);
  check('RT-AUDIT-P0-002/alloc', 'Neue Port-Puffer pro Block', allocPerBlock, 'Arrays/Block', '= 0', allocPerBlock === 0);
  check('RT-AUDIT-P0-002/gcmax', 'Längste GC-Pause (60 s)', gcMax, 'ms', '< 1 ms', gcMax < 1);
  check('RT-AUDIT-P0-002/gc', 'GC-Ereignisse pro Sekunde', gcCount / 60, '1/s', '< 0,2', gcCount / 60 < 0.2);
  check('RT-AUDIT-P0-002/p999', 'Renderzeit p99,9', p999, 'ms', `< ${(BUDGET_MS / 2).toFixed(2)} ms (50 % Budget)`, p999 < BUDGET_MS / 2);
  check('RT-AUDIT-P0-002/over', 'Blöcke über Budget (2,67 ms)', over, 'Blöcke', '= 0', over === 0);
}

// ---------------------------------------------------------------------------
// [4] Klirrfaktor der Default-Masterkette (1 kHz, Kanal 1, Fader 0 dB).
// ---------------------------------------------------------------------------
function thdOf(sig: Float32Array, f0: number): number {
  const mag = (k: number): number => {
    let re = 0; let im = 0;
    for (let i = 0; i < sig.length; i++) {
      const ph = (2 * Math.PI * k * f0 * i) / SR;
      re += sig[i] * Math.cos(ph); im -= sig[i] * Math.sin(ph);
    }
    return Math.hypot(re, im);
  };
  const h1 = mag(1);
  let hs = 0;
  for (let k = 2; k <= 7; k++) hs += mag(k) ** 2;
  return Math.sqrt(hs) / h1;
}
function masterThd(): void {
  for (const dbfs of [-18, -6]) {
    const g = new V2MonitorGraph(SR, N);
    const amp = 10 ** (dbfs / 20);
    const out: number[] = [];
    const silence = new Float32Array(N);
    for (let b = 0; b < 400; b++) {
      const buf = new Float32Array(N);
      for (let i = 0; i < N; i++) buf[i] = amp * Math.SQRT2 * Math.sin((2 * Math.PI * 1000 * (b * N + i)) / SR);
      g.setSourceBuffer('channel1', [buf]);
      for (const ch of V2_CHANNELS) if (ch !== 'channel1') g.setSourceBuffer(ch, [silence]);
      const r = g.renderMain(ctx(b));
      if (r && b >= 200) for (let i = 0; i < N; i++) out.push(r[0][i]);
    }
    const thd = thdOf(Float32Array.from(out.slice(0, 9600)), 1000) * 100;
    // -18 dBFS liegt unter dem Default-Threshold (-14 dB, Knee 6 dB): die Kette
    // muss dort linear sein. -6 dBFS wird legitim komprimiert; ein Detektor mit
    // Attack/Release erzeugt nur Release-Welligkeit, daher die weitere Grenze.
    const limit = dbfs <= -18 ? 0.1 : 0.5;
    check(`RT-AUDIT-P0-004/${dbfs}`, `THD Masterkette bei ${dbfs} dBFS`, thd, '%', `< ${String(limit).replace('.', ',')} %`, thd < limit);
  }
}

// ---------------------------------------------------------------------------
// [5] Stereo-Isolation EffectNode (Impuls nur links → rechts muss still sein).
// ---------------------------------------------------------------------------
function fxStereo(): void {
  const g = new AudioGraph();
  const src = new SourceNode('s', [new Float32Array(N), new Float32Array(N)]);
  const fx = new EffectNode('fx');
  fx.wet.setValue(1);
  g.addNode(src); g.addNode(fx); g.connect(src.outputs[0], fx.inputs[0]); g.compile();
  let eR = 0;
  for (let b = 0; b < 100; b++) {
    const L = new Float32Array(N);
    if (b === 0) L[0] = 1;
    src.sourceBuffer = [L, new Float32Array(N)];
    g.process(ctx(b));
    const o = fx.outputs[0].buffer;
    if (o?.[1]) for (let i = 0; i < N; i++) eR += o[1][i] ** 2;
  }
  check('RT-AUDIT-P1-011', 'EffectNode: Energie rechts bei Impuls links', eR, '', '< 1e-9', eR < 1e-9);
}

// ---------------------------------------------------------------------------
// [6] Sample-Player-Resampling 44,1 → 48 kHz (SINAD eines 5-kHz-Sinus).
// ---------------------------------------------------------------------------
function resampleSinad(): void {
  const SRC = 44100; const f0 = 5000;
  const left = new Float32Array(SRC * 2);
  for (let i = 0; i < left.length; i++) left[i] = 0.25 * Math.sin((2 * Math.PI * f0 * i) / SRC);
  const engine = new V2SinkEngine(SR, N);
  engine.setMasterMastering(0, 1, 1, 1);
  engine.setSampleBuffer('channel2', left, null, SRC);
  engine.triggerSample('channel2', { loop: true });
  const out: number[] = [];
  for (let b = 0; b < 500; b++) {
    const r = engine.render(ctx(b));
    if (b >= 100) for (let i = 0; i < N; i++) out.push(r[0][i]);
  }
  const x = out.slice(0, SR);
  let re = 0; let im = 0;
  for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos((2 * Math.PI * f0 * i) / SR); im += x[i] * Math.sin((2 * Math.PI * f0 * i) / SR); }
  const a = (2 * Math.hypot(re, im)) / x.length;
  const ptot = x.reduce((s, v) => s + v * v, 0) / x.length;
  const psig = (a * a) / 2;
  const sinad = 10 * Math.log10(psig / Math.max(1e-20, ptot - psig));
  check('RT-AUDIT-P1-009', 'Sample-Resampling SINAD (5 kHz, 44,1→48 kHz)', sinad, 'dB', '>= 60 dB', sinad >= 60);
}

burstLength();
swingSteps();
await budgetAndGc();
masterThd();
fxStereo();
resampleSinad();

if (args.has('--json')) {
  console.log(JSON.stringify({ at: new Date().toISOString(), checks }));
} else {
  console.log('audioMONASTRY · Echtzeit-Audit (V2-Live-Pfad)\n');
  for (const c of checks) {
    console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.id.padEnd(26)} ${c.label.padEnd(48)} ${String(c.value).padStart(12)} ${c.unit.padEnd(12)} SOLL ${c.soll}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} Grenzen eingehalten.`);
}
if (args.has('--gate') && checks.some((c) => !c.ok)) process.exit(1);
