import * as Tone from '../core/audio/compat/nativeAudioKit';
import { createSeededRandom} from './random';

import { TrackType, MUSIC_SCALES } from '../types';


import { calculateChannelPan, calculateHRTF, SPATIAL_SETUPS, SpatialSetup } from './spatialMath';
import { getPatch, INSTRUMENT_PATCHES, InstrumentPatch } from '../data/instrumentSynths';
import { SfzVoiceBank } from '../core/instrument/sfzVoice';
import { SfzSampleCache, planChunkRanges } from '../core/sampler/sfzStreaming';
import { DRUM_KITS, getDrumKit, getDrumSound, DrumSoundPreset } from '../data/drumKits';
import type {
  InstrumentDefinition, SynthDef, FmDef, DrumDef, FxDef,
} from '../core/instrument/types';
import { ClockSync } from './ClockSync';
import { PhaseLockedLoop } from './PhaseLockedLoop';
import { masterClock } from '../core/clock/MonastryMasterClock';
import { AudioGraphState, isAudioGraphState } from './audioGraphSerialization';
import { initialPlaybackMode, resolvePlaybackMode, type AudioPlaybackMode } from './v2FeatureFlags';
import { GraphStateBridge } from '../core/audio/GraphStateBridge';
import { workletGraphRuntime, type WorkletSpec, type WorkletChainResult } from '../core/audio/WorkletGraphRuntime';
import { registerReferenceWorkletSpecs } from '../core/audio/workletSpecs';
import { WebAudioWorkletBridge } from '../core/audio/backends/WebAudioWorkletBridge';
import { createAudioWorkletNode } from '../core/audio/worklets/createWorkletNode';
import {
  createItSynthWorkletNode,
} from '../core/audio/worklets/workletInitializers';
import { SpatialScene } from '../core/spatial/SpatialScene';
import { SourceExtractionPipeline, type AudioSourceInput } from '../core/spatial/SourceExtractionPipeline';
import { GraphPlaybackEngine } from '../core/audio/compat/GraphPlaybackEngine';
import { V2StudioGraph, V2_CHANNELS } from '../core/audio/V2StudioGraph';
import { roleVoiceFor, syncV2Mix, syncV2Patterns, syncV2Voices } from '../audio/v2SyncMirror';
import { MonitorRoutingState } from '../audio/monitorRoutingFacade';
import { V2LiveSink } from '../core/audio/backends/V2LiveSink';
import { validateRouting } from './routingValidator';
import { validatePreset } from './presetValidator';
import { AdaptiveLatencyController, type LatencyProfile } from './adaptiveLatency';
import { telemetry } from './telemetry';
import { AudioIdleDetector } from './idleDetection';
import {
  type MonitorRoutingPlan, type MonitorSource, type MonitorUser,
} from '../core/audio/monitorRouting';
import { OfflineBounceEngine, type BounceResult } from '../audio/bounce/OfflineBounceEngine';
import { renderDrumBuffer as renderDrumBufferImpl } from '../audio/drumRender';
import { WorkletParamBridge } from '../audio/workletParamBridge';
import { defaultOptionalDspPreset } from '../core/dsp/dspPresets';
import type { V2SynthVoice } from '../core/audio/live/V2SinkEngine';
import { pluginAudioChannels } from '../core/audio/pluginChannelMap';
import { checkRoutingConnection, routingTrackToChannel } from '../core/audio/routing/routingConfig';
import { normalizeNotes, normalizeSteps } from '../core/audio/state/sequenceUtils';
import { AutomationCoalescer } from '../core/audio/state/automationCoalescer';
import { exportV2SessionState, parseV2SessionState, type V2SessionGraphState } from '../core/session/v2SessionState';
import type { IAudioNode } from '../core/audio/types';

export { pluginAudioChannels };

// Firefox liefert ohne crossOriginIsolated (COOP/COEP) kein SharedArrayBuffer.
// makeSafeArrayBuffer liefert dann ein reguläres ArrayBuffer, damit die App in
// jedem Browser startet (Verlust: Atomico/CAS-Fallback, aber App nutzbar).
function makeSafeArrayBuffer(byteLength: number): ArrayBuffer {
  try {
    if (typeof globalThis !== 'undefined' && typeof (globalThis as any).SharedArrayBuffer === 'function') {
      return new (globalThis as any).SharedArrayBuffer(byteLength);
    }
  } catch { /* kein SAB verfuegbar */ }
  return new ArrayBuffer(byteLength);
}

/**
 * P0-2: Kanal-Zuordnung der Audio-einspeisenden Plugins (PluginAudioRouter-Kern).
 * Implementierung jetzt in `src/core/audio/pluginChannelMap.ts` (Tone-frei).
 */

class AudioEngine {
  public initialized = false;
  /** Engine-seitiges Coalescing für hochfrequente Worklet-Automation. */
  private automationCoalescer = new AutomationCoalescer((key, payload) => this.worklets.flushAutomation(key, payload), 16);
  private clockSync = new ClockSync();

  private async ensureInitialized() {
    if (!this.initialized) {
        await this.init();
    }
  }

  private pll = new PhaseLockedLoop();

  // Audio Nodes
  private masterBuses: Record<string, Tone.Volume> = {};
  private masterVolume!: Tone.Volume;
  private dspNode!: AudioWorkletNode;
  private eqNode!: AudioWorkletNode;
  private masteringNode!: AudioWorkletNode;
  private lufsNode!: AudioWorkletNode;
  public analyzerNode!: AudioWorkletNode;
  public sharedWaveformBuffer!: Float32Array;
  public lufsBufferView!: Int32Array; // Added for LUFS SAB

  public onWaveformUpdate: (data: Float32Array) => void = () => {};
  public onLufsChange: (value: number) => void = () => {};
  /** Wird bei Context-Suspend/Resume (Autoplay, OS-Sleep, Device-Wechsel) gerufen. */
  public onStateChange: (state: string) => void = () => {};
  private wasPlayingBeforeSuspend = false;
  public lastDeviceError: string | null = null;
  public getLufsValue(): number {
      if (this.lufsBufferView) {
          // Atomics funktioniert nur auf echten SharedArrayBuffers. Bei
          // ArrayBuffer-Fallback (Firefox ohne COOP/COEP) lese ich direkt.
          try {
              return Atomics.load(this.lufsBufferView, 0) / 100;
          } catch {
              return this.lufsBufferView[0] / 100;
          }
      }
      return 0;
  }

  private ctx!: AudioContext;

  // P10: Mehrkanal-Spatial-Bus (2/4.0/6/8/10/12/14/16/18.x) via WebAudio.
  private spatialSetupId: string = '10.0';
  private spatialGains: (GainNode | null)[] = [];
  private spatialMerger: ChannelMergerNode | null = null;
  private spatialEnabled = false;
  // PDC: Der masteringProcessor hat 5 ms Lookahead-Latenz. Monitor-/Cue-Pfade
  // werden um denselben Betrag verzögert, damit Cue und Main-Mix phasenrichtig sind.
  private readonly PDC_MASTERING_LOOKAHEAD_SEC = 0.005;
  /** Nativer PDC-Delay für den lokalen Cue-Pfad (5 ms Mastering-Lookahead). */
  private cuePdcDelay: DelayNode | null = null;
  private spatialMode: 'ON_TOP' | 'SEPARATION' = 'ON_TOP';
  // Finaler Ausgangs-Gain (zwischen mainMonitorGain und Destination) für
  // de-klickte Spatial-Mode-Wechsel (SEPARATION blendet den Stereo-Master
  // weich aus) und als einziger Quellknoten des 2.1-Splitters.
  private outputGain: GainNode | null = null;
  // P0-6: Lokaler MAIN-Abhörpegel VOR outputGain, damit er in 2.0 UND 2.1
  // wirkt. Der Master-Stream (Abgriff an masterStreamTap) bleibt unverändert.
  private mainMonitorGain: GainNode | null = null;
  /** Post-Mastering-Abgriff für den Master-Stream (SFU/Recording), pre-local-monitor. */
  private masterStreamTap: GainNode | null = null;
  /** AUDIO-P0-002: Aktive MediaStream-Destination am V2-Ausgang (Master-Stream). */
  private masterStreamDest: MediaStreamAudioDestinationNode | null = null;
  private masterStreamDestConnected = false;
  /** WF-3: Pre-Mastering-Abgriff für das lokale Monitoring (ohne Mastering-Latenz). */
  private monitorTap: GainNode | null = null;
  // P0-6: Cue-Bus des lokalen Users (parallel zu MAIN, pre-Master abgegriffen).
  private cueBus: GainNode | null = null;
  private cueOutGain: GainNode | null = null;
  private cueTrackGains: Partial<Record<TrackType, GainNode>> = {};
  private spatialRebuildTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Echte per-Kanal-Mischung: Jeder Track (channel1..8) hat eine eigene
   * Gain- und Pan-Stufe. Damit steuern die Mischpult-Fader tatsächlich die
   * Audiokette (statt nur nachbildende UI-Werte).
   */
  private channelGains: Partial<Record<TrackType, Tone.Volume>> = {};
  private channelPans: Partial<Record<TrackType, Tone.Panner>> = {};
  // #DJ: Pro-Kanal 3-Band-EQ (Low/Mid/High) für DJ-Mischpult-Regler.
  private channelEQs: Partial<Record<TrackType, { low: Tone.Filter; mid: Tone.Filter; high: Tone.Filter }>> = {};
  /** F1: Pre-Fader-Eingang je Kanal – alle Quellen speisen hier ein, damit
   *  Fader/EQ/Pan und Cue/PFL real wirken. */
  private channelInputs: Partial<Record<TrackType, Tone.Gain>> = {};

  private samplePlayers: Record<string, Tone.Player> = {};
  /** Einzelner, wiederverwendeter Preview-Player (kein Leak bei schnellem Klicken). */
  private previewPlayer: Tone.Player | null = null;
  private previewUrl: string | null = null;
  private musicBufferCache = new Map<string, Tone.ToneAudioBuffer>();
  private trackSampleUrl: Record<TrackType, string | null> = {
    channel1: null, channel2: null, channel3: null, channel4: null,
    channel5: null, channel6: null, channel7: null, channel8: null,
    channel9: null, channel10: null
  };

  private patterns: Record<TrackType, boolean[]> = {
    channel1: Array(16).fill(false), channel2: Array(16).fill(false),
    channel3: Array(16).fill(false), channel4: Array(16).fill(false),
    channel5: Array(16).fill(false), channel6: Array(16).fill(false),
    channel7: Array(16).fill(false), channel8: Array(16).fill(false),
    channel9: Array(16).fill(false), channel10: Array(16).fill(false)
  };
  private mutedStems: Record<TrackType, boolean> = {
    channel1: false, channel2: false, channel3: false, channel4: false,
    channel5: false, channel6: false, channel7: false, channel8: false,
    channel9: false, channel10: false
  };

  private synthNotes: number[] = Array(16).fill(0);
  public currentScaleName: keyof typeof MUSIC_SCALES = 'A Minor Pentatonic';
  public currentStep = 0;
  /** Schrittanzahl des Sequencers (16 oder 32 Steps). */
  public stepCount: 16 | 32 = 16;
  public onStepUpdate: (step: number) => void = () => {};
  public onBeatCallback: (step: number) => void = () => {};
  private stepListeners = new Set<(step: number) => void>();

  /** Registriert einen Step-Listener; liefert eine Deregistrierungs-Funktion. */
  public addStepListener(cb: (step: number) => void): () => void {
    this.stepListeners.add(cb);
    return () => { this.stepListeners.delete(cb); };
  }

  /** Verteilt einen Step an den Legacy-Callback und alle registrierten Listener. */
  private emitStep(step: number): void {
    this.onStepUpdate(step);
    this.stepListeners.forEach((l) => l(step));
  }

  // Lookahead Scheduler (P2-1: 8–15 ms adaptiv; Worklet-Clock ist Primärquelle)
  private isPlaying = false;
  private lookahead = 15.0; // ms (Standard im Latenz-Budget)
  // AM-E6-2: Adaptive Latenz-Policy (Xrun-Eskalation + stabile Fenster).
  private latencyPolicy = new AdaptiveLatencyController('playback');
  // AM-E6-5: Audio-Idle-Detection (Context suspend/resume zur Energie-Optimierung).
  private idleDetector = new AudioIdleDetector({
    timeoutMs: 5 * 60 * 1000,
    onIdle: () => this.suspendForIdle(),
    onActive: () => this.resumeFromIdle(),
  });

  // --- Task 2: Swing & Gate Parameter (einheitliches Sequencermodell) ---
  public swing = 0.0; // 0..1 – Shuffle-Anteil auf ungeraden 16teln
  public gate = 0.9;  // 0..1 – Gate-Länge relativ zur Step-Dauer

  /** P2-1: aktuelles Lookahead-Budget (8–15 ms adaptiv). */
  public getLookaheadMs(): number {
    return this.lookahead;
  }

  /** P2-1/AM-E6-2: Xrun/Underrun melden → Lookahead adaptiv erhöhen (max 15 ms). */
  public reportXrun(): void {
    this.lookahead = this.latencyPolicy.recordXrun();
    telemetry.recordXrun('audio-engine');
  }

  /** AM-E6-2: Stabiles Audio-Fenster → Xrun-Zähler langsam abbauen (Latenz vs. Durchsatz). */
  public reportStableWindow(): void {
    this.lookahead = this.latencyPolicy.recordStableWindow();
  }

  /** AM-E6-5: Audio-Context bei Idle suspendieren (Energie sparen). */
  public getAudioIdleState(): boolean {
    return this.idleDetector.isIdle();
  }

  private suspendForIdle(): void {
    try {
      const ctx = this.ctx as unknown as { suspend?: () => Promise<void>; state?: string } | null;
      if (ctx && typeof ctx.suspend === 'function' && ctx.state === 'running') {
        void ctx.suspend().catch(() => { /* bereits geschlossen */ });
      }
    } catch { /* Context nicht verfügbar */ }
  }

  private resumeFromIdle(): void {
    try {
      const ctx = this.ctx as unknown as { resume?: () => Promise<void>; state?: string } | null;
      if (ctx && typeof ctx.resume === 'function' && ctx.state === 'suspended') {
        void ctx.resume().catch(() => { /* bereits geschlossen */ });
      }
    } catch { /* Context nicht verfügbar */ }
  }

  /**
   * P1-3/P2-1: Gespeicherte Audio-Settings tatsächlich anwenden.
   * - Latency-Profil steuert das Scheduler-Lookahead adaptiv (8–15 ms).
   * - Die Sample-Rate wird als Präferenz gespeichert und beim nächsten
   *   AudioContext-Aufbau (bzw. Tone.Context) berücksichtigt.
   */
  public applyLatencyProfile(hint: LatencyProfile, sampleRate?: number): void {
    this.latencyPolicy.applyProfile(hint);
    this.lookahead = this.latencyPolicy.snapshot().lookaheadMs;
    try {
      const toneCtx = Tone.getContext() as unknown as { lookAhead?: number; latencyHint?: string };
      if (toneCtx && Number.isFinite(toneCtx.lookAhead as number)) {
        toneCtx.lookAhead = this.lookahead / 1000;
      }
      if (toneCtx && typeof toneCtx.latencyHint === 'string') {
        toneCtx.latencyHint = hint;
      }
    } catch { /* Tone-Context noch nicht verfügbar */ }
    if (Number.isFinite(sampleRate as number) && (sampleRate as number) > 0) {
      this.preferredSampleRate = sampleRate as number;
    }
  }

  /** P1-3: Vom Nutzer gewünschte Sample-Rate (wird beim Context-Aufbau genutzt). */
  public preferredSampleRate = 48000;

  /** NEW-MONK-8/P2-2: Swing systemweit setzen (Worklet-Clock + Scheduler). */
  public setSwing(swing: number): void {
    this.swing = Math.max(0, Math.min(1, swing));
    this.v2LiveSink.updateTransport({ swing: this.swing });
  }

  // --- instrumentMONK: sample-genauer Instrumenten-Synthesizer (AudioWorklet) ---
  private itSynthNode: AudioWorkletNode | null = null;
  private itSynthReady = false;
  private itSynthCurrentDefId = -1;
  /** Gain-Knoten des it-synth-Worklets (lazy erzeugt, P0-2). */
  private itSynthGain: Tone.Gain | null = null;
  /** Lädt den Synth-Graph nur bei erster Aktivierung (kein globaler Noise bei OFF). */
  private synthGraphPromise: Promise<void> | null = null;
  /** P0-2: Aktive Plugin-IDs (Audio-Einspeisung). */
  private activePluginIds = new Set<string>();
  /** Letzte Nutzer-Gains je Kanal – für sanftes OFF/ON (D2-hybrid). */
  private channelRestoreGain: Partial<Record<TrackType, number>> = {};

  // Dropout-/Underrun-Zähler aus dem Audio-Thread (analyzerProcessor).
  public dropoutCount = 0;
  public onDropout: ((count: number) => void) | null = null;

  // --- Task 4: Monitor/Cue-Busse (1..4 Personen, je Mitarbeiter ein eigener Mix) ---
  public monitorCount = 4;
  // AUDIO-P1-002: Cue-/Monitor-Zustand in eigener Fassade (src/audio/monitorRoutingFacade.ts).
  private readonly monitor = new MonitorRoutingState({
    getSink: () => this.v2LiveSink,
    ensureInitialized: () => this.ensureInitialized(),
    getCount: () => this.monitorCount,
  });


