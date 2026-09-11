/**
 * audioMONASTRY · V2SinkEngine
 * =============================
 * Backend-unabhängige Render-Engine für den V2-Live-Output-Sink (Phase 1).
 *
 * Sie kapselt eine V2MonitorGraph-Instanz (10 Kanäle + Cue/Main/Monitor) und
 * erzeugt wahlweise einen phasen-kontinuierlichen Testton auf channel1, der
 * durch den kompletten V2-Graph läuft. Der gerenderte Monitor-Block kann
 * anschließend im AudioWorklet direkt auf die AudioContext-Destination
 * geschrieben werden.
 *
 * Phase 4: Der lokale Monitor-Ausgang folgt einem `MonitorRoutingPlan`
 * (MAIN/MON/PLUGIN/MIX) – der MAIN-Bus bleibt davon unverändert.
 *
 * Die Klasse enthält KEINE WebAudio-/AudioWorklet-API und ist damit sowohl im
 * AudioWorklet (über den v2SinkProcessor) als auch in Node-Tests nutzbar.
 */
import { V2_CHANNELS, type V2Channel } from '../V2StudioGraph';
import { V2MonitorGraph } from '../V2MonitorGraph';
import { V2OutputGraph } from '../V2OutputGraph';
import type { IProcessingContext } from '../types';
import type { MonitorRoutingPlan } from '../monitorRouting';
import { phaseDistortionSample } from '../../dsp/phaseDistortion';
import { renderElectricPiano } from '../../dsp/electricPiano';

export interface V2SinkMessage {
  type: 'test-tone' | 'gain-db' | 'pan' | 'master-gain' | 'transport' | 'pattern'
    | 'sample-set' | 'sample-trigger' | 'sample-stop' | 'synth-source'
    | 'sfz-load' | 'sfz-note-on' | 'sfz-note-off' | 'monitor-plan' | 'output-layout'
    | 'master-eq' | 'master-dsp' | 'master-fx' | 'master-dynamics' | 'master-mastering'
    | 'mute' | 'synth-trigger' | 'master-mod-matrix' | 'master-reverb';
  active?: boolean;
  freq?: number;
  amplitude?: number;
  channel?: V2Channel;
  db?: number;
  pan?: number;
  value?: number;
  playing?: boolean;
  bpm?: number;
  swing?: number;
  gate?: number;
  stepCount?: 16 | 32;
  steps?: boolean[];
  left?: Float32Array;
  right?: Float32Array | null;
  sourceRate?: number;
  loop?: boolean;
  rate?: number;
  offset?: number;
  sfzText?: string;
  sources?: Record<string, Float32Array>;
  note?: number;
  velocity?: number;
  plan?: MonitorRoutingPlan;
  layoutId?: string;
  // AUDIO-P0-001: Synth-Stimme + Mute
  voice?: V2SynthVoice;
  muted?: boolean;
  // FEAT-P3-002: Parameter der optionalen Quellen (Phase-Distortion/E-Piano)
  amount?: number;
  modIndex?: number;
  // AUDIO-P0-004: Master-Processing-Payloads
  lowDb?: number;
  midDb?: number;
  highDb?: number;
  cutoff?: number;
  resonance?: number;
  depth?: number;
  drive?: number;
  wet?: number;
  feedback?: number;
  enabled?: boolean;
  threshold?: number;
  ratio?: number;
  makeup?: number;
  ceiling?: number;
  // FEAT-P3-002: optionale DSP-Bausteine (Mod-Matrix + HQ-Reverb)
  modEnabled?: boolean;
  modRate?: number;
  modDepth?: number;
  reverbEnabled?: boolean;
  reverbMix?: number;
  reverbDecayS?: number;
  reverbDamping?: number;
  reverbSizeScale?: number;
}

