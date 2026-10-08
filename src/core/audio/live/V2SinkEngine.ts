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
 * RT-AUDIT-P0-001: Step-/Synth-Trigger starten Stimmen in einem persistenten,
 * vorallokierten Voice-Pool (32 Slots). Jede Stimme klingt über beliebig viele
 * Render-Blöcke aus (Hüllkurve < −80 dB oder max. 2 s) – vorher brach jeder
 * Step nach genau einem 128er-Block (2,67 ms) ab. Der Stimmen-Pfad in
 * `render()` allokiert nicht (vorallokierte Kanal-Puffer, Flags, Ringpuffer);
 * auch das E-Piano wird sample-weise ohne Puffer berechnet, es verbleibt dort
 * also keine Allokation pro Anschlag.
 *
 * Die Klasse enthält KEINE WebAudio-/AudioWorklet-API und ist damit sowohl im
 * AudioWorklet (über den v2SinkProcessor) als auch in Node-Tests nutzbar.
 */
import { V2_CHANNELS, type V2Channel } from '../V2StudioGraph';
import { V2MonitorGraph } from '../V2MonitorGraph';
import { V2OutputGraph } from '../V2OutputGraph';
import type { IProcessingContext } from '../types';
import type { MonitorRoutingPlan } from '../monitorRouting';
import type { SfzRegion } from '../../instrument/sfzRegion';
import type { ControlRingBuffers } from './controlRing';
import { phaseDistortionSample } from '../../dsp/phaseDistortion';
import {
  configureElectricPiano,
  createElectricPianoParams,
  electricPianoSample,
  type ElectricPianoOptions,
  type ElectricPianoParams,
} from '../../dsp/electricPiano';
import { ItSynthBank, type InstrumentPitchDef } from '../../instrument/itSynthVoice';

export interface V2SinkMessage {
  type: 'test-tone' | 'gain-db' | 'pan' | 'master-gain' | 'transport' | 'pattern'
    | 'sample-load' | 'sample-assign' | 'sample-unload' | 'sample-trigger' | 'sample-stop' | 'synth-source'
    | 'sfz-regions' | 'sfz-note-on' | 'sfz-note-off' | 'monitor-plan' | 'output-layout'
    | 'master-eq' | 'master-dsp' | 'master-fx' | 'master-dynamics' | 'master-mastering'
    | 'mute' | 'synth-trigger' | 'master-mod-matrix' | 'master-reverb' | 'control-ring';
  /** RT-AUDIT-P1-010 (Schritt 2): Steuer-Ring (SharedArrayBuffer, nur bei crossOriginIsolated). */
  ring?: ControlRingBuffers;
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
  /**
   * RT-AUDIT-P1-010: Sample-Pool. `sample-load {id, left, right, sourceRate}`
   * kommt MIT Transfer-Liste (kein Klonen im Audio-Thread), danach ordnet
   * `sample-assign {channel, id}` das Sample einem Kanal zu; `sample-unload {id}`
   * gibt es frei. Die frühere `sample-set`-Nachricht (Arrays pro Kanal, ohne
   * Transfer) gibt es nicht mehr.
   */
  id?: string;
  left?: Float32Array;
  right?: Float32Array | null;
  sourceRate?: number;
  loop?: boolean;
  rate?: number;
  offset?: number;
  /**
   * RT-AUDIT-P1-010: `sfz-regions` – im Main-Thread geparste Regionen-Tabelle;
   * `sources` kommen per Transfer. Kein SFZ-Text mehr im Audio-Thread.
   */
  regions?: SfzRegion[];
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
  /**
   * RT-AUDIT-P0-001 (Nebenbefund): Startsample innerhalb des NÄCHSTEN
   * Render-Blocks (0..bufferSize-1). Step-getriggerte Samples starten damit
   * sample-genau am Step statt am Blockanfang. Default 0.
   */
  startSample?: number;
}

interface V2LoadedSample {
  left: Float32Array;
  right?: Float32Array;
  sourceRate: number;
}

/**
 * Playback-Zustand je Kanal. Das Objekt wird EINMAL je Kanal angelegt
 * (`setSampleBuffer`, außerhalb des Render-Pfads) und bei jedem Trigger nur
 * mutiert – vorher entstand pro Trigger ein `{...sample}`-Objekt.
 */
interface V2SamplePlaybackState extends V2LoadedSample {
  playing: boolean;
  loop: boolean;
  rate: number;
  /** Leseposition in Source-Samples. */
  position: number;
  /** Ausstehender (Re-)Start im nächsten Block: Startsample, −1 = keiner. */
  pendingStart: number;
  pendingPosition: number;
  pendingLoop: boolean;
  pendingRate: number;
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
  channel2: 'lead',
  channel3: 'hat',
  channel4: 'lead',
  channel5: 'lead',
  channel6: 'lead',
  channel7: 'lead',
  channel8: 'bass',
};