  // AUDIO-P1-002: Worklet-Steuerung in eigener Fassade (src/audio/workletParamBridge.ts);
  // die Engine reicht nur Node-Zugriffe, Zeitquelle und V2-Spiegelung hinein.
  private readonly worklets = new WorkletParamBridge({
    getEffectNode: () => this.effectNode,
    setEffectNode: (node) => { this.effectNode = node; },
    getDynamicsNode: () => this.dynamicsNode,
    getDspNode: () => (this.dspNode as AudioWorkletNode | undefined) ?? null,
    getMasteringNode: () => (this.masteringNode as AudioWorkletNode | undefined) ?? null,
    getEqNode: () => (this.eqNode as AudioWorkletNode | undefined) ?? null,
    getGranularNode: () => this.granularNode,
    getFm6Node: () => this.fm6Node,
    getDrumSynthNode: () => this.drumSynthNode,
    getRawContext: () => {
      const raw = (this.ctx && typeof (this.ctx as unknown as { createGain?: unknown }).createGain === 'function')
        ? this.ctx
        : (Tone.context as unknown as { rawContext?: unknown })?.rawContext;
      return raw && typeof (raw as { createGain?: unknown }).createGain === 'function' ? (raw as BaseAudioContext) : null;
    },
    now: () => Tone.now(),
    mirrorDynamics: (enabled, threshold, ratio, makeup) => this.v2LiveSink.setMasterDynamics(enabled, threshold, ratio, makeup),
    mirrorFx: (wet, feedback, rate, depth) => this.v2LiveSink.setMasterFx(wet, feedback, rate, depth),
    mirrorDsp: (cutoff, resonance, depth, drive) => this.v2LiveSink.setMasterDsp(cutoff, resonance, depth, drive),
    mirrorMastering: (threshold, ratio, makeup, ceiling) => this.v2LiveSink.setMasterMastering(threshold, ratio, makeup, ceiling),
  });

  constructor() {
    // Nur der echte Main-Bus wird als Audio-Node vorgehalten. USER_1..4/MON1..4
    // waren tote Tone.Volume-Knoten ohne Ausgang – die Cue-Matrix lebt als
    // Zustand in `MonitorRoutingState` und wird von `planMonitorRouting` verdrahtet.
    this.masterBuses['GLOBAL_MASTER'] = new Tone.Volume(0);
  }
  public async init() { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    if (this.initialized) return;

    // Stellt sicher, dass ein AudioContext existiert (Browser-Autoplay-Gate):
    // Ohne Tone.start() ist Tone.context ggf. nicht lauffähig, wodurch
    // `new AudioWorkletNode(this.ctx, …)` mit "Argument 1 does not implement
    // BaseAudioContext" scheitert.
    try {
      await Tone.start();
      await Tone.context.resume();
    } catch (ctxErr) {
      console.warn('Tone/Context konnte nicht sicher gestartet werden:', ctxErr);
    }
    // Gültigen AudioContext sicherstellen. `instanceof AudioContext` (bzw.
    // `window.AudioContext`) fängt auch den Fall ab, dass rawContext nur im
    // eigenen Kontext-Dummy-Fenster existiert, aber `new AudioWorkletNode`
    // trotzdem 'Argument 1 does not implement BaseAudioContext' wirft.
    const Win = typeof window !== 'undefined' ? window : globalThis;
    const AudioContextCtor = (Win as any).AudioContext || (Win as any).webkitAudioContext;
    const rawCtx = Tone.context?.rawContext;
    // Tone 15 (standardized-audio-context) liefert in `rawContext` einen
    // Wrapper, KEINEN nativen AudioContext. `new AudioWorkletNode(wrapper)`
    // scheitert dann mit "parameter 1 is not of type 'BaseAudioContext'".
    // Der echte native Context liegt in `_nativeContext` (Fallback:
    // `_nativeAudioContext`). Erst danach duck-typen, damit ältere Tone-
    // Versionen (rawContext ist bereits nativ) weiter funktionieren.
    const unwrappedCtx =
      (rawCtx as any)?._nativeContext ??
      (rawCtx as any)?._nativeAudioContext ??
      rawCtx;
    // Firefox-Robustheit: `instanceof AudioContext` schlägt in Firefox fehl,
    // weil Tone den Context in einem anderen Realm/Global erzeugt (constructor
    // name leer). Wir validieren per Duck-Typing: createGain + audioWorklet +
    // destination reichen aus, um Worklets zu registrieren.
    const looksLikeAudioContext = (c: unknown): c is AudioContext =>
      c != null &&
      typeof (c as any).createGain === 'function' &&
      typeof (c as any).audioWorklet?.addModule === 'function' &&
      typeof (c as any).destination === 'object';
    const validCtx = looksLikeAudioContext(unwrappedCtx) ? (unwrappedCtx as AudioContext) : null;

    if (!validCtx) {
      console.error('Kein gültiger AudioContext verfügbar – AudioEngine läuft abgesichert ohne Worklets.');
      try {
        const Ctor = AudioContextCtor || (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
        this.ctx = Ctor ? new Ctor() : (null as unknown as AudioContext);
        if (!this.ctx) throw new Error('kein AudioContext-Konstruktor verfügbar');
      } catch (e2) {
        // Letzter Ausweg: gar kein echter AudioContext (Stumm/Silent-Betrieb).
        this.ctx = null as unknown as AudioContext;
        console.error('AudioContext konnte nicht erstellt werden – AudioEngine stumm.', e2);
      }
    } else {
      this.ctx = validCtx;
    }

    // Context-Suspend/Resume beobachten (Autoplay-Gate, OS-Sleep, Device-Wechsel).
    // Phase 9: Der V2-Transport läuft im AudioWorklet; der Main-Thread steuert
    // nur noch den Zustand und meldet den Context-State an die UI.
    try {
      this.ctx.onstatechange = () => {
        const state = this.ctx?.state;
        if (state === 'suspended') {
          this.wasPlayingBeforeSuspend = this.isPlaying;
          if (this.isPlaying) {
            this.isPlaying = false;
            this.v2LiveSink.stopTransport();
          }
        } else if (state === 'running' && this.wasPlayingBeforeSuspend) {
          this.wasPlayingBeforeSuspend = false;
          this.isPlaying = true;
          this.v2LiveSink.startTransport({
            bpm: Tone.Transport.bpm.value,
            swing: this.swing,
            gate: this.gate,
            stepCount: this.stepCount,
          });
        }
        this.onStateChange?.(state ?? 'closed');
      };
    } catch { /* kein onstatechange verfügbar */ }

    // Worklets robust erzeugen: Fehlt eine module-Registrierung (oder der
    // Context ist nicht nutzbar), liefert der Helfer einen neutralen Gain-Knoten
    // als Platzhalter (kein harter Reject von init()).
    this.dspNode = createAudioWorkletNode(this.ctx, 'dsp-processor');
    this.eqNode = createAudioWorkletNode(this.ctx, 'eq-processor');
    this.masteringNode = createAudioWorkletNode(this.ctx, 'mastering-processor');
    this.analyzerNode = createAudioWorkletNode(this.ctx, 'analyzer-processor');
    this.effectNode = createAudioWorkletNode(this.ctx, 'effect-processor');
    this.dynamicsNode = createAudioWorkletNode(this.ctx, 'dynamics-processor');
    this.granularNode = createAudioWorkletNode(this.ctx, 'granular-processor');
    this.fm6Node = createAudioWorkletNode(this.ctx, 'fm6-processor');
    this.drumSynthNode = createAudioWorkletNode(this.ctx, 'drumsynth-processor');

    // SharedArrayBuffer ist ohne crossOriginIsolated (COOP/COEP-Header) in
    // Firefox NICHT definiert – nutze einen sicheren Fallback (ArrayBuffer).
    const sab = makeSafeArrayBuffer(128 * 4);
    this.sharedWaveformBuffer = new Float32Array(sab);
    try { this.analyzerNode.port.postMessage({ buffer: sab }); } catch { /* Gain-Fallback ohne Port */ }

    // Dropout-/Underrun-Telemetrie aus dem Audio-Thread (analyzerProcessor).
    if (this.analyzerNode && typeof this.analyzerNode.port?.postMessage === 'function') {
      try {
        this.analyzerNode.port.onmessage = (e: MessageEvent) => {
          const d = e.data as { type?: string; count?: number };
          if (d?.type === 'dropout' && typeof d.count === 'number') {
            this.dropoutCount = d.count;
            this.onDropout?.(d.count);
            telemetry.recordXrun('analyzer-processor');
          }
        };
      } catch { /* Port nicht verfügbar – Dropout-Telemetrie entfällt */ }
    }

    this.lufsNode = createAudioWorkletNode(this.ctx, 'lufs-processor');
    const lufsSab = makeSafeArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.lufsBufferView = new Int32Array(lufsSab);
    try { this.lufsNode.port.postMessage({ buffer: lufsSab }); } catch { /* Gain-Fallback ohne Port */ }

    // Phase 9: KEINE Legacy-Mastering-/Synth-Kette und KEIN zweiter Pfad zur
    // ctx.destination mehr. Der hörbare Ausgang läuft ausschließlich über
    // v2LiveSink (AudioWorklet). Die unten gepflegten Zustände (channelGains,
    // masterVolume, mutedStems, monitorPlan) werden per syncV2FromV1 in den
    // V2-Graph gespiegelt.
    this.masterVolume = new Tone.Volume(-6);

    // Kanal-Grundpegel für das Demo-Pattern (Zustand, wird in den V2-Graph gespiegelt).
    this.ensureChannelNode('channel1');
    this.ensureChannelNode('channel2');
    this.ensureChannelNode('channel3');
    this.ensureChannelNode('channel7');
    this.channelGains.channel1!.volume.value = 0.8;
    this.channelGains.channel2!.volume.value = 0.6;
    this.channelGains.channel3!.volume.value = 0.7;
    this.channelGains.channel7!.volume.value = 0.8;

    // Apply routing.json only now that all audio nodes exist.
    await this.applyRoutingConfig();

    this.initialized = true;

    // P2-2: MONASTRYmasterclock als singulären Timing-Regler an die Engine
    // binden (Worklet-Clock bleibt die einzige Timing-Quelle im Audio-Pfad).
    try {
      masterClock.attach(this);
    } catch (e) {
      console.warn('masterClock konnte nicht angebunden werden:', e);
    }

    // Sicherstellen, dass beim ersten Start ein hörbarer Drum-Loop aktiv ist.
    this.ensureDemoPattern();

    // P0-1/P0-4: Start-Silence – beim Studio-Eintritt ist kein Plugin aktiv,
    // deshalb startet der Master stumm. `activatePlugin()` hebt das Gate auf.
    try {
      this.setIdleSilence(this.activePluginIds.size === 0);
    } catch (e) {
      console.warn('Start-Silence konnte nicht gesetzt werden:', (e as Error).message);
    }
  }

  /** P2-2: Diagnose-Snapshot der singulären Master-Clock (für perfMONK/Audit). */
  public getClockDiagnostics() {
    return masterClock.getDiagnostics();
  }

  /**
   * Stellt sicher, dass ein hörbares Standard-Drum-Pattern vorliegt.
   * Sampler-Kanäle (channel4/5/6/8) spielen nur, wenn ein Sample zugewiesen
   * ist; die synthetischen Stimmen (kick/hat/clap/bass) laufen immer.
   */
  public ensureDemoPattern(): void {
    // Nur befüllen, wenn noch nichts programmiert wurde.
    const hasContent = (['channel1','channel2','channel3','channel7','channel8'] as TrackType[])
      .some(t => this.patterns[t].some(Boolean));
    if (hasContent) return;

    // klassischer Industrieller 4-on-the-Floor-Beat (16tel)
    this.patterns.channel1 = [true,false,false,false,true,false,false,false,true,false,false,false,true,false,false,false];          // kick
    this.patterns.channel2 = [false,false,true,false,false,false,true,false,false,false,true,false,false,false,true,false];          // hat (offbeat)
    this.patterns.channel3 = [false,false,false,false,true,false,false,false,false,false,false,false,true,false,false,false];       // clap (backbeat)
    this.patterns.channel7 = [true,false,true,false,false,true,false,true,true,false,false,true,false,true,false,true];          // bass-Groove
    this.patterns.channel8 = [true,false,false,false,false,false,true,false,true,false,false,false,false,false,true,false];          // lead (nur falls Sample)
    this.synthNotes = [0,4,0,7, 3,7,0,5, 0,3,0,7, 4,0,3,7];
    this.normalizeAllPatterns();
    this.emitStep(this.currentStep);
  }

  /** Bringt alle Patterns + synthNotes auf die aktuelle Schrittanzahl. */
  private normalizeAllPatterns(): void {
    (['channel1','channel2','channel3','channel4','channel5','channel6','channel7','channel8','channel9','channel10'] as TrackType[]).forEach((t) => {
      this.patterns[t] = normalizeSteps(this.patterns[t] ?? [], this.stepCount);
    });
    this.synthNotes = normalizeNotes(this.synthNotes, this.stepCount);
  }

  /** Schaltet den Sequencer zwischen 16 und 32 Steps um (Patterns werden gepolstert). */
  public setStepCount(count: 16 | 32): void {
    if (count !== 16 && count !== 32) return;
    this.stepCount = count;
    this.normalizeAllPatterns();
    this.currentStep = this.currentStep % count;
    this.v2LiveSink.updateTransport({ stepCount: count });
    this.syncV2PatternsToLiveSink();
    this.emitStep(this.currentStep);
  }

  /** Globales Transport-Tempo setzen (clamped, z. B. für Sprach-/KI-Steuerung). */
  public setBpm(bpm: number): void {
    if (!Number.isFinite(bpm)) return;
    const value = Math.max(30, Math.min(300, bpm));
    Tone.Transport.bpm.value = value;
    // Phase 9: BPM sample-genau über den V2-Transport (V2SampleClock).
    this.v2LiveSink.updateTransport({ bpm: value });
  }

  /** Aktuelles Transport-Tempo (BPM). */
  public getBpm(): number {
    return Tone.Transport.bpm.value;
  }

  /** Läuft der Transport gerade? */
  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /** Kanal-Fader als lineares Gain (0..1.5) zurücklesen. */
  public getChannelGain(track: TrackType): number {
    const db = this.channelGains[track]?.volume.value;
    if (db === undefined || db === -Infinity) return 0;
    return Math.pow(10, db / 20);
  }

  /** Kanal-Pan (-1..1) zurücklesen. */
  public getChannelPan(track: TrackType): number {
    return this.channelPans[track]?.pan.value ?? 0;
  }

  /** Setzt einen einzelnen Drum-Step. */
  public setStep(track: TrackType, step: number, on: boolean): void {
    if (step < 0 || step >= this.stepCount) return;
    this.patterns[track][step] = on;
    this.v2LiveSink.setPattern(track, this.patterns[track]);
  }

  /** Setzt das Muster eines Kanals (16 oder 32 Steps). */
  public setPattern(track: TrackType, steps: boolean[]): void {
    if (!steps || (steps.length !== 16 && steps.length !== 32)) return;
    this.patterns[track] = normalizeSteps(steps, this.stepCount);
    this.v2LiveSink.setPattern(track, this.patterns[track]);
  }

  /**
   * Übernimmt komplett Patterns + synthNotes aus der Sequenzer-/Preset-Logik,
   * damit die AudioEngine exakt das spielt, was die UI anzeigt.
   */
  public loadPatterns(
    patterns: Record<string, boolean[]>,
    synthNotes?: number[],
    bpm?: number
  ): void {
    const keys: TrackType[] = [
      'channel1','channel2','channel3','channel4',
      'channel5','channel6','channel7','channel8',
      'channel9','channel10',
    ];
    for (const k of keys) {
      const arr = patterns?.[k];
      if (arr && Array.isArray(arr) && (arr.length === 16 || arr.length === 32)) {
        this.patterns[k] = normalizeSteps(arr, this.stepCount);
      }
    }
    if (synthNotes && Array.isArray(synthNotes) && (synthNotes.length === 16 || synthNotes.length === 32)) {
      this.synthNotes = normalizeNotes(synthNotes, this.stepCount);
    }
    if (bpm && Number.isFinite(bpm) && bpm > 20 && bpm < 300) {
      Tone.Transport.bpm.value = bpm;
    }
    this.syncV2PatternsToLiveSink();
    this.v2LiveSink.updateTransport({ bpm: Tone.Transport.bpm.value, stepCount: this.stepCount });
  }

  /** Applies public/routing.json to the audio graph after nodes are created. */
  private async applyRoutingConfig() {
    try {
      // Timeout-Schutz: Wenn routing.json nicht schnell kommt (z.B. Server down
      // im Dev), darf init()/play() NIEMALS hängenbleiben.
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const response = await fetch('/routing.json', { signal: controller.signal });
      clearTimeout(t);
      if (!response.ok) {
        console.warn('routing.json not found, skipping routing config.');
        return;
      }
      const rawRoutingConfig = await response.json();
      const routingConfig = validatePreset(rawRoutingConfig);
      if (!validateRouting(routingConfig as any)) {
        throw new Error('Invalid routing configuration');
      }

      if (routingConfig.global) {
        if (routingConfig.global.tempo) Tone.Transport.bpm.value = routingConfig.global.tempo;
        if (routingConfig.global.masterVolume !== undefined) this.masterVolume.volume.value = routingConfig.global.masterVolume;
      }
      // F7: Track-Params UND Pattern aus routing.json anwenden.
      // Phase 9: Synth-Stimmen werden über die V2-Rollen abgebildet; die
      // Parameter fließen als Synth-Sources in den V2-Sink.
      if (routingConfig.tracks && Array.isArray(routingConfig.tracks)) {
        routingConfig.tracks.forEach(trackConfig => {
          const ch = routingTrackToChannel(trackConfig.id);
          if (ch && Array.isArray(trackConfig.patterns)) {
            this.patterns[ch] = normalizeSteps(trackConfig.patterns as boolean[], this.stepCount);
          }
        });
      }
      // F7: Bus-Effekte auf die V2-Master-Kette anwenden.
      if (routingConfig.buses && Array.isArray(routingConfig.buses)) {
        for (const bus of routingConfig.buses) {
          if (!bus.effects || !Array.isArray(bus.effects)) continue;
          for (const fx of bus.effects) this.applyRoutingBusEffect(fx.type, fx.params);
        }
      }
      // Connections sind im Live-Graph fest verdrahtet (Kanalzug → GLOBAL_MASTER).
      // Wir validieren sie hier gegen die bekannten Bus-/Track-IDs und loggen
      // Abweichungen, statt eine zweite, divergente Graph-Quelle aufzubauen.
      if (routingConfig.connections && Array.isArray(routingConfig.connections)) {
        const trackIds = new Set((routingConfig.tracks ?? []).map((t) => t.id));
        const busIds = new Set((routingConfig.buses ?? []).map((b) => b.id));
        for (const c of routingConfig.connections) {
          const { validSource, validDest } = checkRoutingConnection(c, trackIds, busIds);
          if (!validSource || !validDest) {
            console.warn('[routing.json] ignorierte Verbindung:', c, { validSource, validDest });
          }
        }
      }
    } catch (error) {
      console.error('Failed to load or parse routing.json:', error);
    }
  }

  /** F7: routing.json-Bus-Effekt auf die V2-Master-Kette anwenden. */
  private applyRoutingBusEffect(type: string, params?: Record<string, unknown>): void {
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    try {
      switch (type) {
        case 'masterMePreGain':
          if (num(params?.gain) !== undefined) this.v2LiveSink.setMasterGain(Math.pow(10, num(params!.gain)! / 20));
          break;
        case 'masterMeHighpass':
          // V2-Master-EQ besitzt Low-Shelf/Peaking/High-Shelf – Highpass wird als
          // Low-Shelf-Absenkung approximiert (Routing.json-Kompatibilität).
          if (num(params?.frequency) !== undefined) this.v2MasterEqLowDb = -6;
          this.v2LiveSink.setMasterEq(this.v2MasterEqLowDb, this.v2MasterEqMidDb, this.v2MasterEqHighDb);
          break;
        case 'masterMeCompressor':
          this.v2LiveSink.setMasterMastering(
            num(params?.threshold) ?? -14,
            num(params?.ratio) ?? 3,
            1,
            0.98,
          );
          break;
        default:
          console.warn('[routing.json] unbekannter Bus-Effekt ignoriert:', type);
      }
    } catch (e) {
      console.warn('[routing.json] Bus-Effekt nicht anwendbar:', type, e);
    }
  }


  public adjustLatency(oneWayLatency: number) {
      // lookAhead is a property on Tone.context, not Transport
      Tone.context.lookAhead = oneWayLatency / 1000 + 0.05;
  }

  public setWorkletParam(name: string, value: number) {
    this.ensureInitialized();
    this.worklets.setWorkletParam(name, value);
  }

  /** Effekt-Engine (effectProcessor) steuern – Insert/Send. */
  private effectNode: AudioWorkletNode | null = null;

  /** Echtzeit-Dynamik (Kompressor + Gate + Dynamic EQ) als Master-Insert. */
  private dynamicsNode: AudioWorkletNode | null = null;
  /** AUDIO-P0-004: Zuletzt gesetzte Master-EQ-Band-Gains (dB) für den V2-Live-Pfad. */
  private v2MasterEqLowDb = 0;
  private v2MasterEqMidDb = 0;
  private v2MasterEqHighDb = 0;
  /**
   * FEAT-P3-002: optionale DSP-Bausteine im hörbaren V2-Pfad. Die Defaults
   * kommen aus dem Preset-Schema (`core/dsp/dspPresets.ts`) — eine Quelle für
   * UI, Adapter und Persistenz (ein Test hält beide Seiten synchron).
   */
  private optionalModMatrix = (() => {
    const p = defaultOptionalDspPreset('mod-matrix');
    return { enabled: p.enabled, rate: p.params.rate, depth: p.params.depth };
  })();
  private optionalReverb = (() => {
    const p = defaultOptionalDspPreset('hq-reverb');
    return { enabled: p.enabled, mix: p.params.mix, decayS: p.params.decayS, damping: p.params.damping, sizeScale: p.params.sizeScale };
  })();

  /** Ist der Dynamik-Insert tatsächlich in der Master-Kette? */
  public isDynamicsInsertReady(): boolean {
    return this.worklets.isDynamicsInsertReady();
  }

  /**
   * Dynamik-Parameter setzen (Kompressor/Gate/Dynamic EQ).
   * Ohne `enabled: true` bleibt der Insert im Bypass (Signal unverändert).
   */
  public setDynamicsParams(params: {
    enabled?: boolean;
    compressor?: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number };
    gate?: { enabled?: boolean; threshold?: number; range?: number; attack?: number; hold?: number; release?: number; hysteresis?: number };
    dynEq?: { enabled?: boolean; freq?: number; q?: number; threshold?: number; ratio?: number; range?: number };
  }): void {
    this.worklets.setDynamicsParams(params);
  }