/** Ein sample-genau getriggerter Step-Burst innerhalb eines Render-Blocks. */
export interface V2StepRenderEvent {
  track: V2Channel;
  /** Sample-Offset innerhalb des aktuellen Blocks (0..bufferSize-1). */
  startSample: number;
  /** Velocity 0..1 (Amplitude). */
  velocity: number;
  /** Grundfrequenz des Bursts in Hz. */
  freq: number;
}

/** Optionen für einen V2-Sample-Trigger (Phase 3). */
export interface V2SampleTriggerOptions {
  loop?: boolean;
  /** Playback-Rate (1 = Originaltempo). */
  rate?: number;
  /** Start-Offset in Sekunden. */
  offset?: number;
}

interface V2LoadedSample {
  left: Float32Array;
  right?: Float32Array;
  sourceRate: number;
}

interface V2SamplePlaybackState extends V2LoadedSample {
  playing: boolean;
  loop: boolean;
  rate: number;
  /** Leseposition in Source-Samples. */
  position: number;
}

/** Konfigurierbare Synthese-/Step-Quelle je Kanal (Synth-Source-Registry). */
export type V2SynthVoice = 'kick' | 'hat' | 'clap' | 'bass' | 'lead' | 'phase' | 'epiano';

export interface V2SynthSourceConfig {
  freq: number;
  /** AUDIO-P0-001: Synthese-Stimme je Kanal (Rollen-Default statt 440-Hz-Sinus). */
  voice: V2SynthVoice;
  /** FEAT-P3-002: Phase-Distortion-Tiefe 0..1 (nur `voice === 'phase'`). */
  amount?: number;
  /** FEAT-P3-002: FM-Index (nur `voice === 'epiano'`). */
  modIndex?: number;
}

/** AUDIO-P0-001: Rollen-Default-Stimmen je V2-Kanal (V1-Parität kick/hat/clap/bass). */
const ROLE_VOICE: Record<V2Channel, V2SynthVoice> = {
  channel1: 'kick',
  channel2: 'hat',
  channel3: 'clap',
  channel4: 'lead',
  channel5: 'lead',
  channel6: 'lead',
  channel7: 'bass',
  channel8: 'lead',
  channel9: 'lead',
  channel10: 'lead',
};

const ROLE_FREQ: Record<V2Channel, number> = {
  channel1: 50,   // kick
  channel2: 6000, // hat
  channel3: 1200, // clap
  channel4: 440,
  channel5: 440,
  channel6: 440,
  channel7: 55,   // bass
  channel8: 880,  // lead
  channel9: 440,
  channel10: 440,
};

const DEFAULT_TEST_FREQ = 440;
const DEFAULT_TEST_AMPLITUDE = 0.2;
const SILENCE_CHANNEL_COUNT = 1;

export class V2SinkEngine {
  readonly studio: V2MonitorGraph;
  readonly outputGraph: V2OutputGraph;

  private testToneActive = false;
  private freq = DEFAULT_TEST_FREQ;
  private amplitude = DEFAULT_TEST_AMPLITUDE;
  private phase = 0;
  private currentTime = 0;
  private lastBlockSize = 0;
  private outputLayoutId = 'stereo';
  /** Wiederverwendeter Stille-Buffer (keine Allokation im inaktiven Hot-Path). */
  private silenceBuffer = new Float32Array(0);
  /** Hochgeladene Sample-Quellen je Kanal (Phase 3). */
  private readonly sampleBuffers = new Map<V2Channel, V2LoadedSample>();
  /** Aktive Sample-Playback-Zustände je Kanal. */
  private readonly samplePlayback = new Map<V2Channel, V2SamplePlaybackState>();
  /** Synth-/Step-Quellen je Kanal (Phase 3, V2-Source-Registry). */
  private readonly synthSources = new Map<V2Channel, V2SynthSourceConfig>();
  /** AUDIO-P0-001: stummgeschaltete Kanäle (V1-Mute-Parität). */
  private readonly mutedChannels = new Set<V2Channel>();
  /** Extern erzeugte Blöcke (z. B. SFZ-Voice-Bank) für den aktuellen Render-Block. */
  private readonly externalSources = new Map<V2Channel, Float32Array[]>();
  /** AUDIO-P0-003: manuell getriggerte Synth-Events (z. B. Pads/Instruments). */
  private readonly pendingSynthTriggers: V2StepRenderEvent[] = [];

