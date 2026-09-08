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

  constructor() {
    super();
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
            this.engine.setSynthSource(msg.channel, { freq: msg.freq });
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
        default:
          break;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const length = output[0].length;
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
    return true;
  }
}

registerProcessor('v2-sink-processor', V2SinkProcessor);