  /** Sample-genaue Dynamik-Parameter-Rampe (zipper-frei). */
  public automateDynamicsParam(
    param: 'threshold' | 'ratio' | 'makeup' | 'gateThreshold' | 'dynEqRange',
    value: number, rampTime = 0.02,
  ): void {
    this.automationCoalescer.push(`dynamics:${param}`, { type: 'automate', param, value, rampTime });
  }

  // ---------------------------------------------------------------------------
  // Granular-Engine (A-Klasse) + 6-Op-FM (DX7) – Worklet-Anbindung
  // ---------------------------------------------------------------------------
  private granularNode: AudioWorkletNode | null = null;
  private fm6Node: AudioWorkletNode | null = null;

  /** Granular-Source setzen (Float32Array wird als Kopie an das Worklet gepostet). */
  public loadGranularSource(buffer: Float32Array): void {
    this.worklets.loadGranularSource(buffer);
  }

  /** Granular-Parameter setzen. */
  public setGranularParams(p: {
    grainSize?: number; density?: number; position?: number; positionJitter?: number;
    pitch?: number; pitchJitter?: number; direction?: 1 | -1; freeze?: boolean; gain?: number;
  }): void {
    this.worklets.setGranularParams(p);
  }

  public isGranularReady(): boolean {
    return this.worklets.isGranularReady();
  }

  /** 6-Op-FM-Patch setzen. */
  public setFm6Patch(patch: unknown): void {
    this.worklets.setFm6Patch(patch);
  }

  /** DX7-SysEx (156-Byte-unpacked) laden und als Patch setzen. */
  public loadFm6Sysex(bytes: Uint8Array): void {
    this.worklets.loadFm6Sysex(bytes);
  }

  public fm6NoteOn(noteHz: number, velocity = 0.8): void {
    this.worklets.fm6NoteOn(noteHz, velocity);
  }

  public fm6NoteOff(noteHz: number): void {
    this.worklets.fm6NoteOff(noteHz);
  }

  public setFm6Gain(gain: number): void {
    this.worklets.setFm6Gain(gain);
  }

  public isFm6Ready(): boolean {
    return this.worklets.isFm6Ready();
  }

  // ---------------------------------------------------------------------------
  // Drum-Synth-Worklet + SFZ-Voice-Management (A-Klasse)
  // ---------------------------------------------------------------------------
  private drumSynthNode: AudioWorkletNode | null = null;
  private sfzBank: SfzVoiceBank | null = null;
  /** Kanal, auf dem das SFZ-Instrument als V2-Quelle läuft. */
  private sfzV2Channel: TrackType = 'channel4';

  /** Synthetische Drums triggern (kick/snare/hat). */
  public triggerDrumSynth(kind: 'kick' | 'snare' | 'hat'): void {
    this.worklets.triggerDrumSynth(kind);
  }

  public isDrumSynthReady(): boolean {
    return this.worklets.isDrumSynthReady();
  }

  /** SFZ-Instrument laden (Text + Sample-Buffer-Map) und als V2-Quelle registrieren. */
  public loadSfzInstrument(sfzText: string, sources: Record<string, Float32Array>, channel: TrackType = 'channel4'): string[] {
    try {
      const bank = new SfzVoiceBank(this.ctx?.sampleRate ?? 48000);
      const errors = bank.load(sfzText, sources);
      this.sfzBank = bank;
      this.sfzV2Channel = channel;
      // Phase 3 Rest: SFZ-Bank auch im V2-Sink als Quelle ablegen.
      this.v2LiveSink.loadSfzBank(channel, sfzText, sources);
      return errors;
    } catch {
      return ['SFZ konnte nicht geladen werden'];
    }
  }

  public sfzNoteOn(note: number, velocity = 100): void {
    this.sfzBank?.noteOn(note, velocity);
    this.v2LiveSink.sfzNoteOn(this.sfzV2Channel, note, velocity);
  }

  public sfzNoteOff(note: number): void {
    this.sfzBank?.noteOff(note);
    this.v2LiveSink.sfzNoteOff(this.sfzV2Channel, note);
  }

  // Task #3: SFZ/OPFS-Streaming-Kern, verdrahtet an die Engine.
  private sfzStreamCache = new SfzSampleCache<Float32Array>(64 * 1024 * 1024);

  /** Legt dekomprimierte SFZ-Sample-Daten in den 64-MB-LRU-Cache. */
  public cacheSfzSample(key: string, data: Float32Array, bytes: number): void {
    this.sfzStreamCache.put(key, data, bytes);
  }

  /** Holt gecachte SFZ-Sample-Daten (LRU-Reihenfolge wird aufgefrischt). */
  public getCachedSfzSample(key: string): Float32Array | undefined {
    return this.sfzStreamCache.get(key);
  }

  /** Chunk-Plan für große SFZ-Samples (HTTP-Range + Worker-Decode). */
  public planSfzChunks(totalBytes: number, chunkBytes?: number) {
    return planChunkRanges(totalBytes, chunkBytes);
  }

  /** P2-4: Ist der effectProcessor tatsächlich in die Master-Kette eingehängt? */
  public isEffectInsertReady(): boolean {
    return this.worklets.isEffectInsertReady();
  }

  public setEffectParam(p: { wet?: number; feedback?: number; rate?: number; depth?: number; bits?: number; sampleReduction?: number }) {
    this.ensureInitialized();
    this.worklets.setEffectParam(p);
  }

  /** Sample-genaue Effekt-Parameter-Rampe (effectProcessor automate). */
  public automateEffect(param: 'wet' | 'feedback' | 'depth', value: number, rampTime = 0.05) {
    this.automationCoalescer.push(`effect:${param}`, { type: 'automate', param, value, rampTime });
  }

  /** Sample-genaue DSP-Parameter-Rampe (dspProcessor automate). */
  public automateDsp(param: 'drive' | 'depth' | 'resonance' | 'phase', value: number, rampTime = 0.05) {
    this.automationCoalescer.push(`dsp:${param}`, { type: 'automate', param, value, rampTime });
  }

  /** Sample-genaue Mastering-Parameter-Rampe (masteringProcessor automate). */
  public automateMastering(param: 'threshold' | 'makeup' | 'ceiling', value: number, rampTime = 0.05) {
    this.automationCoalescer.push(`mastering:${param}`, { type: 'automate', param, value, rampTime });
  }

  /** Block-genaue EQ-Band-Gain-Rampe (eqProcessor automate, Band 0-11). */
  public automateEqBandGain(band: number, gainDb: number, rampTime = 0.05) {
    this.automationCoalescer.push(`eq:${band}`, { type: 'automate', param: 'bandGain', band, value: gainDb, rampTime });
  }

  /** Task 11: Mastering-Limiter/Kompression steuern (masteringProcessor). */
  public setMasteringParams(p: { threshold?: number; ratio?: number; knee?: number; attack?: number; release?: number; makeup?: number; ceiling?: number }) {
    this.ensureInitialized();
    this.worklets.setMasteringParams(p);
  }

  /** Task 10: DSP-Engine steuern (Phasenkorrektur, dynamisches Filter, Drive). */
  public setDspParam(p: { phase?: number; filterCutoff?: number; resonance?: number; depth?: number; drive?: number }) {
    this.ensureInitialized();
    this.worklets.setDspParam(p);
  }

  // ---------------------------------------------------------------------------
  // FEAT-P3-002: optionale DSP-Bausteine (Mod-Matrix, HQ-Reverb, Quellen)
  // ---------------------------------------------------------------------------

  /** Modulations-Matrix (LFO → Master-Gain) im hörbaren V2-Pfad. */
  public setOptionalModMatrix(patch: { enabled?: boolean; rate?: number; depth?: number } = {}): void {
    this.optionalModMatrix = { ...this.optionalModMatrix, ...patch };
    const { enabled, rate, depth } = this.optionalModMatrix;
    this.v2LiveSink.setMasterModMatrix(enabled, rate, depth);
  }

  /** HQ-Reverb (4-Leitungs-FDN) auf dem Master im hörbaren V2-Pfad. */
  public setOptionalReverb(patch: { enabled?: boolean; mix?: number; decayS?: number; damping?: number; sizeScale?: number } = {}): void {
    this.optionalReverb = { ...this.optionalReverb, ...patch };
    const { enabled, mix, decayS, damping, sizeScale } = this.optionalReverb;
    this.v2LiveSink.setMasterReverb(enabled, mix, decayS, damping, sizeScale);
  }

  /** Aktueller Zustand der optionalen Bausteine (UI/Diagnose). */
  public getOptionalDspState(): {
    modMatrix: { enabled: boolean; rate: number; depth: number };
    reverb: { enabled: boolean; mix: number; decayS: number; damping: number; sizeScale: number };
  } {
    return { modMatrix: { ...this.optionalModMatrix }, reverb: { ...this.optionalReverb } };
  }

  /** Setzt eine optionale Synth-Quelle (Phase-Distortion / E-Piano) auf einen Kanal. */
  public setOptionalSynthVoice(
    channel: TrackType,
    voice: V2SynthVoice,
    freq = 440,
    opts: { amount?: number; modIndex?: number } = {},
  ): boolean {
    const f = Number.isFinite(freq) && freq > 0 ? Math.max(20, Math.min(20000, freq)) : 440;
    return this.v2LiveSink.setSynthSource(channel, f, voice, opts);
  }

  /** Stellt die Rollen-Default-Stimme eines Kanals wieder her („optional-voice“ aus). */
  public resetOptionalSynthVoice(channel: TrackType): boolean {
    const { freq, voice } = roleVoiceFor(channel);
    return this.v2LiveSink.setSynthSource(channel, freq, voice);
  }

  /** Task 9: EQ-Band parametrisch setzen (eqProcessor). */
  public setEqBand(band: 'low'|'mid'|'high'|'hp', gain: number, freq?: number, q?: number) {
    this.ensureInitialized();
    try { this.eqNode?.port?.postMessage({ band, gain, freq, q }); } catch { /* Gain-Fallback */ }
    // AUDIO-P0-004: EQ-Band in den V2-Live-Pfad spiegeln (hp wird auf high gemappt).
    if (band === 'low') this.v2MasterEqLowDb = gain;
    else if (band === 'mid') this.v2MasterEqMidDb = gain;
    else this.v2MasterEqHighDb = gain;
    this.v2LiveSink.setMasterEq(this.v2MasterEqLowDb, this.v2MasterEqMidDb, this.v2MasterEqHighDb);
  }

  /** Master-Lautstärke direkt in dB setzen (glatter Übergang). */
  public setMixChannelParam(target: 'master', value: number, rampSec = 0.02): void {
    if (target === 'master' && this.masterVolume) {
      const v = Number.isFinite(value) ? Math.max(-80, Math.min(12, value)) : -Infinity;
      this.lastMasterVolumeDb = v;
      this.masterVolume.volume.setTargetAtTime(v, Tone.now(), rampSec);
    }
  }

  /** PREP-6: Callback zur nächsten vollen Bar (Tone.Transport) ausführen. */
  public scheduleAtNextBar(cb: () => void): void {
    try {
      const ToneMod = Tone;
      const now = ToneMod.Transport.seconds;
      const bar = ToneMod.Time('1m').toSeconds();
      ToneMod.Transport.scheduleOnce(cb, now + Math.max(0.05, bar));
    } catch { /* Transport nicht aktiv – sofort ausführen */ cb(); }
  }

  /** M-2: Kanal weich auf MAIN faden (Fade-in zu Ziel-DB, Default 0 dB). */
  public fadeChannelToMain(track: TrackType, rampSec = 4, targetDb = 0): boolean {
    this.ensureInitialized();
    const g = this.channelGains[track];
    if (!g) return false;
    const v = Number.isFinite(targetDb) ? Math.max(-80, Math.min(12, targetDb)) : 0;
    try { g.volume.setTargetAtTime(v, Tone.now(), Math.max(0.05, rampSec)); return true; } catch { return false; }
  }