  constructor(sampleRate = 48000, blockSize = 128) {
    this.studio = new V2MonitorGraph(sampleRate, blockSize);
    this.outputGraph = new V2OutputGraph(sampleRate);
    this.lastBlockSize = blockSize;
  }

  get isTestToneActive(): boolean {
    return this.testToneActive;
  }

  /** Schaltet den V2-Testton auf channel1 ein/aus. */
  setTestTone(active: boolean, freq = DEFAULT_TEST_FREQ, amplitude = DEFAULT_TEST_AMPLITUDE): void {
    this.testToneActive = active;
    if (active) {
      this.freq = Number.isFinite(freq) && freq > 0 ? Math.max(20, Math.min(20000, freq)) : DEFAULT_TEST_FREQ;
      this.amplitude = Number.isFinite(amplitude) ? Math.max(0, Math.min(0.9, amplitude)) : DEFAULT_TEST_AMPLITUDE;
    }
  }

  /** Setzt den Kanal-Gain in dB auf der V2-Graph-Instanz. */
  setChannelGainDb(channel: V2Channel, db: number): void {
    this.studio.setGainDb(channel, db);
  }

  /** Setzt das Stereo-Pan (-1..1) auf der V2-Graph-Instanz. */
  setChannelPan(channel: V2Channel, pan: number): void {
    this.studio.setPan(channel, pan);
  }

  /** Setzt den Master-Gain (linear, 0..2) auf der V2-Graph-Instanz. */
  setMasterGain(value: number): void {
    this.studio.setMasterGain(value);
  }

  // -------------------------------------------------------------------------
  // AUDIO-P0-004: Master-Processing-Setter
  // -------------------------------------------------------------------------

  setMasterEq(lowDb: number, midDb: number, highDb: number): void {
    this.studio.setMasterEq(lowDb, midDb, highDb);
  }

  setMasterDsp(cutoff: number, resonance: number, depth: number, drive: number): void {
    this.studio.setMasterDsp(cutoff, resonance, depth, drive);
  }

  /** FEAT-P3-002: optionale Modulations-Matrix (LFO → Master-Gain). */
  setMasterModMatrix(enabled: boolean, rate: number, depth: number): void {
    this.studio.setMasterModMatrix(enabled, rate, depth);
  }

  /** FEAT-P3-002: optionale HQ-Reverb (4-Leitungs-FDN) auf dem Master. */
  setMasterReverb(enabled: boolean, mix: number, decayS: number, damping: number, sizeScale?: number): void {
    this.studio.setMasterReverb(enabled, mix, decayS, damping, sizeScale);
  }

  setMasterFx(wet: number, feedback: number, rate: number, depth: number): void {
    this.studio.setMasterFx(wet, feedback, rate, depth);
  }

  setMasterDynamics(enabled: boolean, threshold: number, ratio: number, makeup: number): void {
    this.studio.setMasterDynamics(enabled, threshold, ratio, makeup);
  }

  setMasterMastering(threshold: number, ratio: number, makeup: number, ceiling: number): void {
    this.studio.setMasterMastering(threshold, ratio, makeup, ceiling);
  }

  /** Phase 4: Übernimmt einen MonitorRoutingPlan in den V2-Monitor-Graph. */
  applyMonitorRouting(plan: MonitorRoutingPlan): void {
    if (!plan) return;
    this.studio.applyMonitorPlan(plan);
  }

  /** Aktueller Monitor-Plan des V2-Graphs (für Sync/Diagnose). */
  getMonitorRouting(): MonitorRoutingPlan {
    return this.studio.monitorPlan;
  }

