/**
 * audioMONASTRY · v2SinkProcessor
 * ================================
 * AudioWorklet-Processor des V2-Live-Output-Sinks (Phase 1 + Phase 2).
 *
 * Phase 1: hostet eine `V2SinkEngine` (inkl. `V2StudioGraph`) direkt im
 * AudioWorklet-Thread. Jeder `process()`-Aufruf rendert genau einen Block
 * durch den V2-Graph und schreibt das Ergebnis auf die AudioWorklet-Outputs.
 *
 * Phase 2: zusätzlich läuft hier der sample-genaue `V2SampleClock`-Scheduler.
 * Aktive Steps aus den übergebenen Patterns werden als Step-Bursts exakt an
 * ihrem Sample-Frame in den V2-Graph eingespeist – kein setInterval-Jitter.
 *
 * Steuerung über Port-Nachrichten (V2SinkMessage):
 *   { type: 'test-tone',  active, freq?, amplitude? }
 *   { type: 'gain-db',    channel, db }
 *   { type: 'pan',        channel, pan }
 *   { type: 'master-gain', value }
 *   { type: 'transport',  playing, bpm?, swing?, gate?, stepCount? }
 *   { type: 'pattern',    channel, steps }
 */
import { V2SinkEngine } from '../../core/audio/live/V2SinkEngine';
import type { V2SinkMessage, V2StepRenderEvent } from '../../core/audio/live/V2SinkEngine';
import { V2SampleClock } from '../../core/audio/live/V2SampleClock';
import { V2_CHANNELS, type V2Channel } from '../../core/audio/V2StudioGraph';
import { SfzVoiceBank, type SfzSourceMap } from '../../core/instrument/sfzVoice';

const DEFAULT_STEP_VELOCITY = 0.8;

function emptyPattern(length: 16 | 32): boolean[] {
  return Array.from({ length }, () => false);
}

class V2SinkProcessor extends AudioWorkletProcessor {
  private readonly engine = new V2SinkEngine(sampleRate, 128);
  private readonly clock = new V2SampleClock({ sampleRate, stepCount: 16, bpm: 120, swing: 0, gate: 0.9 });
  private readonly patterns = new Map<V2Channel, boolean[]>(V2_CHANNELS.map((c) => [c, emptyPattern(16)]));
  private readonly sfzBanks = new Map<V2Channel, SfzVoiceBank>();

  // --- CPU-Budget-Messung (PERF-P3-001) -------------------------------------
  // Ausschliesslich opt-in ueber `processorOptions.measure` (Default aus, im
  // Betrieb also null zusaetzliche Messkosten ausser zwei Zeitstempeln pro Block).
  /** Nicht `readonly`: die Messung schaltet sich bei Fehlern selbst ab (s. recordCpu). */
  private measure: boolean;
  private blocks = 0;
  private sumMs = 0;
  private maxMs = 0;
  /**
   * Zeitquelle. `performance` ist im AudioWorkletGlobalScope NICHT garantiert
   * vorhanden – live gemessen 2026-09-11 (headless Chromium): `typeof
   * performance === 'undefined'`. Ein direkter `performance.now()`-Aufruf warf
   * dort in JEDEM Block eine ReferenceError, der Prozessor starb und lieferte
   * nur noch Stille. Deshalb Feature-Test + `Date.now()`-Rueckfall (1 ms
   * Auflösung, fuer Mittelwerte ausreichend – der Bericht weist `timer` aus).
   */
  private readonly timer: 'performance' | 'date' =
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? 'performance' : 'date';
  /** Ein Block = 128 Frames; das ist das Echtzeit-Budget pro process()-Aufruf. */
  private readonly budgetMs = (128 / sampleRate) * 1000;
  private static readonly REPORT_EVERY = 250; // ~0,67 s bei 48 kHz