  /** Master-Lautstärke in dB (Voice-/Routing-Befehle). */
  public setMasterVolumeDb(db: number, rampSec = 0.05): void {
    this.ensureInitialized();
    if (!this.masterVolume) return;
    const v = Number.isFinite(db) ? Math.max(-80, Math.min(12, db)) : -Infinity;
    this.lastMasterVolumeDb = v;
    this.masterVolume.volume.rampTo(v, rampSec);
  }

  /**
   * Stellt den per-Kanal-Gain/Pan für einen Track bereit (zwischenspeichert
   * die Tone-Nodes und verdrahtet sie auf den GLOBAL_MASTER-Bus).
   * #DJ: zusätzlich 3-Band-EQ (Low-Shelf → Peaking Mid → High-Shelf) inline.
   */
  private ensureChannelNode(track: TrackType): void {
    if (!this.channelGains[track]) {
      // Phase 9: reine Zustandsträger – die hörbare Verdrahtung (Gain/Pan/EQ)
      // läuft über den V2-Graph im v2LiveSink. Keine Tone-No-Op-Ketten mehr.
      const input = new Tone.Gain(1);
      const g = new Tone.Volume(0);
      const low = new Tone.Filter(220, 'lowshelf');
      const mid = new Tone.Filter(1000, 'peaking');
      const high = new Tone.Filter(4000, 'highshelf');
      low.gain.value = 0; mid.gain.value = 0; high.gain.value = 0;
      const p = new Tone.Panner(0);
      this.channelEQs[track] = { low, mid, high };
      this.channelInputs[track] = input;
      this.channelGains[track] = g;
      this.channelPans[track] = p;
    }
  }

  /** #DJ: Pro-Kanal 3-Band-EQ. gain in dB, band: 'low'|'mid'|'high'. */
  public setChannelEQ(track: TrackType, band: 'low' | 'mid' | 'high', gain: number): void {
    this.ensureInitialized();
    this.ensureChannelNode(track);
    const eq = this.channelEQs[track];
    if (!eq) return;
    // F6-Fix: NaN/Inf abfangen (Math.max/min allein lassen NaN durch).
    const v = Number.isFinite(gain) ? Math.max(-24, Math.min(12, gain)) : 0;
    try { eq[band].gain.rampTo(v, 0.03); } catch { /* ignore */ }
  }

  /** #DJ: Master-Gain-Fader (0..1). */
  public setMasterVolume(gain01: number): void {
    this.ensureInitialized();
    if (!this.masterVolume) return;
    const v = Number.isFinite(gain01) ? Math.max(0, Math.min(1.5, gain01)) : 0;
    const db = v <= 0.001 ? -Infinity : 20 * Math.log10(v);
    this.lastMasterVolumeDb = db;
    this.masterVolume.volume.rampTo(db, 0.03);
  }

  private lastMasterVolumeDb = -6;

  /** P0-4: Silence-Gate – bei 0 aktiven Plugins wird der Master weich stummgeschaltet. */
  public setIdleSilence(silent: boolean): void {
    this.ensureInitialized();
    if (!this.masterVolume) return;
    const db = silent ? -Infinity : this.lastMasterVolumeDb;
    this.masterVolume.volume.setTargetAtTime(db, Tone.now(), 0.05);
  }