  /** Phase 4: Ausgabe-Layout (stereo/2.1/N.x) des V2-Output-Graphs setzen. */
  setOutputLayout(layoutId: string): void {
    this.outputLayoutId = layoutId || 'stereo';
    this.outputGraph.setLayout(this.outputLayoutId);
  }

  getOutputLayout(): string {
    return this.outputLayoutId;
  }

  /** Registriert eine Sample-Quelle für einen Kanal (Phase 3). */
  setSampleBuffer(channel: V2Channel, left: Float32Array, right?: Float32Array | null, sourceRate = 48000): void {
    if (!left) return;
    this.stopSample(channel);
    this.sampleBuffers.set(channel, {
      left,
      right: right ?? undefined,
      sourceRate: Math.max(8000, Math.min(192000, sourceRate)),
    });
  }

  /** Entfernt die Sample-Quelle eines Kanals. */
  clearSampleBuffer(channel: V2Channel): void {
    this.stopSample(channel);
    this.sampleBuffers.delete(channel);
  }

  /** Hat der Kanal eine Sample-Quelle? */
  hasSample(channel: V2Channel): boolean {
    return this.sampleBuffers.has(channel);
  }

  /** Startet die Sample-Wiedergabe eines Kanals (retrigger-fähig). */
  triggerSample(channel: V2Channel, options: V2SampleTriggerOptions = {}): boolean {
    const sample = this.sampleBuffers.get(channel);
    if (!sample) return false;
    const offsetSec = Math.max(0, options.offset ?? 0);
    const position = Math.min(sample.left.length - 1, Math.round(offsetSec * sample.sourceRate));
    this.samplePlayback.set(channel, {
      ...sample,
      playing: true,
      loop: Boolean(options.loop),
      rate: Math.max(0.25, Math.min(4, options.rate ?? 1)),
      position,
    });
    return true;
  }

  /** Stoppt die Sample-Wiedergabe eines Kanals. */
  stopSample(channel: V2Channel): void {
    const state = this.samplePlayback.get(channel);
    if (state) state.playing = false;
  }

  /** Läuft auf dem Kanal gerade eine Sample-Wiedergabe? */
  isSamplePlaying(channel: V2Channel): boolean {
    return this.samplePlayback.get(channel)?.playing === true;
  }

  /** Registriert eine Synth-/Step-Quelle für einen Kanal (Source-Registry). */
  setSynthSource(channel: V2Channel, config: V2SynthSourceConfig): void {
    if (config && Number.isFinite(config.freq) && config.freq > 0) {
      this.synthSources.set(channel, {
        freq: Math.max(20, Math.min(20000, config.freq)),
        voice: config.voice ?? ROLE_VOICE[channel] ?? 'lead',
        // FEAT-P3-002: optionale Quellen-Parameter (Phase-Distortion/E-Piano).
        ...(config.amount === undefined ? {} : { amount: config.amount }),
        ...(config.modIndex === undefined ? {} : { modIndex: config.modIndex }),
      });
    }
  }

  /** Liefert die registrierte Synth-Quelle (Rollen-Default statt 440-Hz-Sinus). */
  getSynthSource(channel: V2Channel): V2SynthSourceConfig {
    return this.synthSources.get(channel) ?? { freq: ROLE_FREQ[channel] ?? 440, voice: ROLE_VOICE[channel] ?? 'lead' };
  }

  /** AUDIO-P0-001: Stummschaltung eines Kanals im V2-Live-Pfad. */
  setChannelMuted(channel: V2Channel, muted: boolean): void {
    if (muted) this.mutedChannels.add(channel);
    else this.mutedChannels.delete(channel);
  }

  /** AUDIO-P0-001: Ist der Kanal im V2-Live-Pfad stummgeschaltet? */
  isChannelMuted(channel: V2Channel): boolean {
    return this.mutedChannels.has(channel);
  }