  private nowMs(): number {
    return this.timer === 'performance' ? performance.now() : Date.now();
  }

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const opts = (options?.processorOptions ?? {}) as { measure?: boolean };
    this.measure = opts.measure === true;
    // WICHTIG (live gemessen 2026-09-11): NICHT im Konstruktor posten. Ein
    // `this.port.postMessage()` an dieser Stelle brachte den Prozessor zum
    // Scheitern – der Knoten lieferte danach Stille und es kamen keine
    // Nachrichten an. Die Messung meldet sich deshalb im ersten process()-Block
    // (recordCpu sendet den ersten Bericht sofort).
    this.port.onmessage = (e: MessageEvent<V2SinkMessage>) => {
      const msg = e.data;
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'test-tone':
          this.engine.setTestTone(Boolean(msg.active), msg.freq, msg.amplitude);
          break;
        case 'gain-db':
          if (msg.channel && typeof msg.db === 'number') this.engine.setChannelGainDb(msg.channel, msg.db);
          break;
        case 'pan':
          if (msg.channel && typeof msg.pan === 'number') this.engine.setChannelPan(msg.channel, msg.pan);
          break;
        case 'master-gain':
          if (typeof msg.value === 'number') this.engine.setMasterGain(msg.value);
          break;
        case 'transport': {
          if (typeof msg.bpm === 'number') this.clock.bpm = msg.bpm;
          if (typeof msg.swing === 'number') this.clock.swing = msg.swing;
          if (typeof msg.gate === 'number') this.clock.gate = msg.gate;
          if (msg.stepCount === 16 || msg.stepCount === 32) {
            this.clock.stepCount = msg.stepCount;
            for (const channel of V2_CHANNELS) {
              const pattern = this.patterns.get(channel);
              if (pattern && pattern.length !== msg.stepCount) {
                this.patterns.set(channel, emptyPattern(msg.stepCount));
              }
            }
          }
          if (typeof msg.playing === 'boolean') {
            if (msg.playing) {
              this.clock.reset();
              this.clock.playing = true;
            } else {
              this.clock.playing = false;
            }
          }
          break;
        }
        case 'pattern':
          if (msg.channel && Array.isArray(msg.steps) && (msg.steps.length === 16 || msg.steps.length === 32)) {
            this.patterns.set(msg.channel, [...msg.steps]);
          }
          break;
        case 'sample-set':
          if (msg.channel && msg.left) {
            this.engine.setSampleBuffer(msg.channel, msg.left, msg.right ?? null, msg.sourceRate ?? sampleRate);
          }
          break;
        case 'sample-trigger':
          if (msg.channel) {
            this.engine.triggerSample(msg.channel, { loop: msg.loop, rate: msg.rate, offset: msg.offset });
          }
          break;
        case 'sample-stop':
          if (msg.channel) this.engine.stopSample(msg.channel);
          break;
        case 'synth-source':
          if (msg.channel && typeof msg.freq === 'number') {
            this.engine.setSynthSource(msg.channel, { freq: msg.freq, voice: msg.voice ?? 'lead' });
          }
          break;
        case 'mute':
          if (msg.channel && typeof msg.muted === 'boolean') {
            this.engine.setChannelMuted(msg.channel, msg.muted);
          }
          break;
        case 'synth-trigger':
          if (msg.channel) {
            this.engine.triggerSynth(msg.channel, typeof msg.velocity === 'number' ? msg.velocity : 1);
          }
          break;
        case 'sfz-load': {
          if (msg.channel && typeof msg.sfzText === 'string') {
            const bank = new SfzVoiceBank(sampleRate, 0.002, 0.08);
            bank.load(msg.sfzText, (msg.sources ?? {}) as SfzSourceMap);
            this.sfzBanks.set(msg.channel, bank);
          }
          break;
        }
        case 'sfz-note-on':
          if (msg.channel && typeof msg.note === 'number') {
            this.sfzBanks.get(msg.channel)?.noteOn(msg.note, msg.velocity ?? 100);
          }
          break;
        case 'sfz-note-off':
          if (msg.channel && typeof msg.note === 'number') {
            this.sfzBanks.get(msg.channel)?.noteOff(msg.note);
          }
          break;
        case 'monitor-plan':
          if (msg.plan) {
            this.engine.applyMonitorRouting(msg.plan);
          }
          break;
        case 'output-layout':
          if (typeof msg.layoutId === 'string') {
            this.engine.setOutputLayout(msg.layoutId);
          }
          break;
        case 'master-eq':
          if (typeof msg.lowDb === 'number' && typeof msg.midDb === 'number' && typeof msg.highDb === 'number') {
            this.engine.setMasterEq(msg.lowDb, msg.midDb, msg.highDb);
          }
          break;
        case 'master-dsp':
          this.engine.setMasterDsp(
            msg.cutoff ?? 20000,
            msg.resonance ?? 0.5,
            msg.depth ?? 0,
            msg.drive ?? 0,
          );
          break;
        case 'master-fx':
          this.engine.setMasterFx(msg.wet ?? 0, msg.feedback ?? 0.6, msg.rate ?? 0.5, msg.depth ?? 0.5);
          break;
        case 'master-dynamics':
          this.engine.setMasterDynamics(
            Boolean(msg.enabled),
            msg.threshold ?? -18,
            msg.ratio ?? 3,
            msg.makeup ?? 0,
          );
          break;
        case 'master-mastering':
          this.engine.setMasterMastering(
            msg.threshold ?? -14,
            msg.ratio ?? 3,
            msg.makeup ?? 1,
            msg.ceiling ?? 0.98,
          );
          break;
        default:
          break;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const length = output[0].length;
    // PERF-P3-001: Startmarke nur bei aktivierter Messung (Default aus).
    const startedAt = this.measure ? this.nowMs() : 0;
    const events: V2StepRenderEvent[] = [];

    // Phase 3 Rest: SFZ-/Instrument-Voices als V2-Quelle rendern (AudioWorklet).
    for (const [channel, bank] of this.sfzBanks) {
      if (!bank.hasActiveVoices()) continue;
      const mono = new Float32Array(length);
      bank.renderBlock(mono, length);
      this.engine.setExternalSource(channel, [mono]);
    }

    if (this.clock.playing) {
      const steps = this.clock.processBlock(currentFrame, length);
      for (const step of steps) {
        const startSample = step.frame - currentFrame;
        if (startSample < 0 || startSample >= length) continue;

        // UI-/State-Sync: Step-Impuls mit exakter Audio-Zeit an den Main-Thread.
        this.port.postMessage({
          type: 'step',
          step: step.step,
          time: step.time,
          swing: step.swing,
          gate: step.gate,
          secondsPerStep: step.secondsPerStep,
        });

        for (const channel of V2_CHANNELS) {
          if (!this.patterns.get(channel)?.[step.step]) continue;
          // AUDIO-P0-001: Mute-Parität – stummgeschaltete Kanäle triggern nicht.
          if (this.engine.isChannelMuted(channel)) continue;
          if (this.engine.hasSample(channel)) {
            // Phase 3: Sample-Player als V2-Source – Step retriggert das Sample.
            this.engine.triggerSample(channel, { loop: false, rate: 1, offset: 0 });
          } else {
            // Synth-/Step-Quelle: registrierte Frequenz oder Rollen-Default.
            const source = this.engine.getSynthSource(channel);
            events.push({
              track: channel,
              startSample,
              velocity: DEFAULT_STEP_VELOCITY,
              freq: source.freq,
            });
          }
        }
      }
    }

    const rendered = this.engine.render({
      sampleRate,
      bufferSize: length,
      quantum: length / sampleRate,
      currentTime,
    }, events);

    const channels = Math.min(output.length, rendered.length);
    for (let ch = 0; ch < channels; ch++) {
      const src = rendered[ch] ?? rendered[0];
      output[ch].set(src);
    }
    for (let ch = channels; ch < output.length; ch++) {
      output[ch].fill(0);
    }
    this.recordCpu(startedAt);
    return true;
  }