  /**
   * P0-2: Plugin in die Signalkette einspeisen (Aktivierung = Einspeisung).
   * Bekannte Audio-Quellen werden erst hier verdrahtet bzw. laut geschaltet.
   */
  public activatePlugin(id: string, _state: 'AUTO_AI' | 'PRO'): void {
    this.ensureInitialized();
    if (this.activePluginIds.has(id)) return;
    this.activePluginIds.add(id);
    this.idleDetector.activity(); // AM-E6-5: Plugin-Aktivierung = Audio-Aktivität
    this.setIdleSilence(false);
    const channels = pluginAudioChannels(id);
    if (channels.length > 0) {
      channels.forEach((ch) => {
        this.ensureChannelNode(ch);
        const restore = this.channelRestoreGain[ch] ?? 1;
        const db = restore <= 0.001 ? -Infinity : 20 * Math.log10(restore);
        try { this.channelGains[ch]!.volume.rampTo(db, 0.03); } catch { /* ignore */ }
      });
    }
    if (id === 'synthesizer' || id === 'instrument') {
      void this.ensureSynthGraph();
      try { this.itSynthGain?.gain.rampTo(1, 0.03); } catch { /* ignore */ }
    }
    if (id === 'mixer') {
      // mixerMONK ist die einzige MAIN-Einspeiseinstanz (D1): alle Kanalwege
      // bleiben hörbar, solange der Halter mixerMONK aktiv hat.
      ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'].forEach((ch) => {
        this.ensureChannelNode(ch as TrackType);
      });
    }
  }

  /**
   * P0-2: Plugin aus der Signalkette nehmen. MAIN-verbundene Quellen werden
   * sanft (Gain-Rampe auf -∞) stummgeschaltet (D2-hybrid); der Graph bleibt
   * für schnelles Re-Activate bestehen. Bei 0 aktiven Plugins greift das
   * Silence-Gate zusätzlich.
   */
  public deactivatePlugin(id: string): void {
    this.ensureInitialized();
    this.activePluginIds.delete(id);
    const channels = pluginAudioChannels(id);
    channels.forEach((ch) => {
      if (!this.channelGains[ch]) return;
      const current = this.channelGains[ch]!.volume.value;
      if (current > 0.001) this.channelRestoreGain[ch] = Math.pow(10, current / 20);
      try { this.channelGains[ch]!.volume.rampTo(-Infinity, 0.05); } catch { /* ignore */ }
    });
    if (id === 'synthesizer' || id === 'instrument') {
      try { this.itSynthGain?.gain.rampTo(0.0001, 0.05); } catch { /* ignore */ }
      this.allNotesOffItSynth();
      this.noteOffWorklet();
    }
    // NEW-D1-2: mixerMONK ist die einzige MAIN-Einspeisung. Schaltet der
    // Halter mixerMONK OFF, stoppen Main-Ausgabe + MainClock.
    if (id === 'mixer') this.stopMainAndClock();
    this.setIdleSilence(this.activePluginIds.size === 0);
    // AM-E6-5: keine aktiven Plugins mehr → Idle-Timer für Context-Suspend starten.
    if (this.activePluginIds.size === 0) this.idleDetector.arm();
    else this.idleDetector.activity();
  }

  /** NEW-D1-2: Main-Ausgabe stummschalten und Transport-Clock stoppen. */
  public stopMainAndClock(): void {
    try { Tone.Transport.stop(); } catch { /* Transport nicht initialisiert */ }
    try { this.masterVolume?.volume.rampTo(-Infinity, 0.05); } catch { /* ignore */ }
  }

  public isPluginActive(id: string): boolean {
    return this.activePluginIds.has(id);
  }

  public getActivePluginIds(): string[] {
    return [...this.activePluginIds];
  }

  /** Echtes Kanal-Gain (Fader): volume 0..1 → dB. */
  public setChannelGain(track: TrackType, gain01: number): void {
    this.ensureInitialized();
    this.ensureChannelNode(track);
    const v = Number.isFinite(gain01) ? Math.max(0, Math.min(1.5, gain01)) : 0;
    const db = v <= 0.001 ? -Infinity : 20 * Math.log10(v);
    this.channelGains[track]!.volume.rampTo(db, 0.03);
  }

  /** Echtes Kanal-Pan: -1..1 (Tone.Panner). */
  public setChannelPan(track: TrackType, pan: number): void {
    this.ensureInitialized();
    this.ensureChannelNode(track);
    const p = this.channelPans[track];
    if (!p) return;
    p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), this.ctx?.currentTime ?? Tone.now(), 0.03);
  }

  /** Setzt die Drum-Kanal-Namen, die das Mischpult anzeigen soll. */
  public getChannelStripInfo(): { stop: TrackType; name: string; color: string }[] {
    return [
      { stop: 'channel1', name: 'KICK',   color: 'bg-rose-500' },
      { stop: 'channel2', name: 'HAT',    color: 'bg-amber-400' },
      { stop: 'channel3', name: 'CLAP',   color: 'bg-sky-500' },
      { stop: 'channel4', name: 'SAMPLE', color: 'bg-purple-500' },
      { stop: 'channel5', name: 'SAMPLE', color: 'bg-emerald-500' },
      { stop: 'channel6', name: 'SAMPLE', color: 'bg-orange-500' },
      { stop: 'channel7', name: 'BASS',   color: 'bg-cyan-500' },
      { stop: 'channel8', name: 'LEAD',   color: 'bg-fuchsia-500' },
    ];
  }

  // --- Drum-Kits: maschinengetreue Presets (808/909/606/707/CR-78/Linn/DMX/Drumtraks) ---
  private activeDrumKitId = 'tr-808';

  public setDrumKit(kitId: string) {
    this.ensureInitialized();
    const kit = getDrumKit(kitId) ?? getDrumKit('tr-808')!;
    this.activeDrumKitId = kit.id;

    const kick = kit.sounds.find((s) => s.type === 'kick');
    const hat = kit.sounds.find((s) => s.type === 'hat');
    const clap = kit.sounds.find((s) => s.type === 'clap') ?? kit.sounds.find((s) => s.type === 'snare');

    // Phase 9: Drum-Kit-Parameter als V2-Synth-Sources übernehmen (kick/hat/clap).
    if (kick) this.v2LiveSink.setSynthSource('channel1', 50, 'kick');
    if (hat) this.v2LiveSink.setSynthSource('channel2', hat.noiseFilter ?? 6000, 'hat');
    if (clap) this.v2LiveSink.setSynthSource('channel3', clap.noiseFilter ?? 1200, 'clap');
  }

  public getActiveDrumKitId(): string {
    return this.activeDrumKitId;
  }

  public listDrumKits() {
    return DRUM_KITS.map((k) => ({ id: k.id, name: k.name, origin: k.origin, year: k.year, sounds: k.sounds.map((s) => s.name) }));
  }

  // --- WebAudio BufferSource-Drum-Renderer ---
  // Jeder Drum-Sound wird einmalig per OfflineAudioContext in einen AudioBuffer
  // gerendert und dann sample-genau über AudioBufferSourceNode abgespielt.
  private drumBufferCache = new Map<string, AudioBuffer>();
  private drumBufferPromises = new Map<string, Promise<AudioBuffer | null>>();
  // Deterministische Noise-Quelle für Drum-Render (kein Math.random im
  // Audio-/Offline-Pfad -> reproduzierbare Bounces, Null-Test-stabil).
  private noiseRandom = createSeededRandom(0xA11CE5EED);

  /** Spielt einen einzelnen Drum-Sound eines Kits (Preview/Pads) via BufferSource. */
  public async triggerDrumSound(kitId: string, soundId: string, velocity = 1) {
    await this.ensureInitialized();
    const key = `${kitId}:${soundId}`;

    let buffer = this.drumBufferCache.get(key);
    if (!buffer) {
      const sound = getDrumSound(kitId, soundId);
      if (!sound) return;

      // Laufenden Render teilen (kein Doppel-Render bei schnellem Klicken).
      let pending = this.drumBufferPromises.get(key);
      if (!pending) {
        pending = this.renderDrumBuffer(sound);
        this.drumBufferPromises.set(key, pending);
      }
      try {
        buffer = await pending;
      } finally {
        this.drumBufferPromises.delete(key);
      }
      if (buffer) this.drumBufferCache.set(key, buffer);
    }

    if (!buffer || !this.ctx) return;

    // F1: Drum-Preview über den Kanalzug (channel2) statt direkt in den Master.
    const drumChannel = pluginAudioChannels('drum')[0] ?? 'channel2';
    this.ensureChannelNode(drumChannel);
    const drumInput = (this.channelInputs[drumChannel] as any)?.input ?? this.channelInputs[drumChannel];
    const t = this.ctx.currentTime + 0.002;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = Math.max(0, Math.min(1.5, velocity));
    src.connect(g);
    g.connect(drumInput || this.ctx.destination);
    src.start(t);
    src.stop(t + buffer.duration + 0.05);
    src.onended = () => {
      try { src.disconnect(); g.disconnect(); } catch { /* bereits getrennt */ }
    };
  }

  /** Rendert einen Drum-Sound (AUDIO-P1-002: Logik in `src/audio/drumRender.ts`). */
  private async renderDrumBuffer(sound: DrumSoundPreset): Promise<AudioBuffer | null> {
    return renderDrumBufferImpl(sound, this.ctx?.sampleRate || 48000, {
      random: this.noiseRandom,
      createBuffer: (length, sampleRate) => (this.ctx ? this.ctx.createBuffer(1, length, sampleRate) : null),
    });
  }

  /**
   * P9: Echt-Verdrahtung des 12-Band-Equalizers an die Audio-Kette.
   * Sendet alle Bänder 1:1 an den eqProcessor-Worklet (12 echte Biquads)
   * und spiegelt sie zusätzlich auf die Tone-Filter-Kette (Fallback,
   * falls das Worklet nicht geladen werden konnte).
   */
  public updateToneShiftEQ(params: any) {
    this.ensureInitialized();
    const rawBands: any[] = params?.bands ?? [];
    if (!Array.isArray(rawBands)) return;

    const DEFAULT_EQ_FREQS = [30, 60, 120, 250, 500, 1000, 2000, 4000, 6000, 8000, 12000, 16000];

    // Immer 12 Bänder normalisieren – fehlende Bänder werden flach (0 dB),
    // damit der Worklet keine veralteten Filter-Zustände behält.
    const bands = DEFAULT_EQ_FREQS.map((f, i) => {
      const b = rawBands[i] ?? {};
      const gain = Number(b.gain ?? 0);
      const freq = Number(b.freq ?? f);
      const q = Number(b.q ?? 1);
      const type = (b.type as string) ?? (i === 0 ? 'lowshelf' : i === 11 ? 'highshelf' : 'peaking');
      return { freq: Number.isFinite(freq) ? freq : f, gain: Number.isFinite(gain) ? gain : 0, q: Number.isFinite(q) ? q : 1, type };
    });

    // --- An den eqProcessor-Worklet senden (echte 12-Band-Kette) ---
    try { this.eqNode?.port?.postMessage({ bands }); } catch { /* Gain-Fallback */ }

    // Phase 9: Keine parallele Tone-Filter-Kette mehr – die V2-Master-EQ
    // übernimmt Low/Mid/High; die 12-Band-Daten bleiben Worklet-Sache.
    this.v2LiveSink.setMasterEq(
      bands[0]?.gain ?? 0,
      bands[5]?.gain ?? 0,
      bands[11]?.gain ?? 0,
    );
  }
  public updateMasterMe(params: any) {
    this.ensureInitialized();
    // Phase 9: Mastering-Parameter in die V2-Master-Kette spiegeln.
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    if (num(params?.input_gain) !== undefined) {
      this.v2LiveSink.setMasterGain(Math.pow(10, num(params!.input_gain)! / 20));
    }
    this.v2LiveSink.setMasterMastering(
      num(params?.threshold) ?? -14,
      num(params?.ratio) ?? 3,
      num(params?.makeup) ?? 1,
      num(params?.ceiling) ?? 0.98,
    );
  }

  /** Vereinfachte Effekt-Schnittstelle (Kompatibilität) – reicht an den Worklet weiter. */
  public setEffectParams(p: {
    type?: string; wet?: number; power?: boolean;
    feedback?: number; rate?: number; depth?: number; bits?: number; sampleReduction?: number; drive?: number;
  }) {
    this.ensureInitialized();
    this.setEffectParam({
      wet: p.wet,
      feedback: p.feedback,
      rate: p.rate,
      depth: p.depth,
      bits: p.bits,
      sampleReduction: p.sampleReduction,
    });
    // Drive (Sättigung) läuft über den DSP-Prozessor.
    if (typeof p.drive === 'number') this.setDspParam({ drive: p.drive });
  }

  public setOnBeatCallback(callback: (step: number) => void) {
    this.onBeatCallback = callback;
  }

  public syncClock(pingTime: number, pongTime: number) {
      this.clockSync.handlePong(pongTime, pingTime);
      const drift = this.pll.update(pongTime - pingTime);
      Tone.Transport.seconds += drift;
  }

  public triggerEvent(track: TrackType, velocity: number = 1.0) {
    // MAIN-Schutz: nur der mixerMONK-Halter spielt auf den MAIN-Kanälen.
    if (!this.monitor.isMainHolderActive()) return;
    // AUDIO-P0-003/Phase 9: Trigger hörbar in den V2-Sink leiten.
    const player = this.samplePlayers[track];
    const buffer = player?.buffer?.get?.();
    if (buffer && buffer.numberOfChannels > 0) {
      this.bridgeAudioBufferToV2(track, buffer);
      this.v2LiveSink.triggerSample(track, { loop: false, rate: 1, offset: 0 });
    } else {
      this.v2LiveSink.synthTrigger(track, Math.max(0.2, Math.min(1, velocity)));
    }
  }

  // ------------------------------------------------------------------ //
  //  Task 4: Monitor/Cue-Mix-Steuerung (1..4 Personen)                //
  // ------------------------------------------------------------------ //
  /** Gesamtpegel eines Monitors (0..1, 0 = stumm). */
  public setMonitorGain(mon: 'MON1'|'MON2'|'MON3'|'MON4', gain: number) {
    this.monitor.setMonitorGain(mon, gain);
  }

  /** Setzt den individuellen Spur-Pegel (0..2) eines Tracks in einem Monitor-Cue. */
  public setMonitorTrackGain(mon: 'MON1'|'MON2'|'MON3'|'MON4', track: TrackType, gain: number) {
    this.monitor.setMonitorTrackGain(mon, track, gain);
  }

  /** Liest den Track-Pegel eines Monitors aus (für UI-Darstellung). */
  public getMonitorTrackGain(mon: 'MON1'|'MON2'|'MON3'|'MON4'): Record<TrackType, number> {
    return this.monitor.getMonitorTrackGain(mon);
  }

  /** Liefert die Monitor-Bus-Namen (gekürzt) als Konfig-Snapshot. */
  public getMonitorConfig() {
    return this.monitor.getMonitorConfig();
  }

  // ------------------------------------------------------------------ //
  //  Monitor-Quelle (pro User): MAIN | USER-MIX (MON1..MON4) | PLUGIN  //
  // ------------------------------------------------------------------ //

  /** Liefert die aktuell gewählte Monitor-Quelle des lokalen Users. */
  public getMonitorSource(): MonitorSource {
    return this.monitor.getMonitorSource();
  }

  /**
   * P0-6-Prüfpunkt: Abhör-Snapshot des lokalen Users.
   * Phase 9: Die hörbare Verdrahtung liegt im V2-Sink; `wired` zeigt, ob der
   * V2-Live-Sink verbunden ist.
   */
  public getMonitorRouting(): MonitorRoutingPlan & { wired: boolean; nodeGains: { main: number; cue: number } } {
    return this.monitor.getMonitorRouting();
  }

  /**
   * Wählt die Monitor-Quelle des lokalen Users:
   *  - 'MAIN'    -> fertige Master-Summe (Default)
   *  - 'MON'     -> eigener kompletter User-Mix (MON1..MON4, PDC-kompensiert)
   *  - 'PLUGIN'  -> Cue-Solo auf den Kanal des eigenen Plugins
   *
   * P0-6/D13: MAIN wird NIE vom Ausgang getrennt und der MAIN-Bus (inkl.
   * Master-Stream für die anderen User) bleibt unverändert – umgeschaltet
   * wird ausschließlich der lokale Abhörweg (Main-Monitor-Gain ↔ Cue-Gain).
   */
  public setMonitorSource(
    mode: MonitorSource,
    mon: MonitorUser = 'MON1',
    track?: TrackType,
  ): void {
    this.monitor.setMonitorSource(mode, mon, track);
  }

  /**
   * DJ-PFL (mixerMONK): Kanal-Vorhearen pre-fader auf dem lokalen Cue-Bus.
   * `active = true` → Kanal solo aufs Vorhören; `false` → PFL für den Kanal
   * aus. Solange mindestens ein PFL aktiv ist, überschreibt das Vorhören den
   * lokalen Monitor-Weg (MAIN-Bus/Master-Stream bleiben unverändert).
   */
  public setChannelPfl(track: TrackType, active: boolean): void {
    this.monitor.setChannelPfl(track, active);
  }

  /** Liefert die aktuell vorgehörten Kanäle (leer = kein PFL aktiv). */
  public getPflTracks(): TrackType[] {
    return this.monitor.getPflTracks();
  }

  /** MAIN-Berechtigung setzen (App ruft das je Lock-Status des mixerMONK-Halters). */
  public setMainHolderActive(active: boolean): void { this.monitor.setMainHolderActive(active); }
  public isMainHolderActive(): boolean { return this.monitor.isMainHolderActive(); }

  /** DJ gibt einen MAIN-Kanal frei (andere User dürfen hineinladen). */
  public setTrackReleased(track: TrackType, released: boolean): void {
    this.monitor.setTrackReleased(track, released);
  }
  public isTrackReleased(track: TrackType): boolean { return this.monitor.isTrackReleased(track); }

  /** Darf dieser lokale User den Track laden? (DJ immer, andere nur bei Freigabe.) */
  public canLoadTrack(track: TrackType): boolean {
    return this.monitor.canLoadTrack(track);
  }

  /**
   * Berechnet den Abhörplan neu (reine Policy in `core/audio/monitorRouting`)
   * und überträgt ihn auf die Audio-Knoten. Die Umschaltung läuft als kurze
   * Rampe (10 ms) – klickfrei, aber ohne hörbare Verzögerung
   * („zurück auf MAIN → sofort Gesamtmix").
   */
  private applyMonitorPlan(): void {
    this.monitor.applyPlan();
  }

  /** P0-2: Synth-Graph (it-synth) erst bei erster Aktivierung aufbauen. */
  public ensureSynthGraph(): Promise<void> {
    if (!this.synthGraphPromise) {
      this.synthGraphPromise = (async () => {
        await this.tryInitItSynthWorklet();
      })().catch((e) => {
        console.warn('[audio] Synth-Graph konnte nicht geladen werden:', (e as Error).message);
      });
    }
    return this.synthGraphPromise;
  }

  /**
   * Erstellt den sample-genauen Instrumenten-Synthesizer (`it-synth-processor`).
   * Erzeugt die Worklet-Node und verbindet sie auf den GLOBAL_MASTER-Bus. Die
   * tatsächliche Instrumenten-Instruktion (`config`) wird erst beim ersten
   * Note-On gesendet, so dass das Worklet ohne Initial-Instrukt aktive ist.
   */
  private async tryInitItSynthWorklet() {
    this.itSynthNode = await createItSynthWorkletNode(this.ctx);
    if (!this.itSynthNode) {
      this.itSynthReady = false;
      return;
    }
    // Stimmen-Status des Worklets an die UI spiegeln (Task 3).
    this.itSynthNode.port.onmessage = (e) => {
      const msg = e.data as { type?: string; active?: number } | undefined;
      if (msg?.type === 'states') {
        this.itSynthActiveVoices = Number(msg.active ?? 0);
        this.onItSynthStates(this.itSynthActiveVoices);
      }
    };
    const g = new Tone.Gain(1);
    (this.itSynthNode as any).connect(g);
    // F1: instrumentMONK-Worklet über den Kanalzug (channel4) führen.
    this.ensureChannelNode('channel4');
    g.connect(this.channelInputs.channel4 ?? this.masterBuses['GLOBAL_MASTER']);
    this.itSynthGain = g;
    this.itSynthReady = true;
    console.info('it-synth-processor (instrumentMONK, sample-genau) aktiviert.');
  }

  /** Wandelt eine instrumentMONK-Definition in ein worklet-taugliches PitchDef um. */
  private toPitchDef(def: InstrumentDefinition): any {
    const a = def as any;
    const common: any = {
      id: def.id, name: def.name, kind: def.kind,
      attack: a.attack ?? 0.01,
      release: a.release ?? 0.3,
      cutoff: a.cutoff ?? a.filterFreq,
      resonance: a.resonance ?? a.filterQ,
      osc: a.osc ?? a.wave,
    };
    if (def.kind === 'acoustic') { common.partials = (def as any).partials; common.sustain = (def as any).env?.[2]; common.decay = (def as any).env?.[1]; }
    if (def.kind === 'fm') { common.modulatorOsc = (def as any).modulator; common.modIndex = (def as any).modIndex; common.ratio = 2; }
    if (def.kind === 'drum') { common.freqStart = (def as any).freqStart; common.freqEnd = (def as any).freqEnd; common.noise = (def as any).noise; common.noiseFilter = (def as any).filterFreq; common.multiBurst = (def as any).multiBurst; common.click = (def as any).click; common.decay = (def as any).decay; }
    if (def.kind === 'fx') { common.lfoRate = (def as any).lfoRate; common.freq = (def as any).freq; common.freqStartHZ = (def as any).freqStart; common.freqEndHZ = (def as any).freqEnd; common.resonance = (def as any).resonance; common.noiseType = (def as any).noiseType; common.wobble = 0.15; }
    return common;
  }

  /** Steuert den Synth (Note-On) – Phase 9: hörbar über den V2-Sink. */
  public noteOnWorklet(freq: number, velocity = 1, _osc = 'saw') {
    this.v2LiveSink.setSynthSource('channel8', Math.max(20, Math.min(20000, freq)), 'lead');
    this.v2LiveSink.synthTrigger('channel8', Math.max(0.2, Math.min(1, velocity)));
  }
  public noteOffWorklet() {
    this.v2LiveSink.stopSample('channel8');
  }

  public async play() {
    // MAIN-Schutz: Transport startet nur beim mixerMONK-Halter.
    if (!this.monitor.isMainHolderActive()) return;
    this.idleDetector.activity(); // AM-E6-5: Play beendet Idle-Suspend
    // Phase 9: V2-Transport läuft über den sample-genauen AudioWorklet-
    // Scheduler (v2SinkProcessor/V2SampleClock) – kein V1-Scheduler mehr.
    await this.ensureInitialized();
    const connected = await this.connectV2LiveOutput();
    if (!connected) return;
    this.syncV2PatternsToLiveSink();
    this.syncV2SamplesToLiveSink();
    this.syncV2SynthSourcesToLiveSink();
    this.v2LiveSink.startTransport({
      bpm: Tone.Transport.bpm.value,
      swing: this.swing,
      gate: this.gate,
      stepCount: this.stepCount,
    });
    this.isPlaying = true;
  }

  public stop() {
    if (!this.monitor.isMainHolderActive()) return;
    this.isPlaying = false;
    this.v2LiveSink.stopTransport();
    this.v2LiveSink.disconnect();
  }

  public dispose() {
    this.stop();

    // Fallback-Instrument + Preview-Player entsorgen (Leak-Schutz).
    this.disposeInstrumentSynth();
    try { this.previewPlayer?.dispose(); } catch { /* ignore */ }
    this.previewPlayer = null;

    // Sample-Player-Zustand zurücksetzen.
    this.samplePlayers = {};
    this.trackSampleUrl = {
      channel1: null, channel2: null, channel3: null, channel4: null,
      channel5: null, channel6: null, channel7: null, channel8: null,
      channel9: null, channel10: null,
    };

    // Kanalzug-Zustand zurücksetzen (keine Audio-Nodes mehr – reine Zustände).
    this.channelInputs = {};
    this.channelGains = {};
    this.channelPans = {};
    this.channelEQs = {};

    // Spatial-Zustand zurücksetzen.
    if (this.spatialRebuildTimer) { clearTimeout(this.spatialRebuildTimer); this.spatialRebuildTimer = null; }
    this.spatialGains = [];
    this.spatialMerger = null;
    this.spatialEnabled = false;

    // Legacy-Taps zurücksetzen (V2-Ausgang wird über v2LiveSink abgegriffen).
    this.outputGain = null;
    this.masterStreamTap = null;
    this.mainMonitorGain = null;
    this.cueTrackGains = {};
    this.cueBus = null;
    this.cueOutGain = null;
    this.monitor.reset();

    // PDC-Delay abräumen.
    try { this.cuePdcDelay?.disconnect(); } catch { /* ignore */ }
    this.cuePdcDelay = null;

    // Drum-Buffer-Cache freigeben.
    this.drumBufferCache.clear();
    this.drumBufferPromises.clear();

    // Phase 9: Keine Mastering-No-Op-Kette mehr – nur Zustände zurücksetzen.
    this.masterVolume?.dispose();
    Object.values(this.masterBuses).forEach(b => b.dispose());

    // Worklets trennen und nullen (keine Zombie-Nodes nach dispose()+init()).
    for (const key of ['dspNode', 'eqNode', 'masteringNode', 'lufsNode', 'analyzerNode',
      'itSynthNode', 'effectNode', 'dynamicsNode',
      'granularNode', 'fm6Node', 'drumSynthNode'] as const) {
      try {
        (this as unknown as Record<string, { disconnect: () => void } | null>)[key]?.disconnect();
      } catch { /* bereits getrennt */ }
    }
    this.dspNode = null as unknown as typeof this.dspNode;
    this.eqNode = null as unknown as typeof this.eqNode;
    this.masteringNode = null as unknown as typeof this.masteringNode;
    this.lufsNode = null as unknown as typeof this.lufsNode;
    this.analyzerNode = null as unknown as typeof this.analyzerNode;
    this.itSynthNode = null;
    this.effectNode = null;
    this.dynamicsNode = null;
    this.granularNode = null;
    this.fm6Node = null;
    this.drumSynthNode = null;
    this.itSynthReady = false;

    // V2-Live-Sink trennen (falls verbunden).
    this.v2LiveSink.disconnect();

    this.initialized = false;
  }

  // #14: Physikalischer Instrument-Synthesizer (additive Synthese).
  private instrumentOscs: Tone.Oscillator[] = [];
  private instrumentPartialRatios: number[] = [];
  private instrumentNoise: Tone.Noise | null = null;
  private instrumentVibrato: Tone.Oscillator | null = null;
  private instrumentFilter: Tone.Filter | null = null;
  private instrumentEnvOut: Tone.Gain | null = null;

  /** Lädt ein Instrument (Patch) und baut den additiven Synthesizer neu auf. */
  public async loadInstrument(instrumentId: number) {
    this.ensureInitialized();
    const patch = getPatch(instrumentId);
    this.disposeInstrumentSynth();
    if (!patch) return;
    await this.buildInstrumentSynth(patch);
  }

  public getInstrumentPatches() {
    return INSTRUMENT_PATCHES;
  }

  /** Spielt eine Note am aktuellen Instrument-Synth (MIDI o. Name wie 'A4'). */
  public instrumentNote(note: string | number) {
    if (this.instrumentOscs.length === 0) return;
    const freq = typeof note === 'number'
      ? Tone.Frequency(note, 'midi').toFrequency()
      : Tone.Frequency(note).toFrequency();
    const t = this.ctx?.currentTime ?? 0;
    // Additive Synthese: jede Partial-Oszillator-Frequenz = Grundfrequenz * ratio.
    this.instrumentOscs.forEach((osc, i) => {
      const ratio = this.instrumentPartialRatios[i] ?? 1;
      try { osc.frequency.setValueAtTime(freq * ratio, t); } catch { /* ignore */ }
    });
    // Envelope/Gain anheben (trigger).
    this.instrumentEnvOut?.gain.cancelScheduledValues(t);
    try { this.instrumentEnvOut?.gain.setValueAtTime(0.0001, t); } catch { /* ignore */ }
    try { this.instrumentEnvOut?.gain.exponentialRampToValueAtTime(1, t + 0.01); } catch { /* ignore */ }
  }

  public instrumentRelease(time?: number) {
    // Worklet-Pfad: Note freigeben (ADSR-Release im Audio-Thread).
    this.itSynthNode?.port.postMessage({ type: 'noteOff', fast: false });
    const t = time ?? this.ctx?.currentTime ?? 0;
    this.instrumentEnvOut?.gain.cancelScheduledValues(t);
    this.instrumentEnvOut?.gain.setTargetAtTime(0.0001, t, 0.15);
  }

  /** Harte Note-Aus (alle Stimmen) – für Umschalten/Stop. */
  public allNotesOffItSynth() {
    this.itSynthNode?.port.postMessage({ type: 'allNotesOff' });
  }

  // --- Task 1/3: sample-genaue Automation + Stimmen-Status des it-synth ---
  /** Aktive Stimmen (zuletzt vom Worklet gemeldet). */
  public itSynthActiveVoices = 0;
  /** Callback für Stimmen-Status-Updates (UI-Spiegelung). */
  public onItSynthStates: (active: number) => void = () => {};

  /** Sendet eine sample-genaue Automations-Rampe an den instrumentMONK-Worklet. */
  public automateItSynthParam(
    param: 'cutoff' | 'resonance' | 'modIndex' | 'gain' | 'lfoRate' | 'lfoDepth',
    value: number,
    rampTime = 0.02,
  ) {
    if (!this.itSynthReady || !this.itSynthNode) return;
    this.itSynthNode.port.postMessage({ type: 'automate', param, value, rampTime });
  }

  /**
   * Erzeugt eine MediaStream-Destination am Master-Ausgang (für Stream/SFU).
   * Liefert null, wenn kein AudioContext/Master vorhanden ist (kein Fake).
   */
  public createMasterStreamDestination(): MediaStreamAudioDestinationNode | null {
    try {
      if (!this.ctx || typeof this.ctx.createMediaStreamDestination !== 'function') return null;
      const dest = this.ctx.createMediaStreamDestination();
      // AUDIO-P0-002: Bevorzugt den hörbaren V2-Ausgang abgreifen.
      if (this.v2LiveSink.isConnected) {
        if (this.v2LiveSink.connectExtra(dest)) {
          this.masterStreamDest = dest;
          this.masterStreamDestConnected = true;
          return dest;
        }
      }
      // AUDIT-AUDIO-006: Hier gab es einen stillen Erfolg. `masterStreamTap` wird
      // nirgends als echter Knoten aufgebaut (immer null), deshalb griff immer der
      // Fallback `?? this.masterVolume` – und `masterVolume` ist eine reine
      // Zustands-Fassade aus `nativeAudioKit`, deren `connect()` nur `return this`
      // ist. Folge: der Aufrufer bekam eine gültige MediaStream-Destination zurück,
      // der Stream blieb aber STUMM, und kein Test hat es bemerkt.
      // Es gibt keinen No-Op-Fallback mehr: ohne echten Audio-Knoten wird der
      // Nicht-Zustand explizit gemeldet (null), damit Stille sichtbar ist.
      if (!this.masterStreamTap) return null;
      this.masterStreamTap.connect(dest);
      this.masterStreamDest = dest;
      this.masterStreamDestConnected = false;
      return dest;
    } catch {
      return null;
    }
  }

  /** Trennt eine zuvor erzeugte Master-Stream-Destination sauber. */
  public disconnectMasterStreamDestination(dest: MediaStreamAudioDestinationNode): void {
    try {
      // AUDIO-P0-002: V2-Abgriff zuerst trennen, sonst Legacy-Tap.
      this.v2LiveSink.disconnectExtra(dest);
      // Kein No-Op-Fallback (siehe createMasterStreamDestination).
      this.masterStreamTap?.disconnect(dest);
      dest.disconnect();
      if (this.masterStreamDest === dest) {
        this.masterStreamDest = null;
        this.masterStreamDestConnected = false;
      }
    } catch { /* bereits getrennt */ }
  }

  /**
   * VisualMONK: Analyser-Tap am hörbaren V2-Ausgang (reiner Fan-out, verändert
   * den Signalweg nicht). Liefert `null`, wenn der V2-Sink nicht verbunden ist –
   * der Visualizer bleibt dann im Ruhezustand, statt Stille als Audio zu verkaufen.
   */
  public createVisualAnalyser(fftSize = 2048): AnalyserNode | null {
    try {
      if (!this.ctx || typeof this.ctx.createAnalyser !== 'function') return null;
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0.75;
      if (!this.v2LiveSink.isConnected || !this.v2LiveSink.connectExtra(analyser)) {
        try { analyser.disconnect(); } catch { /* ignore */ }
        return null;
      }
      return analyser;
    } catch {
      return null;
    }
  }

  /** Trennt einen Visual-Analyser sauber vom V2-Ausgang. */
  public disconnectVisualAnalyser(analyser: AnalyserNode): void {
    try {
      this.v2LiveSink.disconnectExtra(analyser);
      analyser.disconnect();
    } catch { /* bereits getrennt */ }
  }

  /** Audio-Health-Snapshot für den Echtzeit-Performance-Monitor. */
  public getAudioHealth(): { state: string; sampleRate: number; baseLatencyMs: number; outputLatencyMs: number } {
    const ctx = this.ctx as unknown as {
      state?: string; sampleRate?: number; baseLatency?: number; outputLatency?: number;
    } | null;
    return {
      state: ctx?.state ?? 'closed',
      sampleRate: ctx?.sampleRate ?? 0,
      baseLatencyMs: (ctx?.baseLatency ?? 0) * 1000,
      // Chromium liefert outputLatency (Ausgabe-Puffer); andere Browser 0.
      outputLatencyMs: (ctx?.outputLatency ?? 0) * 1000,
    };
  }

  /** A-4: Latenz-Budget inkl. Mastering-Lookahead/PDC je Stufe. */
  public getLatencyBudgetMs(): { masteringLookaheadMs: number; cuePdcMs: number; outputLatencyMs: number; totalMs: number } {
    const health = this.getAudioHealth();
    const masteringLookaheadMs = this.PDC_MASTERING_LOOKAHEAD_SEC * 1000;
    return {
      masteringLookaheadMs,
      cuePdcMs: this.cuePdcDelay ? this.PDC_MASTERING_LOOKAHEAD_SEC * 1000 : 0,
      outputLatencyMs: health.outputLatencyMs,
      totalMs: health.baseLatencyMs + health.outputLatencyMs + masteringLookaheadMs,
    };
  }

  /** App-weites Ausgabegerät setzen (setSinkId, z. B. ASUS Xonar U7). */
  public async setOutputDevice(deviceId: string): Promise<void> {
    if (!this.ctx) return;
    const ctx = this.ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (typeof ctx.setSinkId === 'function' && deviceId) {
      try {
        await ctx.setSinkId(deviceId);
        this.lastDeviceError = null;
      } catch (e) {
        // USB-Interface getrennt / Device nicht mehr vorhanden: App darf nicht
        // crashen; Fehler für die UI merken, Default-Device bleibt aktiv.
        this.lastDeviceError = (e as Error).message;
        console.warn('[audio] setSinkId fehlgeschlagen (Device-Loss?):', this.lastDeviceError);
      }
    }
  }

  // --- Task 2.1.4 / F4: JSON-serialisierbarer Audio-Graph (Export/Import) ---
  private graphStateBridge = new GraphStateBridge();

  /** V2-Playback-Engine (voller Ersatzpfad für den V1-Transport).
   *  Phase 9: Der Startmodus ist immer 'v2' – es gibt keinen V1-Fallback mehr. */
  public playbackMode: AudioPlaybackMode = initialPlaybackMode();
  public graphPlayback = new GraphPlaybackEngine((source, _ctx) =>
    this.buildWorkletChain(['it-synth', 'eq3', 'mastering'], source).output,
  );

  public setPlaybackMode(mode: AudioPlaybackMode): void {
    const resolved = resolvePlaybackMode(mode);
    if (resolved === this.playbackMode) return;
    this.playbackMode = resolved;
    if (resolved === 'v2') this.stop();
  }

  // NEW-D4-1: V2-StudioGraph (backend-unabhängiger Mischpfad) für Offline-/Tests.
  // Live-Output läuft über v2LiveSink (V2SinkEngine im AudioWorklet, Phase 1).
  public v2Studio = new V2StudioGraph();

  /** V2-Live-Output-Sink: rendert V2StudioGraph im AudioWorklet zur Destination. */
  public v2LiveSink = new V2LiveSink();

  /** Verbindet den V2-Live-Output-Sink mit der AudioContext-Destination. */
  public async connectV2LiveOutput(): Promise<boolean> {
    await this.ensureInitialized();
    // Phase 4: V2-Sink folgt dem 2.1-/Stereo-Ausgabemodus des Master-Pfads.
    this.v2LiveSink.setOutputLayout(this.stereoMode === '2.1' ? '2.1' : 'stereo');
    const ok = await this.v2LiveSink.connect(this.ctx);
    if (ok) {
      this.syncV2FromV1();
      // AUDIO-P0-002: Master-Stream-Destination an den V2-Ausgang hängen.
      if (this.masterStreamDest && !this.masterStreamDestConnected) {
        this.masterStreamDestConnected = this.v2LiveSink.connectExtra(this.masterStreamDest);
      }
    }
    return ok;
  }

  /** Startet einen hörbaren V2-Testton (Phase-1-Nachweis). */
  public async playV2TestTone(freq = 440, amplitude = 0.2): Promise<boolean> {
    await this.ensureInitialized();
    if (!(await this.connectV2LiveOutput())) return false;
    this.v2LiveSink.setMasterGain(1);
    return this.v2LiveSink.startTestTone(freq, amplitude);
  }

  /** Stoppt den V2-Testton und trennt den Live-Sink (kein Leerlauf im Audio-Thread). */
  public stopV2TestTone(): void {
    this.v2LiveSink.stopTestTone();
    this.v2LiveSink.disconnect();
  }

  /** Rendert einen V2-Block (128 Samples Stereo) durch den Graph. */
  public renderV2Block(): Float32Array[] | null {
    try {
      const sr = this.ctx?.sampleRate ?? 48000;
      return this.v2Studio.render({ sampleRate: sr, bufferSize: 128, quantum: 128 / sr, currentTime: Tone.now() });
    } catch {
      return null;
    }
  }

  /** V1-Zustand in den V2-Graph spiegeln (AUDIO-P1-002: Logik in src/audio/v2SyncMirror.ts). */
  public syncV2FromV1(): void {
    const channels: Record<string, { gainDb: number; pan: number; muted: boolean }> = {};
    for (const t of V2_CHANNELS) {
      channels[t] = {
        gainDb: this.channelGains[t]?.volume.value ?? 0,
        pan: this.channelPans[t]?.pan.value ?? 0,
        muted: Boolean(this.mutedStems[t]),
      };
    }
    syncV2Mix(this.v2Studio, this.v2LiveSink, {
      channels,
      masterGainLinear: Math.pow(10, (this.masterVolume?.volume.value ?? -6) / 20),
      monitorPlan: this.monitor.getPlan(),
    });
  }

  /** Spiegelt alle Step-Patterns in den V2-Live-Sink (Phase 2). */
  public syncV2PatternsToLiveSink(): void {
    syncV2Patterns(this.v2LiveSink, this.patterns);
  }

  /** Spiegelt geladene Tone.js-/Browser-Player-Samples in den V2-Sink (Phase 3). */
  public syncV2SamplesToLiveSink(): void {
    (['channel1','channel2','channel3','channel4','channel5','channel6','channel7','channel8','channel9','channel10'] as TrackType[]).forEach((t) => {
      const player = this.samplePlayers[t];
      const audioBuffer = player?.buffer?.get?.();
      if (audioBuffer) this.bridgeAudioBufferToV2(t, audioBuffer);
    });
  }

  /**
   * AUDIO-P0-001: Rollenbasierte Synth-Stimmen (kick/hat/clap/bass/lead) an den
   * V2-Sink übertragen, damit Pattern-Steps ohne Sample die richtige Stimme spielen.
   */
  public syncV2SynthSourcesToLiveSink(): void {
    syncV2Voices(this.v2LiveSink);
  }

  /** Bridge: decodierter AudioBuffer (Tone.js/Browser) → V2-Sample-Source. */
  public bridgeAudioBufferToV2(track: TrackType, audioBuffer: AudioBuffer): boolean {
    if (!audioBuffer || audioBuffer.numberOfChannels === 0) return false;
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    return this.v2LiveSink.setSampleBuffer(track, left, right, audioBuffer.sampleRate);
  }

  /** Bridge: bereits dekodierte planare Samples (z. B. SFZ-/OPFS-Cache) → V2. */
  public bridgeDecodedSamplesToV2(
    track: TrackType,
    left: Float32Array,
    right?: Float32Array | null,
    sourceRate = 48000,
  ): boolean {
    return this.v2LiveSink.setSampleBuffer(track, left, right ?? null, sourceRate);
  }

  /** Exportiert den kompletten hörbaren Zustand als JSON-fähiges Objekt. */
  public exportGraphState(): AudioGraphState {
    const gains: Record<string, number> = {};
    const pans: Record<string, number> = {};
    (['channel1','channel2','channel3','channel4','channel5','channel6','channel7','channel8','channel9','channel10'] as TrackType[]).forEach((t) => {
      gains[t] = this.channelGains[t]?.volume.value ?? 0;
      pans[t] = this.channelPans[t]?.pan.value ?? 0;
    });
    return {
      version: 1,
      bpm: Tone.Transport.bpm.value,
      swing: this.swing,
      gate: this.gate,
      scale: String(this.currentScaleName),
      patterns: JSON.parse(JSON.stringify(this.patterns)) as Record<string, boolean[]>,
      synthNotes: [...this.synthNotes],
      masterVolumeDb: this.masterVolume?.volume.value ?? -6,
      spatialSetupId: this.spatialSetupId,
      channelGainsDb: gains,
      channelPans: pans,
      timestamp: Date.now(),
    };
  }

  /** Exportiert über die backend-unabhängige GraphStateBridge (Phase-1-Migration). */
  public exportGraphStateV2(): AudioGraphState {
    const state = this.exportGraphState();
    this.graphStateBridge.importState(state);
    return this.graphStateBridge.exportState(state);
  }

  /** Importiert über die GraphStateBridge und wendet den Zustand danach normal an. */
  public importGraphStateV2(state: AudioGraphState): boolean {
    if (!isAudioGraphState(state)) return false;
    this.graphStateBridge.importState(state);
    return this.importGraphState(state);
  }

  /**
   * Phase 6: Exportiert den vollständigen V2-Session-State
   * (AudioGraph + MonitorRouting + aktive Plugins + Transport-Metadaten).
   */
  public exportV2SessionState(sessionId = 'main-studio', actorId = 'localUser'): V2SessionGraphState {
    return exportV2SessionState({
      sessionId,
      graph: this.exportGraphState(),
      monitor: this.monitor.getPlan(),
      activePlugins: [...this.activePluginIds],
      updatedBy: actorId,
    });
  }

  /**
   * Phase 6: Importiert einen V2-Session-State und wendet Graph/Monitor/Plugins
   * auf die Engine an. Defensiv: ungültige Zustände werden abgelehnt.
   */
  public importV2SessionState(raw: unknown): boolean {
    const parsed = parseV2SessionState(raw);
    if (!parsed.ok) return false;
    const { graph, monitor, activePlugins } = parsed.state;

    if (!this.importGraphStateV2(graph)) return false;

    // Monitor-/Cue-Plan übernehmen (Cue-Matrix des Ziel-Monitors ersetzen).
    this.monitor.importRoutingPlan(monitor);

    // Audio-einspeisende Plugins des Session-Stands aktivieren (idempotent).
    for (const pluginId of activePlugins) {
      if (!this.activePluginIds.has(pluginId)) {
        try {
          this.activatePlugin(pluginId, 'PRO');
        } catch {
          /* Plugin-Aktivierung optional – Graph-Zustand zählt zuerst */
        }
      }
    }
    return true;
  }

  /** Registriert einen Worklet-Prozessor für den graphbasierten Migrationspfad. */
  public registerWorkletProcessor(spec: WorkletSpec): void {
    workletGraphRuntime.registerWorklet(spec);
  }

  /** Baut Source → Worklet-Kette als kompilierten ProcessingPlan. */
  public buildWorkletChain(workletIds: string[], source: Float32Array[]): WorkletChainResult {
    const len = source[0]?.length ?? 128;
    const sampleRate = this.ctx?.sampleRate ?? 48000;
    const ctx = { sampleRate, bufferSize: len, currentTime: 0, quantum: len / sampleRate };
    return workletGraphRuntime.buildChain(workletIds, source, ctx);
  }

  /**
   * Deterministischer Offline-Bounce über dieselbe Worklet-Kette (V2-Pfad).
   * `tailSeconds` hängt Stille-Blöcke an, damit Delay-/Reverb-Tails ausklingen.
   */
  public bounceGraph(source: Float32Array[], workletIds: string[], opts?: { tailSeconds?: number }): BounceResult {
    if (workletGraphRuntime.listWorklets().length === 0) {
      registerReferenceWorkletSpecs(workletGraphRuntime);
    }
    const engine = new OfflineBounceEngine(this.ctx?.sampleRate ?? 48000);
    return engine.bounce(source, workletIds, { tailSeconds: opts?.tailSeconds ?? 2 });
  }

  /** Phase 5: Offline-Bounce durch echte V2-Processing-Nodes (EQ/DSP/FX/Dynamics/Mastering). */
  public bounceV2NodeChain(source: Float32Array[], nodes: IAudioNode[], opts?: { tailSeconds?: number }): BounceResult {
    const engine = new OfflineBounceEngine(this.ctx?.sampleRate ?? 48000);
    return engine.bounceNodeChain(source, nodes, { tailSeconds: opts?.tailSeconds ?? 2 });
  }

  /** Listet alle registrierten Worklet-Prozessoren. */
  public listWorkletProcessors(): string[] {
    return workletGraphRuntime.listWorklets();
  }

  // --- Phase-1-Migration: V2-Transport über den AudioGraph (Worklet-Kette) ---
  // Die echten WebAudio-/Tone-Pfade (V1) bleiben für die UI unverändert; V2
  // verarbeitet ausschließlich über den backend-unabhängigen ProcessingPlan.

  public graphTransportState = { playing: false };
  public lastGraphOutput: Float32Array[] | null = null;

  // Phase 3: Source → Extraction → AudioObject Pipeline.
  public spatialSceneV2 = new SpatialScene();
  public sourceExtraction = new SourceExtractionPipeline(this.spatialSceneV2);

  /** Nimmt Audio-Quellen entgegen und legt sie als AudioObjects in der SpatialScene ab. */
  public ingestAudioSources(sources: AudioSourceInput[]) {
    return this.sourceExtraction.process(sources);
  }

  public async playV2(): Promise<void> {
    this.graphTransportState.playing = true;
  }

  public stopV2(): void {
    this.graphTransportState.playing = false;
  }

  /** Triggert einen Impuls über die Worklet-Kette und liefert den Graph-Output. */
  public triggerEventV2(_track: TrackType, velocity = 1.0): Float32Array[] | null {
    const len = 128;
    const sr = this.ctx?.sampleRate ?? 48000;
    const source: Float32Array[] = [new Float32Array(len)];
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      source[0][i] = Math.sin(2 * Math.PI * 440 * t) * velocity * Math.exp(-t * 8);
    }
    const chain = this.buildWorkletChain(['it-synth', 'eq3', 'mastering'], source);
    this.lastGraphOutput = chain.output;
    this.graphTransportState.playing = true;
    return chain.output;
  }

  /**
   * Live-Verdrahtung der echten Worklet-Nodes zur WebAudio-Destination.
   * Browser-only: in Node/jsdom ein sicherer No-Op (false).
   */
  public connectLiveWorkletChain(): boolean {
    if (!this.ctx) return false;
    const source = this.itSynthNode as AudioNode | null;
    if (!source) return false;
    const bridge = new WebAudioWorkletBridge();
    return bridge.connect({
      source,
      eq: this.eqNode,
      mastering: this.masteringNode,
      destination: this.ctx.destination,
    });
  }

  /** Stellt einen exportierten Audio-Graph-Zustand wieder her (validiert). */
  public importGraphState(state: AudioGraphState): boolean { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    if (!isAudioGraphState(state)) return false;
    try {
      if (Number.isFinite(state.bpm) && state.bpm >= 20 && state.bpm <= 300) {
        Tone.Transport.bpm.value = state.bpm;
      }
      this.swing = Math.max(0, Math.min(1, state.swing));
      this.gate = Math.max(0.05, Math.min(1, state.gate));
      if (typeof state.scale === 'string' && state.scale in MUSIC_SCALES) {
        this.currentScaleName = state.scale as keyof typeof MUSIC_SCALES;
      }
      this.loadPatterns(state.patterns, state.synthNotes, state.bpm);
      for (const [track, db] of Object.entries(state.channelGainsDb)) {
        if (!(track in this.patterns)) continue;
        this.ensureChannelNode(track as TrackType);
        if (Number.isFinite(db)) this.channelGains[track as TrackType]!.volume.rampTo(db, 0.03);
      }
      for (const [track, pan] of Object.entries(state.channelPans)) {
        if (!(track in this.patterns)) continue;
        this.ensureChannelNode(track as TrackType);
        if (Number.isFinite(pan)) this.channelPans[track as TrackType]!.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), this.ctx?.currentTime ?? Tone.now(), 0.03);
      }
      if (Number.isFinite(state.masterVolumeDb)) this.masterVolume.volume.rampTo(state.masterVolumeDb, 0.03);
      if (typeof state.spatialSetupId === 'string') this.setSpatialSetup(state.spatialSetupId);
      return true;
    } catch (e) {
      console.warn('Audio-Graph-Import fehlgeschlagen:', e);
      return false;
    }
  }

  private async buildInstrumentSynth(patch: InstrumentPatch) {
    try {
      const vol = new Tone.Gain(0);
      // F1: Instrument-Stimmen über den Kanalzug (channel4) führen.
      this.ensureChannelNode('channel4');
      vol.connect(this.channelInputs.channel4 ?? this.masterBuses['GLOBAL_MASTER']);

      const [a, d, s, r] = patch.env;
      const baseEnv = new Tone.AmplitudeEnvelope(a, d, s, r).connect(vol);

      // Additive Obertöne (Sinus je Partial) mit Anblas-/Anschlag-Kurve.
      const partialNodes: Tone.Oscillator[] = [];
      const ratios: number[] = [];
      patch.partials.forEach((p, _i) => {
        // Bei eingebauten Oszillator-Wellen ist die Teilwelle genug;
        // multi-sample-Pattials werden als Detune-Spread additiv gemischt.
        const osc = new Tone.Oscillator(patch.osc);
        osc.frequency.value = 220; // Platzhalter; wird in instrumentNote präzise gesetzt.
        const g = new Tone.Gain(p.amp / Math.max(1, patch.partials.length));
        osc.connect(g);
        g.connect(baseEnv);
        osc.start();
        partialNodes.push(osc);
        ratios.push(p.ratio);
      });

      // Filter (Resonanz nach Bauart) – Q wird separat am Filter gesetzt
      // (Tone.Filter: drittes Argument ist der Rolloff, nicht die Resonanz-Q).
      const filt = new Tone.Filter(patch.filterFreq, patch.filterType, -12);
      try { (filt as any).Q.value = patch.filterQ; } catch { /* Q ggf. nicht verfügbar */ }
      baseEnv.disconnect(vol);
      baseEnv.connect(filt);
      filt.connect(vol);

      // Vibrato: LFO moduliert die Detune aller akustischen Oszillatoren
      // (physiologisch korrekt – Frequenz-Vibrato statt purer Lautheits-Tremolo).
      if (patch.vibratoAmt > 0.01) {
        const lfoOsc = new Tone.Oscillator(patch.vibratoHz, 'sine');
        const lfoGain = new Tone.Gain(patch.vibratoAmt * 80); // Detune in Cents
        lfoOsc.connect(lfoGain);
        partialNodes.forEach((o) => lfoGain.connect((o as any).detune));
        lfoOsc.start();
        this.instrumentVibrato = lfoOsc;
      }

      // Anblas-NOISE für Bläser/Reibung (hochpassgefiltert)
      if (patch.noise > 0.03) {
        const noise = new Tone.Noise('white');
        const noiseEnv = new Tone.AmplitudeEnvelope(a * 0.5, d, s * 0.4, r);
        const hp = new Tone.Filter(patch.filterFreq * 0.6, 'highpass');
        noise.chain(hp, noiseEnv, vol);
        noise.start();
        this.instrumentNoise = noise;
      }

      this.instrumentOscs = partialNodes;
      this.instrumentPartialRatios = ratios;
      this.instrumentFilter = filt;
      this.instrumentEnvOut = vol;

      // Basis-Envelope wird beim Note-On getriggert; hier als stabile baseline.
      vol.gain.value = 0.0001;
    } catch (e) {
      console.warn('Instrument-Synth nicht aufgebaut:', e);
      this.disposeInstrumentSynth();
    }
  }

  private disposeInstrumentSynth() {
    this.instrumentOscs.forEach((o) => { try { o.stop(); o.disconnect(); } catch { /* ignore */ } });
    this.instrumentNoise?.stop();
    this.instrumentNoise?.disconnect();
    this.instrumentVibrato?.stop?.();
    this.instrumentVibrato?.disconnect?.();
    this.instrumentFilter?.disconnect();
    this.instrumentEnvOut?.disconnect();
    this.instrumentOscs = [];
    this.instrumentPartialRatios = [];
    this.instrumentNoise = null;
    this.instrumentVibrato = null;
    this.instrumentFilter = null;
    this.instrumentEnvOut = null;
  }

  /**
   * Spielt ein Synthese-Instrument aus dem erweiterten Katalog (`instrumentMONK`):
   * Analog-Synth (subtraktiv), FM, Drum/Perc, FX. Nutzt dieselbe Dispose-Gruppe
   * wie die akustischen Patches, läuft aber über eigene Tone-JS-Ketten.
   * `kind==='acoustic'` bleibt über `loadInstrument`/`instrumentNote` laufen.
   */
  public playSynthesisInstrument(def: InstrumentDefinition, note: string | number, velocity = 1) { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    this.ensureInitialized();

    // AUDIO-P0-003: Instrument hörbar in den V2-Live-Pfad leiten (immer).
    {
      const instChannel: TrackType = def.kind === 'drum' ? 'channel2' : 'channel4';
      const v2Freq = typeof note === 'number'
        ? Tone.Frequency(note, 'midi').toFrequency()
        : Tone.Frequency(note).toFrequency();
      this.v2LiveSink.setSynthSource(instChannel, v2Freq, def.kind === 'drum' ? 'clap' : 'lead');
      this.v2LiveSink.synthTrigger(instChannel, Math.max(0.2, Math.min(1, velocity)));
    }

    // --- bevorzugter Pfad: sample-genauer AudioWorklet (it-synth-processor) ---
    if (this.itSynthReady && this.itSynthNode) {
      if (this.itSynthCurrentDefId !== def.id) {
        this.itSynthNode.port.postMessage({ type: 'config', def: this.toPitchDef(def) });
        this.itSynthCurrentDefId = def.id;
      }
      this.itSynthNode.port.postMessage({ type: 'noteOn', note, velocity });
      return;
    }

    // --- Fallback: Tone.js-Ketten (nur, wenn Worklet nicht verfügbar) ---
    // Vorherige Fallback-Stimme zuerst entsorgen – sonst leaken Oszillatoren/
    // Filter/Envelopes pro Note (GC-Pausen im Dauerbetrieb).
    this.disposeInstrumentSynth();
    const freq = typeof note === 'number'
      ? Tone.Frequency(note, 'midi').toFrequency()
      : Tone.Frequency(note).toFrequency();
    const t = this.ctx?.currentTime ?? 0;
    // F1: Tone.js-Fallback-Stimmen über den Kanalzug führen (Drum→channel2, Rest→channel4).
    const instChannel: TrackType = def.kind === 'drum' ? 'channel2' : 'channel4';
    this.ensureChannelNode(instChannel);
    const outBus = this.channelInputs[instChannel] ?? this.masterBuses['GLOBAL_MASTER'];

    try {
      switch (def.kind) {
        case 'synth': {
          const d = def as SynthDef;
          const osc = new Tone.Oscillator(freq, d.osc);
          const env = new Tone.AmplitudeEnvelope(d.attack, 0.2, 0.2, d.release);
          const filt = new Tone.Filter(d.cutoff, d.filter, -12);
          (filt as any).Q.value = d.resonance;
          const out = new Tone.Gain(velocity * 0.8);
          osc.connect(env).connect(filt).connect(out);
          out.connect(outBus);
          env.triggerAttackRelease(0.5, t);
          osc.start(t);
          osc.stop(t + d.attack + 0.5 + d.release + 0.1);
          this.instrumentOscs = [osc];
          this.instrumentFilter = filt;
          this.instrumentEnvOut = new Tone.Gain(1);
          break;
        }
        case 'fm': {
          const d = def as FmDef;
          const carrier = new Tone.Oscillator(freq, d.carrier);
          const modulator = new Tone.Oscillator(freq * 2, d.modulator);
          const modGain = new Tone.Gain(freq * d.modIndex);
          const env = new Tone.AmplitudeEnvelope(d.attack, 0.1, 0.1, d.release);
          const filt = new Tone.Filter(6000, 'lowpass');
          const out = new Tone.Gain(velocity * 0.7);
          modulator.connect(modGain).connect(carrier.frequency);
          carrier.connect(env).connect(filt).connect(out);
          out.connect(outBus);
          env.triggerAttackRelease(0.5, t);
          modulator.start(t); carrier.start(t);
          const stop = t + d.attack + 0.5 + d.release + 0.1;
          modulator.stop(stop); carrier.stop(stop);
          this.instrumentOscs = [carrier, modulator];
          this.instrumentFilter = filt;
          break;
        }
        case 'drum': {
          const d = def as DrumDef;
          if (d.noise) {
            // Rauschbasierte Percussion (Snare/Hat) via Tone.Noise + kurze Hülle.
            const noise = new Tone.Noise('white');
            const filt = new Tone.Filter(d.filterFreq ?? 2000, 'bandpass', -12);
            const env = new Tone.Gain(velocity);
            noise.connect(filt).connect(env);
            env.connect(outBus);
            env.gain.setValueAtTime(velocity, t);
            env.gain.exponentialRampToValueAtTime(0.001, t + (d.decay ?? 0.2));
            noise.start(t);
            noise.stop(t + (d.decay ?? 0.2) + 0.05);
            this.instrumentNoise = noise;
            this.instrumentFilter = filt;
          } else {
            const osc = new Tone.Oscillator(freq * 0.5, 'sine');
            const startF = (d.freqStart ?? 150) + (freq > 200 ? freq * 0.5 : 0);
            const endF = d.freqEnd ?? 40;
            osc.frequency.setValueAtTime(startF, t);
            osc.frequency.exponentialRampToValueAtTime(Math.max(30, endF), t + (d.decay ?? 0.3));
            const env = new Tone.Gain(velocity);
            env.connect(outBus);
            env.gain.setValueAtTime(velocity, t);
            env.gain.exponentialRampToValueAtTime(0.001, t + (d.decay ?? 0.3));
            osc.connect(env);
            osc.start(t); osc.stop(t + (d.decay ?? 0.3) + 0.05);
            this.instrumentOscs = [osc];
          }
          break;
        }
        case 'fx': {
          const d = def as FxDef;
          const base = d.freq ?? (d.freqStart ?? freq);
          const osc = new Tone.Oscillator(base, d.wave);
          const out = new Tone.Gain(velocity * 0.5);
          const filt = new Tone.Filter(d.resonance ? 3000 : 1200, 'lowpass');
          (filt as any).Q.value = d.resonance ?? 1;
          osc.connect(filt).connect(out);
          out.connect(outBus);
          // Frequency-Sweep falls definiert.
          if (d.freqStart && d.freqEnd) {
            osc.frequency.setValueAtTime(d.freqStart, t);
            osc.frequency.exponentialRampToValueAtTime(Math.max(20, d.freqEnd), t + d.attack + 0.3);
          }
          // LFO-Modulation.
          if (d.lfoRate) {
            const lfo = new Tone.Oscillator(d.lfoRate, 'sine');
            const lfoGain = new Tone.Gain((osc.frequency.value as unknown as number) * 0.5);
            lfo.connect(lfoGain).connect((osc as any).frequency);
            lfo.start(t);
            const stopT = t + d.attack + 0.5 + d.release + 0.1;
            lfo.stop(stopT);
            this.instrumentVibrato = lfo;
          }
          osc.start(t);
          osc.stop(t + d.attack + 0.5 + d.release + 0.1);
          // Envelope.
          out.gain.setValueAtTime(0.0001, t);
          out.gain.exponentialRampToValueAtTime(velocity * 0.5, t + Math.max(0.01, d.attack));
          out.gain.exponentialRampToValueAtTime(0.0001, t + d.attack + 0.5 + d.release);
          this.instrumentOscs = [osc];
          this.instrumentFilter = filt;
          this.instrumentEnvOut = out;
          break;
        }
        default: {
          // acoustic (nicht im getPatch-Katalog, z.B. id 131) – additive Kette.
          const d = def as import('../core/instrument/types').AcousticDef;
          const partialNodes: Tone.Oscillator[] = [];
          const ratios: number[] = [];
          const out = new Tone.Gain(velocity * 0.8);
          out.connect(outBus);
          d.partials.forEach((p) => {
            const o = new Tone.Oscillator(freq * (p.ratio || 1), d.osc);
            const g = new Tone.Gain(p.amp / Math.max(1, d.partials.length));
            o.connect(g).connect(out);
            o.start(t);
            o.stop(t + 1.5);
            partialNodes.push(o);
            ratios.push(p.ratio || 1);
          });
          this.instrumentOscs = partialNodes;
          this.instrumentPartialRatios = ratios;
          this.instrumentEnvOut = out;
          break;
        }
      }
    } catch (e) {
      console.warn('playSynthesisInstrument fehlgeschlagen:', e);
      this.disposeInstrumentSynth();
    }
  }

  public previewSample(track: TrackType, time?: number, url?: string) {
    this.ensureInitialized();
    if (url) {
      // Vorherigen Preview-Player entsorgen, damit schnelles Klicken keinen
      // Player-Leak erzeugt (jeder Tone.Player hält einen Decoder-Puffer).
      try { this.previewPlayer?.dispose(); } catch { /* ignore */ }
      const player = new Tone.Player(url).toDestination();
      player.autostart = true;
      this.previewPlayer = player;
      this.previewUrl = url;
      // AUDIO-P0-003: Preview hörbar in den V2-Sink laden und triggern.
      new Tone.ToneAudioBuffer(url, (buf) => {
        const audioBuffer = buf.get();
        if (audioBuffer && audioBuffer.numberOfChannels > 0) {
          this.bridgeAudioBufferToV2(track, audioBuffer);
          this.v2LiveSink.triggerSample(track, { loop: false, rate: 1, offset: 0 });
        }
      }, () => { /* Dekodier-Fehler: still ignorieren */ });
    } else if (this.samplePlayers[track]) {
      this.samplePlayers[track].start(time);
      // AUDIO-P0-003: auch zuvor geladene Track-Samples im V2-Sink triggern.
      const buffer = this.samplePlayers[track]?.buffer?.get?.();
      if (buffer && buffer.numberOfChannels > 0) {
        this.bridgeAudioBufferToV2(track, buffer);
        this.v2LiveSink.triggerSample(track, { loop: false, rate: 1, offset: 0 });
      }
    }
  }

  /** Stoppt die laufende Hörprobe (falls aktiv) und gibt den Player frei. */
  public stopPreview(): void {
    try { this.previewPlayer?.dispose(); } catch { /* ignore */ }
    this.previewPlayer = null;
    this.previewUrl = null;
  }

  /** URL der aktuell laufenden Hörprobe (null = keine aktiv). */
  public getPreviewUrl(): string | null {
    return this.previewUrl;
  }

  /** Einmalige Hörprobe eines synthetischen Samples (biblioMONK Play-Button).
   *  F1: läuft über den Kanalzug des Ziel-Kanals (Default channel4), damit auch
   *  Vorschauen Fader/EQ/Pan respektieren. */
  public previewSynthesizedSample(
    params: { frequency?: number; decay?: number; pitchDecay?: number; oscillatorType?: string },
    track: TrackType = 'channel4',
  ): void {
    this.ensureInitialized();
    try {
      const freq = Math.max(20, Math.min(20000, params.frequency ?? 220));
      const decay = Math.max(0.05, Math.min(2, params.decay ?? 0.3));
      const types: OscillatorType[] = ['sine', 'triangle', 'square', 'sawtooth'];
      const type = types.includes(params.oscillatorType as OscillatorType) ? (params.oscillatorType as OscillatorType) : 'sine';
      const synth = new Tone.Synth({
        oscillator: { type },
        envelope: { attack: 0.005, decay, sustain: 0.02, release: 0.12 },
      });
      this.ensureChannelNode(track);
      const bus = this.channelInputs[track] ?? this.masterBuses['GLOBAL_MASTER'];
      if (bus) synth.connect(bus);
      else synth.toDestination();
      synth.triggerAttackRelease(freq, '8n');
      setTimeout(() => { try { synth.dispose(); } catch { /* noop */ } }, 1200);
    } catch (e) {
      console.warn('previewSynthesizedSample fehlgeschlagen:', e);
    }
  }

  /** Liefert die aktuell auf einem Track geladene Sample-URL (null = frei). */
  public getTrackSampleUrl(track: TrackType): string | null {
    return this.trackSampleUrl[track] ?? null;
  }

  /** True, wenn auf dem Track bereits ein Sample geladen ist. */
  public isTrackLoaded(track: TrackType): boolean {
    return !!this.trackSampleUrl[track];
  }

  /** WF-2: Lädt/decodiert eine Musik-URL genau einmal und cached den Buffer. */
  private async getMusicBuffer(url: string): Promise<Tone.ToneAudioBuffer> {
    const cached = this.musicBufferCache.get(url);
    if (cached) return cached;
    const buffer = await new Promise<Tone.ToneAudioBuffer>((resolve, reject) => {
      // Konstruktor-Callbacks: onload -> resolve, onerror -> reject.
      const b = new Tone.ToneAudioBuffer(url, () => resolve(b), (e) => reject(e ?? new Error(`Audio-Decode fehlgeschlagen: ${url}`)));
    });
    this.musicBufferCache.set(url, buffer);
    return buffer;
  }

  public async loadTrackSample(track: TrackType, url: string | null) {
    // MAIN-Schutz: laden darf nur der Halter oder ein freigegebener Kanal.
    if (!this.canLoadTrack(track)) return;
    // If there's an existing player for this track, dispose of it.
    // De-Klick: erst weich ausblenden (Volume-Rampe), dann nach kurzer Zeit
    // disconnect/dispose – ein harter dispose() während der Wiedergabe knackst.
    const oldPlayer = this.samplePlayers[track];
    if (oldPlayer) {
      try { oldPlayer.volume.rampTo(-60, 0.02); } catch { /* ignore */ }
      try { oldPlayer.stop(); } catch { /* ignore */ }
      const p = oldPlayer;
      setTimeout(() => {
        try { p.disconnect(); } catch { /* ignore */ }
        try { p.dispose(); } catch { /* ignore */ }
      }, 100);
      delete this.samplePlayers[track];        // Remove reference
    }

    if (url) {
      // Ensure context is running (und AudioGraph inkl. this.ctx) vor dem Laden.
      await this.ensureInitialized();

      // #DJ: Kanalzug sicherstellen und Player DURCH die Kette
      // Pre-Fader → Gain → 3-Band-EQ → Pan → GLOBAL_MASTER routen, damit die
      // Mischpult-Regler (Fader/EQ/Pan/Mute) tatsächlich auf geladene
      // Tracks wirken – vorher ging der Player direkt auf den Master.
      this.ensureChannelNode(track);
      // WF-2: Decode-Cache – identische URL wird nur einmal dekodiert und
      // als ToneAudioBuffer wiederverwendet (kein Decode-Spike beim Reload).
      const buffer = await this.getMusicBuffer(url);
      const player = new Tone.Player(buffer).connect(this.channelInputs[track]!);
      // player.autostart = true; // Or player.start() when needed
      this.samplePlayers[track] = player;
      this.trackSampleUrl[track] = url;
      // Phase 3: Tone.js-Buffer gleichzeitig als V2-Sample-Source registrieren,
      // damit der V2-Pfad denselben dekodierten Buffer nutzen kann.
      const audioBuffer = buffer.get?.();
      if (audioBuffer) this.bridgeAudioBufferToV2(track, audioBuffer);
    } else {
      this.trackSampleUrl[track] = null;
    }
  }

  /**
   * P10: Setzt die räumliche Position einer Spur und bindet die gewählte
   * Mehrkanal-Konfiguration (2/4.0/6/8/10/12/14/16/18.x) ein.
   * - Stereo/HRTF-Cue bleibt für Kopfhörer erhalten.
   * - Zusätzlich werden die N Kanal-Gewichte via calculateChannelPan berechnet
   *   und auf die Kanal-GainNodes des N-Kanal-Spatial-Busses geschrieben.
   */
  public setSpatialPosition(track: TrackType, x: number, y: number) {
    this.ensureInitialized();
    const hrtf = calculateHRTF(x, y, this.ctx?.sampleRate || 48000);

    // HRTF-basiertes Stereo-Cue (Kopfhörer/Engineer). F1/F6: echtes Kanal-Pan
    // statt No-op-setWorkletParam/setMixChannelParam.
    const stereoPan = Math.max(-1, Math.min(1, (hrtf.azimuth || 0) / 90));
    this.setChannelPan(track, stereoPan);

    // Mehrkanal-Konfigurationspanning (VBAP-artig auf 360°-Ring).
    const pan = calculateChannelPan(x, y, this.spatialSetupId);
    this.lastSpatialChannels_ = pan.channels;

    if (this.spatialEnabled && this.spatialGains.length >= pan.channels.length) {
      const t = this.ctx?.currentTime ?? 0;
      pan.channels.forEach((g, i) => {
        const node = this.spatialGains[i];
        if (node) node.gain.setTargetAtTime(g, t, 0.02);
      });
      // LFE-Kanäle (nach den Hauptkanälen) anwenden.
      pan.lfe.forEach((lg, k) => {
        const idx = pan.channels.length + k;
        const node = this.spatialGains[idx];
        if (node) node.gain.setTargetAtTime(lg, t, 0.02);
      });
    }
  }

  /** Liefert die zuletzt berechneten Kanal-Gewichte (für UI/Visualisierung). */
  public getLastSpatialChannels(): number[] {
    return this.lastSpatialChannels_;
  }

  /**
   * spatialMONK-Folgeschritt: Kanal-Pan wahlweise in den spatial-processor-
   * Worklet-Eingang umhängen (target) oder zurück auf GLOBAL_MASTER (null).
   * Ermöglicht echtes Worklet-Routing ohne die bestehende Kette zu verbiegen.
   */
  public routeChannelToSpatialInput(track: TrackType, target: AudioNode | null): boolean {
    this.ensureInitialized();
    this.ensureChannelNode(track);
    const pan = this.channelPans[track];
    const bus = this.masterBuses['GLOBAL_MASTER'];
    if (!pan || !bus) return false;
    try {
      pan.disconnect(bus);
      if (target) pan.connect(target);
      else pan.connect(bus);
      return true;
    } catch {
      return false;
    }
  }

  /** Liefert den Eingang des GLOBAL_MASTER-Busses (für Worklet-Ausgang). */
  public getMasterBusInput(): AudioNode | null {
    return (this.masterBuses['GLOBAL_MASTER'] as any)?.input ?? this.masterBuses['GLOBAL_MASTER'] ?? null;
  }

  /** Legt die Mehrkanal-Konfiguration um (z.B. '10.0', '18.2'). */
  public setSpatialSetup(setupId: string) {
    this.spatialSetupId = SPATIAL_SETUPS.some((s) => s.id === setupId) ? setupId : '10.0';
    if (this.spatialRebuildTimer) { clearTimeout(this.spatialRebuildTimer); this.spatialRebuildTimer = null; }
    // De-Klick: alte Spatial-Gains erst weich auf 0 fahren, dann neu bauen.
    // Ein harter disconnect() während laufender Wiedergabe erzeugt Knackser.
    if (this.spatialGains.length > 0 && this.ctx) {
      const t = this.ctx.currentTime;
      this.spatialGains.forEach((n) => { try { n?.gain.setTargetAtTime(0, t, 0.02); } catch { /* ignore */ } });
      this.spatialRebuildTimer = setTimeout(() => { this.spatialRebuildTimer = null; this.buildSpatialBus(); }, 60);
    } else {
  
    this.buildSpatialBus();
    }
  }

  public getSpatialSetupId(): string {
    return this.spatialSetupId;
  }

  public getSpatialSetups(): SpatialSetup[] {
    return SPATIAL_SETUPS;
  }

  // ---------------------------------------------------------------------------
  // P2-3/D10: 2.1-Crossover für den Master-Ausgang.
  // DSP-Verarbeitung in `src/core/output/crossover.ts` (Linkwitz-Riley 2. Ordnung),
  // verifiziert durch `tests/crossover.test.ts`. Hier nur der Live-Graph-Umschalter.
  // ---------------------------------------------------------------------------
  /** Master-Ausgabemodus: 2.0 (Stereo) oder 2.1 (Sub getrennt, Xonar U7). */
  public stereoMode: '2.0' | '2.1' = '2.0';
  private master21: { splitter: any; merger: any; hpL: any; hpR: any; lpSub: any; sum: any } | null = null;

  public setStereoMode(mode: '2.0' | '2.1'): void {
    this.stereoMode = mode === '2.1' ? '2.1' : '2.0';
    this.applyMasterOutputRouting();
    // Phase 4: V2-Output-Graph synchron umschalten (falls V2-Sink aktiv/gewünscht).
    this.v2LiveSink.setOutputLayout(this.stereoMode === '2.1' ? '2.1' : 'stereo');
  }

  public getStereoMode(): '2.0' | '2.1' {
    return this.stereoMode;
  }

  /** Baut den 2.1-Master-Ausgang (best effort, live verifiziert auf Xonar U7).
   *  F3: outputGain ist der EINZIGE Ausgangsknoten – in 2.0 geht er auf die
   *  Destination, in 2.1 auf Splitter/Merger. Es gibt keinen zweiten Stereo-Pfad
   *  mehr, der den lokalen mainMonitorGain (davor) umgehen könnte. */
  private applyMasterOutputRouting(): void {
    if (!this.initialized || !this.ctx || typeof this.ctx.createChannelSplitter !== 'function' || !this.outputGain) return;
    try {
      const dest = this.ctx.destination as any;
      const supportsLfe = typeof dest.maxChannelCount === 'number' && dest.maxChannelCount >= 3;

      if (this.stereoMode === '2.0' || !supportsLfe) {
        // Stereo-/Phantom-Betrieb: exakt ein Pfad outputGain → destination.
        if (this.master21) {
          try { this.master21.merger?.disconnect?.(dest); } catch { /* ignore */ }
          try { this.master21.splitter?.disconnect?.(); } catch { /* ignore */ }
          this.master21 = null;
        }
        try { this.outputGain.disconnect(); } catch { /* ignore */ }
        try { this.outputGain.connect(dest); } catch { /* ignore */ }
        return;
      }

      if (this.master21) return; // bereits verdrahtet
      const splitter = this.ctx.createChannelSplitter(2);
      const merger = this.ctx.createChannelMerger(3);
      const hpL = this.ctx.createBiquadFilter();
      const hpR = this.ctx.createBiquadFilter();
      const lpSub = this.ctx.createBiquadFilter();
      const sum = this.ctx.createGain();
      const fc = 90;
      for (const f of [hpL, hpR]) {
        f.type = 'highpass';
        f.frequency.value = fc;
        f.Q.value = 0.7071;
      }
      lpSub.type = 'lowpass';
      lpSub.frequency.value = fc;
      lpSub.Q.value = 0.7071;
      sum.gain.value = 0.5;

      const wire = (from: any, to: any, outIdx = 0, inIdx = 0): void => {
        try { from?.connect?.(to, outIdx, inIdx); } catch { /* ignore */ }
      };
      // Alten Stereo-Pfad vollständig trennen, dann 2.1-Pfad aufbauen.
      try { this.outputGain.disconnect(); } catch { /* ignore */ }
      wire(this.outputGain, splitter);
      wire(splitter, hpL, 0);
      wire(splitter, hpR, 1);
      wire(splitter, sum, 0);
      wire(splitter, sum, 1);
      wire(sum, lpSub);
      wire(hpL, merger, 0, 0);
      wire(hpR, merger, 0, 1);
      wire(lpSub, merger, 0, 2);
      wire(merger, dest);
      this.master21 = { splitter, merger, hpL, hpR, lpSub, sum };
    } catch (err) {
      console.warn('2.1-Routing nicht verfügbar – Stereo-Fallback aktiv.', err);
    }
  }

  /**
   * ON_TOP: Stereo-Master bleibt am Ausgang, Spatial-Bus läuft zusätzlich.
   * SEPARATION: Stereo-Master wird vom Ausgang getrennt → nur noch der
   * N-Kanal-Spatial-Bus ist hörbar (echte Surround-Separation).
   */
  public setSpatialMode(mode: 'ON_TOP' | 'SEPARATION') {
    this.spatialMode = mode;
    if (!this.ctx) return;
    try {
      // De-Klick: Stereo-Master wird über den finalen Output-Gain weich ein-/
      // ausgeblendet statt hart vom Ziel getrennt. Kein disconnect() während
      // laufender Wiedergabe mehr nötig.
      const t = this.ctx.currentTime;
      if (this.outputGain) {
        this.outputGain.gain.cancelScheduledValues(t);
        this.outputGain.gain.setTargetAtTime(mode === 'SEPARATION' ? 0.0001 : 1, t, 0.02);
      }
    } catch { /* ignore */ }
  }

  public getSpatialMode(): 'ON_TOP' | 'SEPARATION' {
    return this.spatialMode;
  }

  /**
   * Erstellt den N-Kanal-WebAudio-Spatial-Bus (fail-safe):
   * - Stereo-Master (L/R) wird über einen ChannelSplitter(2) gewonnen.
   * - Jede Hauptachse L,R wird über N GainNode pro Himmelsrichtung gewichtet
   *   und in einen ChannelMerger(N) gespeist -> echter Surround-Ausgang.
   * - Für 2.0 wird ein simpler Stereo-Passthrough genutzt.
   */
  private buildSpatialBus() {
    if (!this.ctx || typeof this.ctx.createGain !== 'function') return;
    try {
      const setup = SPATIAL_SETUPS.find((s) => s.id === this.spatialSetupId) ?? SPATIAL_SETUPS.find((s) => s.id === '10.0') ?? SPATIAL_SETUPS[0];
      const total = setup.numChannels + setup.lfe;

      // Alte Nodes entsorgen.
      this.spatialGains.forEach((n) => { try { n?.disconnect(); } catch { /* ignore */ } });
      this.spatialMerger?.disconnect();

      if (setup.numChannels <= 2) {
        // 2.0 Stereo-Passthrough (kein Mehrkanal-Needs).
        this.spatialGains = [];
        this.spatialMerger = null;
        this.spatialEnabled = false;
        return;
      }

      const splitter = this.ctx.createChannelSplitter(2); // L, R
      const gains: (GainNode | null)[] = [];
      const merger = this.ctx.createChannelMerger(total);

      // Mono-Anteile des Stereo-Eingangs als Quellen für die Ring-Gewichte.
      // Jede GainNode bekommt als Input einen gewichteten Mix aus L und R mit
      // fester Baseline; die eigentliche Richtung steuern wir über die Gains.
      const sourceL = this.ctx.createGain();
      const sourceR = this.ctx.createGain();
      // Summe, damit jedes Kanal-Element einen kohärenten Mono-SA hat.
      const monoSource = this.ctx.createGain();
      // Mono = (L+R) für den Ring (vereinfachtes Downmix UHJ→Ring).
      for (let i = 0; i < total; i++) {
        const g = this.ctx.createGain();
        g.gain.value = 0;
        monoSource.connect(g);
        g.connect(merger, 0, i);
        gains.push(g);
      }
      splitter.connect(sourceL, 0);
      splitter.connect(sourceR, 1);
      sourceL.connect(monoSource);
      sourceR.connect(monoSource);

      this.spatialGains = gains;
      this.spatialMerger = merger;
      this.spatialEnabled = true;

      // Verbindung: Master-Signal in den Splitter einspeisen (Phase 9: V2-Tap
      // oder Master-Zustand; der hörbare Spatial-Pfad läuft über V2OutputGraph).
      const masterOut: any = this.masterStreamTap || this.masterVolume;
      try { masterOut.connect(splitter); } catch { /* ignore */ }

      // Merger-Ausgang an Destination (für echte Surround-Geräte/Devices).
      try { merger.connect(this.ctx.destination); } catch { /* ignore */ }
    } catch (e) {
      console.warn('Spatial-Bus nicht erstellt (fallback Stereo).', e);
      this.spatialEnabled = false;
      this.spatialGains = [];
    }
  }

  private lastSpatialChannels_: number[] = [];
}