  /** AUDIO-P0-003: Manueller Synth-Trigger (Pads/Instruments) – wird im nächsten Block gerendert. */
  triggerSynth(channel: V2Channel, velocity = 1): void {
    const source = this.getSynthSource(channel);
    this.pendingSynthTriggers.push({
      track: channel,
      startSample: 0,
      velocity: Math.max(0, Math.min(1, velocity)),
      freq: source.freq,
    });
  }

  /** Übergibt einen extern erzeugten Audio-Block (z. B. SFZ) für den nächsten Render. */
  setExternalSource(channel: V2Channel, block: Float32Array[]): void {
    if (!block || block.length === 0) return;
    this.externalSources.set(channel, block);
  }

  /**
   * Rendert genau einen Audio-Block durch den V2-Graph.
   * `events` können sample-genaue Step-Bursts auf beliebigen Kanälen auslösen
   * (Phase 2). Liefert einen Stereo-Output (Float32Array[2]) – auch bei
   * inaktivem Testton (Stille), damit der Worklet-Output nie `null` ist.
   */
  render(ctx: IProcessingContext, events: V2StepRenderEvent[] = []): Float32Array[] {
    this.ensureSourceBlockSize(ctx.bufferSize);

    // AUDIO-P0-003: manuelle Synth-Trigger (Pads/Instruments) mit verarbeiten.
    const allEvents = this.pendingSynthTriggers.length > 0
      ? [...events, ...this.pendingSynthTriggers]
      : events;
    this.pendingSynthTriggers.length = 0;

    const usedChannels = new Set<V2Channel>();

    // Phase 3 Rest: extern erzeugte Quellen (SFZ/Instrument) zuerst übernehmen.
    for (const [channel, block] of this.externalSources) {
      this.studio.setSourceBuffer(channel, block);
      usedChannels.add(channel);
    }
    this.externalSources.clear();

    // Phase 3: laufende Sample-Quellen zuerst rendern (Sample-Player als V2-Source).
    for (const channel of V2_CHANNELS) {
      if (usedChannels.has(channel)) continue;
      // AUDIO-P0-001: stummgeschaltete Kanäle liefern Stille (Mute-Parität).
      if (this.mutedChannels.has(channel)) continue;
      const state = this.samplePlayback.get(channel);
      if (!state?.playing) continue;
      const block = this.renderSampleBlock(state, ctx.bufferSize, ctx.sampleRate);
      this.studio.setSourceBuffer(channel, block);
      usedChannels.add(channel);
    }

    for (const event of allEvents) {
      if (!event || event.startSample < 0 || event.startSample >= ctx.bufferSize) continue;
      // AUDIO-P0-001: Mute + rollenbasierte Synthese-Stimme.
      if (this.mutedChannels.has(event.track)) continue;
      const source = this.getSynthSource(event.track);
      const burst = this.renderStepBurst(event, ctx.bufferSize, ctx.sampleRate, source.voice, source.amount, source.modIndex);
      this.studio.setSourceBuffer(event.track, [burst]);
      usedChannels.add(event.track);
    }

    if (!usedChannels.has('channel1')) {
      if (this.testToneActive) {
        const tone = this.renderToneBlock(ctx.bufferSize, ctx.sampleRate);
        this.studio.setSourceBuffer('channel1', [tone]);
        usedChannels.add('channel1');
      } else {
        // Immer Stille setzen, damit ein zuvor aktiver Testton/Step nicht weitertönt.
        this.studio.setSourceBuffer('channel1', [this.silenceBuffer]);
      }
    }

    // Alle nicht durch Step-Events belegten Kanäle auf Stille setzen, damit
    // keine alten Bursts aus früheren Blöcken nachklingen.
    for (const channel of V2_CHANNELS) {
      if (usedChannels.has(channel)) continue;
      this.studio.setSourceBuffer(channel, [this.silenceBuffer]);
    }

    // Phase 4: Der Live-Output ist der lokale Monitor-Ausgang (MAIN/Cue/Monitor).
    const rendered = this.studio.renderMonitor(ctx);
    const stereo = rendered ?? [new Float32Array(ctx.bufferSize), new Float32Array(ctx.bufferSize)];
    // Phase 4: Ausgangs-Graph für 2.1-/Mehrkanal-Layouts (Stereo bleibt Stereo).
    this.outputGraph.setInputStereo(stereo[0], stereo[1] ?? stereo[0]);
    const output = this.outputGraph.render(ctx) ?? stereo;
    this.currentTime += ctx.quantum;
    this.lastBlockSize = ctx.bufferSize;

    return output;
  }