  /**
   * PERF-P3-001: sammelt die Render-Zeit eines Blocks und meldet regelmaessig
   * einen Bericht an den Main-Thread. `budgetMs` ist die Echtzeit-Grenze des
   * Blocks (128 Frames / sampleRate) – `loadPct` ist damit der Anteil, den der
   * V2-Live-Pfad vom Audio-Thread belegt.
   */
  private recordCpu(startedAt: number): void {
    if (!this.measure) return;
    try {
      this.recordCpuUnsafe(startedAt);
    } catch (e) {
      // Die Messung darf NIE den Audio-Pfad gefaehrden: einmal melden, dann aus.
      this.measure = false;
      this.port.postMessage({ type: 'cpu-error', message: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }

  private recordCpuUnsafe(startedAt: number): void {
    const elapsed = this.nowMs() - startedAt;
    this.blocks += 1;
    this.sumMs += elapsed;
    if (elapsed > this.maxMs) this.maxMs = elapsed;
    // Erster Block meldet sofort (Beweis, dass die Messung greift), danach
    // regelmaessig. Fehlt schon der erste Bericht, laeuft process() nicht.
    if (this.blocks !== 1 && this.blocks % V2SinkProcessor.REPORT_EVERY !== 0) return;
    this.port.postMessage({
      type: 'cpu-stats',
      blocks: this.blocks,
      avgMs: Number((this.sumMs / this.blocks).toFixed(4)),
      maxMs: Number(this.maxMs.toFixed(4)),
      budgetMs: Number(this.budgetMs.toFixed(4)),
      loadPct: Number(((this.sumMs / this.blocks / this.budgetMs) * 100).toFixed(2)),
      sampleRate,
      /** 'date' = grobe 1-ms-Auflösung (kein `performance` im Worklet-Scope). */
      timer: this.timer,
    });
  }
}

registerProcessor('v2-sink-processor', V2SinkProcessor);