export type AudioEngineApi = AudioEngine;

/**
 * Phase 7b: Transparente Terminal-/Plugin-Bridge als Proxy um die AudioEngine.
 * Bestehende Terminals können `audioEngine` oder `audioV2TerminalBridge`
 * importieren – beide laufen durch diesen Proxy. Im V2-Modus wird vor jedem
 * Methodenaufruf `syncV2FromV1()` ausgeführt, damit UI-Aktionen den V2-Graph
 * aktuell halten (zentrale Umstellung ohne Einzel-Rewrites).
 */
const NO_AUTO_SYNC = new Set(['setPlaybackMode', 'syncV2FromV1', 'dispose']);
function createV2TerminalProxy(engine: AudioEngine): AudioEngineApi {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const methodName = String(prop);
      return (...args: unknown[]) => {
        if (target.playbackMode === 'v2' && !NO_AUTO_SYNC.has(methodName)) {
          target.syncV2FromV1?.();
        }
        return (value as (...fnArgs: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as AudioEngineApi;
}

export const audioEngine = createV2TerminalProxy(new AudioEngine());

/** Phase 7: Zentrale Terminal-/Plugin-Bridge für den V2-Umstieg (Drop-in). */
export const audioV2TerminalBridge = audioEngine;

// Referenz-Worklets (itSynth/eq/mastering) für den graphbasierten Pfad registrieren.
registerReferenceWorkletSpecs(workletGraphRuntime);

// E2E-/Debug-Hook: erlaubt Playwright, den echten Live-Audio-Status zu prüfen
// (playbackMode, V2LiveSink-Verbindung, Transportzustand).
try {
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__audioMonastry = {
      audioEngine,
      audioV2TerminalBridge,
    };
  }
} catch {
  /* kein Browser-Kontext (Node-Tests) */
}