  /** Setzt Engine und V2-Graph in den Ausgangszustand. */
  reset(): void {
    this.studio.reset();
    this.outputGraph.reset();
    this.outputLayoutId = 'stereo';
    this.outputGraph.setLayout('stereo');
    this.testToneActive = false;
    this.freq = DEFAULT_TEST_FREQ;
    this.amplitude = DEFAULT_TEST_AMPLITUDE;
    this.phase = 0;
    this.currentTime = 0;
    this.samplePlayback.clear();
    this.sampleBuffers.clear();
    this.synthSources.clear();
    this.mutedChannels.clear();
    this.bassFilterState = 0;
    this.pendingSynthTriggers.length = 0;
    this.externalSources.clear();
  }

  /** Rendert den nächsten Block einer laufenden Sample-Quelle. */
  private renderSampleBlock(state: V2SamplePlaybackState, length: number, ctxSampleRate: number): Float32Array[] {
    const outL = new Float32Array(length);
    const outR = state.right ? new Float32Array(length) : null;
    const advance = state.rate * (state.sourceRate / ctxSampleRate);
    let ended = false;

    for (let i = 0; i < length; i++) {
      let idx = Math.floor(state.position);
      if (idx >= state.left.length) {
        if (!state.loop) {
          ended = true;
          break;
        }
        state.position %= state.left.length;
        idx = Math.floor(state.position);
      }
      outL[i] = state.left[idx] ?? 0;
      if (outR) outR[i] = state.right?.[idx] ?? state.left[idx] ?? 0;
      state.position += advance;
    }

    if (!ended && !state.loop && state.position >= state.left.length) ended = true;
    if (ended) state.playing = false;
    return outR ? [outL, outR] : [outL];
  }