const ROLE_FREQ: Record<V2Channel, number> = {
  channel1: 50,   // kick
  channel2: 440,
  channel3: 6000, // hat
  channel4: 440,
  channel5: 440,
  channel6: 440,
  channel7: 440,
  channel8: 55,   // bass
};

const DEFAULT_TEST_FREQ = 440;
const DEFAULT_TEST_AMPLITUDE = 0.2;
const SILENCE_CHANNEL_COUNT = 1;

// ---------------------------------------------------------------------------
// RT-AUDIT-P0-001: persistenter Voice-Pool
// ---------------------------------------------------------------------------
/** Feste Anzahl vorallokierter Stimmen (Voice-Stealing ab der 33.). */
export const V2_MAX_VOICES = 32;
/** Stimme endet, sobald die Hüllkurve (inkl. Velocity) darunter fällt (−80 dB). */
const VOICE_SILENCE_THRESHOLD = 1e-4;
/** Maximale Stimmdauer in Sekunden (davor 64-Sample-Ausblendung). */
const VOICE_MAX_DURATION_S = 2;
/** Länge der linearen Ausblendung (Mono-Retrigger, Mute, Maximaldauer). */
export const V2_VOICE_FADE_SAMPLES = 64;
/** Kapazität des Ringpuffers für ausstehende Synth-Trigger (Pads/Steps). */
const PENDING_TRIGGER_CAPACITY = 64;

/** Stimmen als kleine Ganzzahlen – kein String-Vergleich im Sample-Loop. */
const VOICE_KICK = 0;
const VOICE_HAT = 1;
const VOICE_CLAP = 2;
const VOICE_BASS = 3;
const VOICE_LEAD = 4;
const VOICE_PHASE = 5;
const VOICE_EPIANO = 6;

function voiceKindOf(voice: V2SynthVoice): number {
  switch (voice) {
    case 'kick': return VOICE_KICK;
    case 'hat': return VOICE_HAT;
    case 'clap': return VOICE_CLAP;
    case 'bass': return VOICE_BASS;
    case 'phase': return VOICE_PHASE;
    case 'epiano': return VOICE_EPIANO;
    default: return VOICE_LEAD;
  }
}

/**
 * Ein Voice-Slot. Alle Felder sind Zahlen/Booleans (monomorph, keine
 * Allokation beim Wiederverwenden); der E-Piano-Parametersatz wird einmal je
 * Slot angelegt und bei jedem Anschlag nur neu befüllt.
 */