  /**
   * AUDIO-P0-001: Rollenbasierte Step-Stimme (kick/hat/clap/bass/lead).
   * Kein 440-Hz-Sinus-Default mehr – jede Rolle hat ihre eigene Synthese.
   * FEAT-P3-002: zusätzlich `phase` (Phase-Distortion-Oszillator) und `epiano`
   * (FM-E-Piano) aus den optionalen DSP-Bausteinen.
   */
  private renderStepBurst(
    event: V2StepRenderEvent,
    length: number,
    sampleRate: number,
    voice: V2SynthVoice,
    amount?: number,
    modIndex?: number,
  ): Float32Array {
    const buffer = new Float32Array(length);
    const start = Math.max(0, Math.min(length - 1, event.startSample));
    const freq = Number.isFinite(event.freq) && event.freq > 0 ? Math.max(20, Math.min(20000, event.freq)) : ROLE_FREQ[event.track] ?? 440;
    const amp = Math.max(0, Math.min(1, event.velocity)) * 0.8;
    const sr = Math.max(8000, sampleRate);
    const decay = voice === 'kick' ? 14 : voice === 'bass' ? 9 : voice === 'clap' ? 22 : 18;
    const baseFreq = voice === 'kick' ? Math.min(freq, 120) : voice === 'bass' ? Math.min(freq, 160) : freq;
    const phaseAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount as number)) : 0.6;
    const pianoModIndex = Number.isFinite(modIndex) ? Math.max(0, Math.min(12, modIndex as number)) : 2.4;
    let phase = 0;
    let noiseState = 1;
    let noiseHp = 0;
    // FEAT-P3-002: Das E-Piano ist eine komplette FM-Stimme (eigene Hüllkurve
    // Anschlag → Sustain). Sie wird einmal für die Burst-Länge gerendert.
    const pianoNote = voice === 'epiano'
      ? renderElectricPiano(baseFreq, {
          sampleRate: sr,
          durationS: Math.max(0.01, (length - start) / sr),
          modIndex: pianoModIndex,
          gain: 1,
        })
      : null;

    const nextNoise = (): number => {
      noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
      return (noiseState / 4294967296) * 2 - 1;
    };

    for (let i = start; i < length; i++) {
      const t = (i - start) / sr;
      const env = Math.exp(-t * decay);
      let s = 0;
      switch (voice) {
        case 'kick': {
          // Sinus mit schnellem Frequenz-Sweep (150 Hz → 40 Hz) + Klick.
          const f = 40 + 110 * Math.exp(-t * 40);
          phase += f / sr;
          s = Math.sin(2 * Math.PI * phase) * env;
          if (t < 0.004) s += nextNoise() * 0.4 * (1 - t / 0.004);
          break;
        }
        case 'hat': {
          // Hochpass-gefiltertes Rauschen (Differenzfilter).
          const n = nextNoise() * 0.6;
          s = (n - noiseHp) * env;
          noiseHp = n;
          break;
        }
        case 'clap': {
          // Mehrfach-Burst-Rauschen (3 schnelle Impulse).
          const burst = t < 0.012 ? 1 : t < 0.02 ? 0.7 : t < 0.03 ? 0.5 : 0;
          s = nextNoise() * burst * env;
          break;
        }
        case 'bass': {
          // Sägezahn mit One-Pole-Lowpass (V1-MonoSynth-Charakter).
          phase += baseFreq / sr;
          if (phase >= 1) phase -= 1;
          const saw = (phase * 2 - 1) * env;
          s = this.bassFilterState + 0.25 * (saw - this.bassFilterState);
          this.bassFilterState = s;
          break;
        }
        case 'phase': {
          // Casio-CZ-Phasenverzerrung: nichtlineare Phase erzeugt harte Kanten.
          phase += freq / sr;
          if (phase >= 1) phase -= 1;
          s = phaseDistortionSample(phase, phaseAmount, 'saw', 0.9) * env;
          break;
        }
        case 'epiano': {
          // FM-Stimme mit eigener Hüllkurve (kein zusätzliches env nötig).
          s = pianoNote ? (pianoNote[i - start] ?? 0) : 0;
          break;
        }
        default: {
          // Lead: Sinus-Burst (unverändert, aber mit Rollen-Frequenz).
          phase += freq / sr;
          s = Math.sin(2 * Math.PI * phase) * env;
          break;
        }
      }
      buffer[i] = Number.isFinite(s) ? Math.max(-1, Math.min(1, s * amp)) : 0;
    }
    return buffer;
  }

  /** One-Pole-Filter-Zustand für die Bass-Stimme. */
  private bassFilterState = 0;

  private renderToneBlock(length: number, sampleRate: number): Float32Array {
    const buffer = new Float32Array(length);
    const dt = this.freq / sampleRate;
    for (let i = 0; i < length; i++) {
      buffer[i] = Math.sin(2 * Math.PI * this.phase) * this.amplitude;
      this.phase = (this.phase + dt) % 1;
    }
    return buffer;
  }

  /** Hält alle V2-Source-Buffer auf der aktuellen Blockgröße (Robustheit). */
  private ensureSourceBlockSize(length: number): void {
    if (this.silenceBuffer.length !== length) {
      this.silenceBuffer = new Float32Array(length);
    }
    if (this.lastBlockSize === length) return;
    for (const channel of V2_CHANNELS) {
      const source = this.studio.sources.get(channel);
      if (!source) continue;
      const current = source.sourceBuffer;
      if (!current || current[0]?.length !== length || current.length !== SILENCE_CHANNEL_COUNT) {
        this.studio.setSourceBuffer(channel, [this.silenceBuffer]);
      }
    }
    this.lastBlockSize = length;
  }
}