class V2Voice {
  active = false;
  /** Kanalindex in `V2_CHANNELS`. */
  channelIdx = 0;
  kind = VOICE_LEAD;
  /** Startreihenfolge (für Voice-Stealing: kleinster Wert = älteste Stimme). */
  serial = 0;
  freq = 440;
  baseFreq = 440;
  /** Velocity-Amplitude (0..0,8). */
  amp = 0;
  decay = 18;
  phaseAmount = 0.6;
  phase = 0;
  /** Verstrichene Samples seit Anschlag. */
  elapsed = 0;
  noiseState = 1;
  noiseHp = 0;
  /** Eigener One-Pole-Lowpass-Zustand (vorher EIN globaler Zustand für alle Stimmen). */
  bassFilter = 0;
  /** Startsample im ersten Block (danach 0). */
  startOffset = 0;
  /** Ausblendung beginnt bei diesem Sample des aktuellen Blocks (−1 = keine angefordert). */
  fadeStart = -1;
  /** Verbleibende Ausblend-Samples (> 0 = blendet gerade aus). */
  fadeLeft = 0;
  readonly piano: ElectricPianoParams = createElectricPianoParams();
}

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
  /** Vorallokiertes Ein-Element-Array `[silenceBuffer]` für `setSourceBuffer`. */
  private silenceBlock: Float32Array[] = [this.silenceBuffer];
  /** RT-AUDIT-P0-001: persistenter, vorallokierter Voice-Pool. */
  private readonly voices: V2Voice[] = [];
  private voiceSerial = 0;
  /** Vorallokierter Mono-Mischpuffer je Kanal + Ein-Element-Array für `setSourceBuffer`. */
  private voiceBuffers: Float32Array[] = [];
  private voiceBlocks: Float32Array[][] = [];
  /** Kanal hat im aktuellen Block mind. eine aktive Stimme (Index = V2_CHANNELS). */
  private readonly voiceOnChannel: boolean[] = [];
  /** Kanal ist im aktuellen Block bereits belegt (ersetzt das frühere `new Set()`). */
  private readonly channelUsed: boolean[] = [];
  /** Vorallokierte Sample-Render-Puffer je Kanal (mono/stereo). */
  private sampleOutL: Float32Array[] = [];
  private sampleOutR: Float32Array[] = [];
  private sampleBlockMono: Float32Array[][] = [];
  private sampleBlockStereo: Float32Array[][] = [];
  /**
   * RT-AUDIT-P0-002: vorallokierter Testton-Puffer + Ein-Element-Block (vorher
   * pro Block `new Float32Array` + `[tone]`) und Stille-Stereo-Rückfall.
   */
  private toneBuffer = new Float32Array(0);
  private toneBlock: Float32Array[] = [this.toneBuffer];
  private silentStereo: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  /** Extern erzeugte Blöcke (z. B. SFZ) je Kanalindex für den nächsten Render. */
  private readonly externalBlocks: (Float32Array[] | null)[] = [];
  /** Ringpuffer ausstehender Synth-Trigger (Pads/Instruments/Steps). */
  private readonly pendingChannel = new Int32Array(PENDING_TRIGGER_CAPACITY);
  private readonly pendingStart = new Int32Array(PENDING_TRIGGER_CAPACITY);
  private readonly pendingVelocity = new Float64Array(PENDING_TRIGGER_CAPACITY);
  /** Frequenz des Triggers; NaN = registrierte Quelle bzw. Rollen-Default. */
  private readonly pendingFreq = new Float64Array(PENDING_TRIGGER_CAPACITY);
  private pendingHead = 0;
  private pendingCount = 0;
  /** Wiederverwendetes Optionsobjekt für `configureElectricPiano`. */
  private readonly pianoOptions: ElectricPianoOptions = { sampleRate: 48000, modIndex: 2.4, gain: 1 };
  /** Hochgeladene Sample-Quellen je Kanal (Phase 3). */
  private readonly sampleBuffers = new Map<V2Channel, V2LoadedSample>();
  /** Aktive Sample-Playback-Zustände je Kanal. */
  private readonly samplePlayback = new Map<V2Channel, V2SamplePlaybackState>();
  /** Synth-/Step-Quellen je Kanal (Phase 3, V2-Source-Registry). */
  private readonly synthSources = new Map<V2Channel, V2SynthSourceConfig>();
  /** AUDIO-P0-001: stummgeschaltete Kanäle (V1-Mute-Parität). */
  private readonly mutedChannels = new Set<V2Channel>();

  /** itSynth bank for instrument playback on channel4 (RT-AUDIT-P0-006). */
  private readonly itSynth = new ItSynthBank();

  constructor(sampleRate = 48000, blockSize = 128) {
    this.studio = new V2MonitorGraph(sampleRate, blockSize);
    this.outputGraph = new V2OutputGraph(sampleRate);
    this.lastBlockSize = blockSize;
    for (let v = 0; v < V2_MAX_VOICES; v++) this.voices.push(new V2Voice());
    for (let c = 0; c < V2_CHANNELS.length; c++) {
      this.voiceOnChannel.push(false);
      this.channelUsed.push(false);
      this.externalBlocks.push(null);
    }
    this.allocateChannelBuffers(blockSize);
  }

  /** Anzahl aktuell klingender Stimmen im Voice-Pool (Diagnose/Tests). */
  get activeVoiceCount(): number {
    let n = 0;
    for (let v = 0; v < this.voices.length; v++) if (this.voices[v].active) n++;
    return n;
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
    const loaded: V2LoadedSample = {
      left,
      right: right ?? undefined,
      sourceRate: Math.max(8000, Math.min(192000, sourceRate)),
    };
    this.sampleBuffers.set(channel, loaded);
    // Playback-Zustand einmal je Kanal anlegen und danach nur mutieren.
    const state = this.samplePlayback.get(channel);
    if (state) {
      state.left = loaded.left;
      state.right = loaded.right;
      state.sourceRate = loaded.sourceRate;
      state.position = 0;
    } else {
      this.samplePlayback.set(channel, {
        ...loaded,
        playing: false,
        loop: false,
        rate: 1,
        position: 0,
        pendingStart: -1,
        pendingPosition: 0,
        pendingLoop: false,
        pendingRate: 1,
      });
    }
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

  /**
   * Startet die Sample-Wiedergabe eines Kanals (retrigger-fähig).
   * Der Start erfolgt im nächsten Render-Block bei `options.startSample`
   * (sample-genau); eine bereits laufende Wiedergabe spielt bis dahin weiter.
   * Allokationsfrei: der Playback-Zustand des Kanals wird wiederverwendet.
   */
  triggerSample(channel: V2Channel, options?: V2SampleTriggerOptions): boolean {
    const state = this.samplePlayback.get(channel);
    if (!state || !this.sampleBuffers.has(channel)) return false;
    const offsetSec = Math.max(0, options?.offset ?? 0);
    const start = options?.startSample ?? 0;
    state.pendingStart = Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0;
    state.pendingPosition = Math.min(state.left.length - 1, Math.round(offsetSec * state.sourceRate));
    state.pendingLoop = Boolean(options?.loop);
    state.pendingRate = Math.max(0.25, Math.min(4, options?.rate ?? 1));
    return true;
  }

  /** Stoppt die Sample-Wiedergabe eines Kanals. */
  stopSample(channel: V2Channel): void {
    const state = this.samplePlayback.get(channel);
    if (state) {
      state.playing = false;
      state.pendingStart = -1;
    }
  }

  /** Läuft (oder startet im nächsten Block) auf dem Kanal eine Sample-Wiedergabe? */
  isSamplePlaying(channel: V2Channel): boolean {
    const state = this.samplePlayback.get(channel);
    return state !== undefined && (state.playing || state.pendingStart >= 0);
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
    if (muted) {
      this.mutedChannels.add(channel);
      // RT-AUDIT-P0-001: klingende Stimmen des Kanals in 64 Samples ausblenden
      // (ab dem Anfang des nächsten Blocks), statt hart abzuschneiden.
      const idx = V2_CHANNELS.indexOf(channel);
      for (let v = 0; v < this.voices.length; v++) {
        const voice = this.voices[v];
        if (voice.active && voice.channelIdx === idx) this.requestFade(voice, 0);
      }
    } else {
      this.mutedChannels.delete(channel);
    }
  }

  /** AUDIO-P0-001: Ist der Kanal im V2-Live-Pfad stummgeschaltet? */
  isChannelMuted(channel: V2Channel): boolean {
    return this.mutedChannels.has(channel);
  }

  /**
   * AUDIO-P0-003: Manueller Synth-Trigger (Pads/Instruments) – startet im
   * nächsten Block eine Stimme, die über beliebig viele Blöcke ausklingt.
   */
  triggerSynth(channel: V2Channel, velocity = 1): void {
    this.scheduleSynth(channel, 0, velocity);
  }

  // RT-AUDIT-P0-006: itSynth instrument methods
  /** Configure the itSynth instrument (RT-AUDIT-P0-006). */
  itConfig(def: InstrumentPitchDef): void {
    this.itSynth.config(def);
  }

  /** Trigger a note on the itSynth instrument (RT-AUDIT-P0-006). */
  itNoteOn(note: number | string, velocity = 1): void {
    this.itSynth.noteOn(note, velocity);
  }

  /** Release a note on the itSynth instrument (RT-AUDIT-P0-006). */
  itNoteOff(note?: number | string, fast = false): void {
    this.itSynth.noteOff(note, fast);
  }

  /** Release all notes on the itSynth instrument (RT-AUDIT-P0-006). */
  itAllNotesOff(): void {
    this.itSynth.allNotesOff();
  }

  /** Automate a parameter on the itSynth instrument (RT-AUDIT-P0-006). */
  itAutomate(param: string, value: number, rampTimeSec = 0.02): void {
    this.itSynth.automate(param, value, rampTimeSec);
  }

  /** Render itSynth into an external mono buffer (RT-AUDIT-P0-006). */
  renderItSynth(output: Float32Array): void {
    this.itSynth.renderBlock(output);
  }

  /**
   * RT-AUDIT-P0-001: Plant einen Synth-/Step-Trigger für den nächsten
   * Render-Block bei `startSample` (sample-genau). Allokationsfrei (Ringpuffer
   * fester Kapazität; bei Überlauf wird der älteste ausstehende Trigger
   * verworfen). `freq` weggelassen → registrierte Quelle bzw. Rollen-Default.
   */
  scheduleSynth(channel: V2Channel, startSample: number, velocity = 1, freq = Number.NaN): void {
    const idx = V2_CHANNELS.indexOf(channel);
    if (idx < 0) return;
    if (this.pendingCount >= PENDING_TRIGGER_CAPACITY) {
      this.pendingHead = (this.pendingHead + 1) % PENDING_TRIGGER_CAPACITY;
      this.pendingCount--;
    }
    const slot = (this.pendingHead + this.pendingCount) % PENDING_TRIGGER_CAPACITY;
    this.pendingChannel[slot] = idx;
    this.pendingStart[slot] = Number.isFinite(startSample) ? Math.max(0, Math.floor(startSample)) : 0;
    this.pendingVelocity[slot] = Number.isFinite(velocity) ? Math.max(0, Math.min(1, velocity)) : 1;
    this.pendingFreq[slot] = freq;
    this.pendingCount++;
  }

  /** Übergibt einen extern erzeugten Audio-Block (z. B. SFZ) für den nächsten Render. */
  setExternalSource(channel: V2Channel, block: Float32Array[]): void {
    if (!block || block.length === 0) return;
    const idx = V2_CHANNELS.indexOf(channel);
    if (idx >= 0) this.externalBlocks[idx] = block;
  }

  /**
   * Rendert genau einen Audio-Block durch den V2-Graph.
   * `events` können sample-genaue Step-Bursts auf beliebigen Kanälen auslösen
   * (Phase 2). Liefert einen Stereo-Output (Float32Array[2]) – auch bei
   * inaktivem Testton (Stille), damit der Worklet-Output nie `null` ist.
   *
   * RT-AUDIT-P0-001: Events starten Stimmen im persistenten Voice-Pool; eine
   * Stimme klingt über beliebig viele Blöcke aus (Hüllkurve < −80 dB oder 2 s).
   * Der Stimmen-Pfad ist allokationsfrei (vorallokierte Puffer/Flags/Ring).
   */
  render(ctx: IProcessingContext, events?: readonly V2StepRenderEvent[]): Float32Array[] {
    const length = ctx.bufferSize;
    this.ensureSourceBlockSize(length);
    const channelCount = V2_CHANNELS.length;
    for (let c = 0; c < channelCount; c++) this.channelUsed[c] = false;

    // Phase 3 Rest: extern erzeugte Quellen (SFZ/Instrument) zuerst übernehmen.
    for (let c = 0; c < channelCount; c++) {
      const block = this.externalBlocks[c];
      if (!block) continue;
      this.studio.setSourceBuffer(V2_CHANNELS[c], block);
      this.channelUsed[c] = true;
      this.externalBlocks[c] = null;
    }

    // Phase 3: laufende Sample-Quellen rendern (Sample-Player als V2-Source).
    for (let c = 0; c < channelCount; c++) {
      if (this.channelUsed[c]) continue;
      const channel = V2_CHANNELS[c];
      // AUDIO-P0-001: stummgeschaltete Kanäle liefern Stille (Mute-Parität).
      if (this.mutedChannels.has(channel)) continue;
      const state = this.samplePlayback.get(channel);
      if (!state || (!state.playing && state.pendingStart < 0)) continue;
      const block = this.renderSampleBlock(state, c, length, ctx.sampleRate);
      this.studio.setSourceBuffer(channel, block);
      this.channelUsed[c] = true;
    }

    // RT-AUDIT-P0-001: neue Stimmen starten (Events + ausstehende Trigger).
    if (events) {
      for (let e = 0; e < events.length; e++) {
        const event = events[e];
        if (!event || event.startSample < 0 || event.startSample >= length) continue;
        const idx = V2_CHANNELS.indexOf(event.track);
        if (idx < 0) continue;
        this.startVoice(idx, event.startSample, event.velocity, event.freq, ctx.sampleRate);
      }
    }
    while (this.pendingCount > 0) {
      const slot = this.pendingHead;
      const start = this.pendingStart[slot];
      this.startVoice(
        this.pendingChannel[slot],
        start < length ? start : length - 1,
        this.pendingVelocity[slot],
        this.pendingFreq[slot],
        ctx.sampleRate,
      );
      this.pendingHead = (this.pendingHead + 1) % PENDING_TRIGGER_CAPACITY;
      this.pendingCount--;
    }
    this.pendingHead = 0;

    // Stimmen in die vorallokierten Kanal-Puffer mischen.
    for (let c = 0; c < channelCount; c++) this.voiceOnChannel[c] = false;
    for (let v = 0; v < this.voices.length; v++) {
      const voice = this.voices[v];
      if (!voice.active) continue;
      const c = voice.channelIdx;
      const buffer = this.voiceBuffers[c];
      if (!this.voiceOnChannel[c]) {
        buffer.fill(0);
        this.voiceOnChannel[c] = true;
      }
      this.renderVoice(voice, buffer, length, ctx.sampleRate);
    }
    for (let c = 0; c < channelCount; c++) {
      if (!this.voiceOnChannel[c]) continue;
      const channel = V2_CHANNELS[c];
      const voiceBuffer = this.voiceBuffers[c];
      if (!this.channelUsed[c]) {
        this.studio.setSourceBuffer(channel, this.voiceBlocks[c]);
        this.channelUsed[c] = true;
        continue;
      }
      // Kanal ist schon durch Sample/External belegt: Stimmen dazumischen
      // (vorher ersetzte ein Step-Burst die Sample-/External-Quelle).
      const current = this.studio.sources.get(channel)?.sourceBuffer;
      if (current && (current === this.sampleBlockMono[c] || current === this.sampleBlockStereo[c])) {
        // Eigene Sample-Puffer: in-place addieren (alle Kanäle des Blocks).
        for (let k = 0; k < current.length; k++) {
          const target = current[k];
          for (let i = 0; i < length; i++) target[i] += voiceBuffer[i];
        }
      } else {
        // Fremder External-Block (z. B. SFZ-Scratch, mono): in den eigenen
        // Stimmen-Puffer addieren, fremde Puffer bleiben unverändert.
        const ext = current ? current[0] : undefined;
        if (ext) {
          const n = Math.min(length, ext.length);
          for (let i = 0; i < n; i++) voiceBuffer[i] += ext[i];
        }
        this.studio.setSourceBuffer(channel, this.voiceBlocks[c]);
      }
    }

    if (!this.channelUsed[0] && this.testToneActive) {
      this.renderToneBlock(length, ctx.sampleRate);
      this.studio.setSourceBuffer('channel1', this.toneBlock);
      this.channelUsed[0] = true;
    }

    // Alle Kanäle ohne Quelle in diesem Block auf Stille setzen. Klingende
    // Stimmen zählen als Quelle (Voice-Pool) – ein Step reißt daher nicht mehr
    // nach einem Block ab (RT-AUDIT-P0-001), abgeklungene Stimmen sind frei.
    for (let c = 0; c < channelCount; c++) {
      if (this.channelUsed[c]) continue;
      this.studio.setSourceBuffer(V2_CHANNELS[c], this.silenceBlock);
    }

    // Phase 4: Der Live-Output ist der lokale Monitor-Ausgang (MAIN/Cue/Monitor).
    const rendered = this.studio.renderMonitor(ctx);
    const stereo = rendered ?? this.silentStereo;
    // Phase 4: Ausgangs-Graph für 2.1-/Mehrkanal-Layouts (Stereo bleibt Stereo).
    this.outputGraph.setInputStereo(stereo[0], stereo[1] ?? stereo[0]);
    const output = this.outputGraph.render(ctx) ?? stereo;
    this.currentTime += ctx.quantum;
    this.lastBlockSize = length;

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
    // RT-AUDIT-P0-001: Voice-Pool + ausstehende Trigger leeren.
    for (let v = 0; v < this.voices.length; v++) {
      this.voices[v].active = false;
      this.voices[v].fadeLeft = 0;
      this.voices[v].fadeStart = -1;
    }
    this.voiceSerial = 0;
    this.pendingHead = 0;
    this.pendingCount = 0;
    for (let c = 0; c < this.externalBlocks.length; c++) this.externalBlocks[c] = null;
  }

  /**
   * Rendert den nächsten Block einer Sample-Quelle in die vorallokierten
   * Kanal-Puffer. Ein ausstehender (Re-)Start greift sample-genau bei
   * `pendingStart`; davor spielt eine laufende Wiedergabe weiter, sonst Stille.
   */
  private renderSampleBlock(state: V2SamplePlaybackState, channelIdx: number, length: number, ctxSampleRate: number): Float32Array[] {
    const outL = this.sampleOutL[channelIdx];
    const outR = state.right ? this.sampleOutR[channelIdx] : null;
    const pendingStart = state.pendingStart >= 0 ? Math.min(length - 1, state.pendingStart) : -1;
    let advance = state.rate * (state.sourceRate / ctxSampleRate);

    for (let i = 0; i < length; i++) {
      if (i === pendingStart) {
        state.playing = true;
        state.position = state.pendingPosition;
        state.loop = state.pendingLoop;
        state.rate = state.pendingRate;
        state.pendingStart = -1;
        advance = state.rate * (state.sourceRate / ctxSampleRate);
      }
      if (!state.playing) {
        outL[i] = 0;
        if (outR) outR[i] = 0;
        continue;
      }
      let idx = Math.floor(state.position);
      if (idx >= state.left.length) {
        if (!state.loop) {
          state.playing = false;
          outL[i] = 0;
          if (outR) outR[i] = 0;
          continue;
        }
        state.position %= state.left.length;
        idx = Math.floor(state.position);
      }
      // RT-AUDIT-P0-002: explizite Grenzprüfung statt `?? 0` (der
      // Nullish-Rückfall boxt Doubles pro Sample); idx < left.length ist oben
      // geprüft, idx < 0 nur bei leerem Sample (dann Stille wie bisher).
      const l = idx >= 0 ? state.left[idx] : 0;
      outL[i] = l;
      if (outR) {
        const r = state.right;
        outR[i] = r !== undefined && idx >= 0 && idx < r.length ? r[idx] : l;
      }
      state.position += advance;
    }

    if (state.playing && !state.loop && state.position >= state.left.length) state.playing = false;
    return outR ? this.sampleBlockStereo[channelIdx] : this.sampleBlockMono[channelIdx];
  }

  /** Fordert die 64-Sample-Ausblendung einer Stimme ab Sample `at` des aktuellen Blocks an. */
  private requestFade(voice: V2Voice, at: number): void {
    if (voice.fadeLeft > 0) return; // blendet bereits aus
    if (voice.fadeStart < 0 || at < voice.fadeStart) voice.fadeStart = at;
  }

  /**
   * RT-AUDIT-P0-001: Startet eine Stimme im Pool. Allokationsfrei: freier Slot,
   * sonst wird die älteste Stimme übernommen (Voice-Stealing). Monophone Rollen
   * (kick, bass) blenden die vorherige Stimme desselben Kanals ab `startSample`
   * in 64 Samples aus; alle anderen Rollen sind polyphon.
   */
  private startVoice(channelIdx: number, startSample: number, velocity: number, eventFreq: number, sampleRate: number): void {
    const channel = V2_CHANNELS[channelIdx];
    // AUDIO-P0-001: Mute – stummgeschaltete Kanäle starten keine Stimmen.
    if (this.mutedChannels.has(channel)) return;
    const source = this.synthSources.get(channel);
    const kind = voiceKindOf(source ? source.voice : (ROLE_VOICE[channel] ?? 'lead'));
    const amount = source ? source.amount : undefined;
    const modIndex = source ? source.modIndex : undefined;
    const sourceFreq = source ? source.freq : (ROLE_FREQ[channel] ?? 440);
    const rawFreq = Number.isFinite(eventFreq) ? eventFreq : sourceFreq;

    if (kind === VOICE_KICK || kind === VOICE_BASS) {
      for (let v = 0; v < this.voices.length; v++) {
        const other = this.voices[v];
        if (other.active && other.channelIdx === channelIdx) this.requestFade(other, startSample);
      }
    }

    // Freien Slot suchen, sonst die älteste Stimme übernehmen (Voice-Stealing).
    let voice: V2Voice | null = null;
    let oldest: V2Voice = this.voices[0];
    for (let v = 0; v < this.voices.length; v++) {
      const candidate = this.voices[v];
      if (!candidate.active) {
        voice = candidate;
        break;
      }
      if (candidate.serial < oldest.serial) oldest = candidate;
    }
    if (!voice) voice = oldest;

    // Klangparameter exakt wie im früheren renderStepBurst.
    const freq = Number.isFinite(rawFreq) && rawFreq > 0 ? Math.max(20, Math.min(20000, rawFreq)) : ROLE_FREQ[channel] ?? 440;
    voice.active = true;
    voice.channelIdx = channelIdx;
    voice.kind = kind;
    voice.serial = ++this.voiceSerial;
    voice.freq = freq;
    voice.amp = Math.max(0, Math.min(1, velocity)) * 0.8;
    voice.decay = kind === VOICE_KICK ? 14 : kind === VOICE_BASS ? 9 : kind === VOICE_CLAP ? 22 : 18;
    voice.baseFreq = kind === VOICE_KICK ? Math.min(freq, 120) : kind === VOICE_BASS ? Math.min(freq, 160) : freq;
    voice.phaseAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount as number)) : 0.6;
    voice.phase = 0;
    voice.elapsed = 0;
    voice.noiseState = 1;
    voice.noiseHp = 0;
    voice.bassFilter = 0;
    voice.startOffset = Math.max(0, startSample);
    voice.fadeStart = -1;
    voice.fadeLeft = 0;
    if (kind === VOICE_EPIANO) {
      // FEAT-P3-002: FM-E-Piano sample-weise (dieselbe Formel wie
      // renderElectricPiano via electricPianoSample, aber ohne Puffer – keine
      // Allokation pro Anschlag oder Block).
      const opts = this.pianoOptions;
      opts.sampleRate = Math.max(8000, sampleRate);
      opts.modIndex = Number.isFinite(modIndex) ? Math.max(0, Math.min(12, modIndex as number)) : 2.4;
      opts.gain = 1;
      configureElectricPiano(voice.piano, voice.baseFreq, opts);
    }
  }

  /**
   * RT-AUDIT-P0-001: Rendert eine Stimme des Pools additiv in den Kanal-Puffer
   * und setzt sie über Blockgrenzen hinweg fort. Die Klangformeln sind die des
   * früheren `renderStepBurst` (AUDIO-P0-001/FEAT-P3-002) – identischer Klang,
   * nur nicht mehr nach einem Block abgeschnitten.
   */
  private renderVoice(voice: V2Voice, out: Float32Array, length: number, sampleRate: number): void {
    const sr = Math.max(8000, sampleRate);
    const maxSamples = Math.floor(VOICE_MAX_DURATION_S * sr);
    const fadeAtMax = maxSamples - V2_VOICE_FADE_SAMPLES;
    const amp = voice.amp;
    const decay = voice.decay;
    const kind = voice.kind;
    let phase = voice.phase;
    let noiseState = voice.noiseState;
    let noiseHp = voice.noiseHp;
    let bassFilter = voice.bassFilter;
    let n = voice.elapsed;
    let ended = false;

    for (let i = voice.startOffset; i < length; i++) {
      const t = n / sr;
      const env = Math.exp(-t * decay);
      let s = 0;
      switch (kind) {
        case VOICE_KICK: {
          // Sinus mit schnellem Frequenz-Sweep (150 Hz → 40 Hz) + Klick.
          const f = 40 + 110 * Math.exp(-t * 40);
          phase += f / sr;
          s = Math.sin(2 * Math.PI * phase) * env;
          if (t < 0.004) {
            noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
            s += ((noiseState / 4294967296) * 2 - 1) * 0.4 * (1 - t / 0.004);
          }
          break;
        }
        case VOICE_HAT: {
          // Hochpass-gefiltertes Rauschen (Differenzfilter).
          noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
          const nz = ((noiseState / 4294967296) * 2 - 1) * 0.6;
          s = (nz - noiseHp) * env;
          noiseHp = nz;
          break;
        }
        case VOICE_CLAP: {
          // Mehrfach-Burst-Rauschen (3 schnelle Impulse).
          const burst = t < 0.012 ? 1 : t < 0.02 ? 0.7 : t < 0.03 ? 0.5 : 0;
          noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
          s = ((noiseState / 4294967296) * 2 - 1) * burst * env;
          // Nach dem letzten Impuls ist die Stimme exakt still → freigeben.
          if (t >= 0.03) ended = true;
          break;
        }
        case VOICE_BASS: {
          // Sägezahn mit One-Pole-Lowpass (V1-MonoSynth-Charakter), Filter je Stimme.
          phase += voice.baseFreq / sr;
          if (phase >= 1) phase -= 1;
          const saw = (phase * 2 - 1) * env;
          s = bassFilter + 0.25 * (saw - bassFilter);
          bassFilter = s;
          break;
        }
        case VOICE_PHASE: {
          // Casio-CZ-Phasenverzerrung: nichtlineare Phase erzeugt harte Kanten.
          phase += voice.freq / sr;
          if (phase >= 1) phase -= 1;
          s = phaseDistortionSample(phase, voice.phaseAmount, 'saw', 0.9) * env;
          break;
        }
        case VOICE_EPIANO: {
          // FM-Stimme mit eigener Hüllkurve (kein zusätzliches env nötig).
          s = electricPianoSample(voice.piano, n);
          break;
        }
        default: {
          // Lead: Sinus-Burst mit Rollen-Frequenz.
          phase += voice.freq / sr;
          s = Math.sin(2 * Math.PI * phase) * env;
          break;
        }
      }
      let value = Number.isFinite(s) ? Math.max(-1, Math.min(1, s * amp)) : 0;

      // Ausblendung (Mono-Retrigger, Mute, Maximaldauer): 64 Samples linear.
      if (voice.fadeLeft === 0 && ((voice.fadeStart >= 0 && i >= voice.fadeStart) || n >= fadeAtMax)) {
        voice.fadeLeft = V2_VOICE_FADE_SAMPLES;
      }
      if (voice.fadeLeft > 0) {
        voice.fadeLeft--;
        value *= voice.fadeLeft / V2_VOICE_FADE_SAMPLES;
        if (voice.fadeLeft === 0) ended = true;
      }
      out[i] += value;
      n++;

      // Ende: Hüllkurve unter −80 dB (E-Piano: Amplitudenabfall seiner FM-Hüllkurve).
      const level = kind === VOICE_EPIANO
        ? Math.exp(-t / voice.piano.ampDecayS) * voice.piano.gain * amp
        : env * amp;
      if (level < VOICE_SILENCE_THRESHOLD || n >= maxSamples) ended = true;
      if (ended) break;
    }

    voice.phase = phase;
    voice.noiseState = noiseState;
    voice.noiseHp = noiseHp;
    voice.bassFilter = bassFilter;
    voice.elapsed = n;
    voice.startOffset = 0;
    voice.fadeStart = -1;
    if (ended) {
      voice.active = false;
      voice.fadeLeft = 0;
    }
  }

  /** Rendert den Testton in den vorallokierten `toneBuffer` (RT-AUDIT-P0-002). */
  private renderToneBlock(length: number, sampleRate: number): Float32Array {
    const buffer = this.toneBuffer;
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
      this.silenceBlock = [this.silenceBuffer];
      // RT-AUDIT-P0-002: Testton-/Stille-Puffer nur bei geänderter Blockgröße neu.
      this.toneBuffer = new Float32Array(length);
      this.toneBlock = [this.toneBuffer];
      this.silentStereo = [new Float32Array(length), new Float32Array(length)];
    }
    // RT-AUDIT-P0-001: Stimmen-/Sample-Puffer nur bei geänderter Blockgröße neu anlegen.
    if (this.voiceBuffers.length === 0 || this.voiceBuffers[0].length !== length) {
      this.allocateChannelBuffers(length);
    }
    if (this.lastBlockSize === length) return;
    for (const channel of V2_CHANNELS) {
      const source = this.studio.sources.get(channel);
      if (!source) continue;
      const current = source.sourceBuffer;
      if (!current || current[0]?.length !== length || current.length !== SILENCE_CHANNEL_COUNT) {
        this.studio.setSourceBuffer(channel, this.silenceBlock);
      }
    }
    this.lastBlockSize = length;
  }

  /** Legt die Kanal-Puffer (Stimmen-Mix, Sample-Ausgabe) für eine Blockgröße an. */
  private allocateChannelBuffers(length: number): void {
    const size = Math.max(1, length);
    this.voiceBuffers = [];
    this.voiceBlocks = [];
    this.sampleOutL = [];
    this.sampleOutR = [];
    this.sampleBlockMono = [];
    this.sampleBlockStereo = [];
    for (let c = 0; c < V2_CHANNELS.length; c++) {
      const voiceBuffer = new Float32Array(size);
      this.voiceBuffers.push(voiceBuffer);
      this.voiceBlocks.push([voiceBuffer]);
      const left = new Float32Array(size);
      const right = new Float32Array(size);
      this.sampleOutL.push(left);
      this.sampleOutR.push(right);
      this.sampleBlockMono.push([left]);
      this.sampleBlockStereo.push([left, right]);
    }
  }
}
