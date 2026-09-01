import * as Tone from 'tone';
import { createSeededRandom, random } from './random';

import { TrackType, TRACK_ROLE_MAP, MUSIC_SCALES } from '../types';


import { calculateChannelPan, calculateHRTF, SPATIAL_SETUPS, SpatialSetup } from './spatialMath';
import { getPatch, INSTRUMENT_PATCHES, InstrumentPatch } from '../data/instrumentSynths';
import { DRUM_KITS, getDrumKit, getDrumSound, DrumSoundPreset } from '../data/drumKits';
import type {
  InstrumentDefinition, SynthDef, FmDef, DrumDef, FxDef,
} from '../core/instrument/types';
import { ClockSync } from './ClockSync';
import { PhaseLockedLoop } from './PhaseLockedLoop';
import { AudioGraphState, isAudioGraphState } from './audioGraphSerialization';
import { GraphStateBridge } from '../core/audio/GraphStateBridge';
import { workletGraphRuntime, type WorkletSpec, type WorkletChainResult } from '../core/audio/WorkletGraphRuntime';
import { registerReferenceWorkletSpecs } from '../core/audio/workletSpecs';
import { WebAudioWorkletBridge } from '../core/audio/backends/WebAudioWorkletBridge';
import { SpatialScene } from '../core/spatial/SpatialScene';
import { SourceExtractionPipeline, type AudioSourceInput } from '../core/spatial/SourceExtractionPipeline';
import { GraphEngineAdapter } from '../core/audio/compat/GraphEngineAdapter';
import { GraphPlaybackEngine } from '../core/audio/compat/GraphPlaybackEngine';
import { V2StudioGraph } from '../core/audio/V2StudioGraph';
import { validateRouting } from './routingValidator';
import { validatePreset } from './presetValidator';
import { OfflineBounceEngine, type BounceResult } from '../audio/bounce/OfflineBounceEngine';

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
 * UI-only-Plugins liefern ein leeres Array (kein eigener Audio-Graph).
 */
export function pluginAudioChannels(pluginId: string): TrackType[] {
  const map: Record<string, TrackType[]> = {
    masterplayer: [],
    ai: [],
    controller: [],
    library: [],
    mastering: [],
    stem: [],
    recording: [],
    performance: [],
    spatial: ['channel7'],
    mixer: ['channel1'],
    mcp: ['channel5'],
    drum: ['channel2'],
    sampler: ['channel5'],
    synthesizer: ['channel4'],
    instrument: ['channel4'],
    voice: ['channel8'],
    sound: ['channel5'],
    drop: ['channel5'],
    effect: ['channel6'],
    dsp: ['channel6'],
    eq: ['channel6'],
  };
  return map[pluginId] ?? [];
}

class AudioEngine {
  public initialized = false;
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

  public analyser!: Tone.Analyser;
  private ctx!: AudioContext;

  // P10: Mehrkanal-Spatial-Bus (2/4.0/6/8/10/12/14/16/18.x) via WebAudio.
  private spatialSetupId: string = '10.0';
  private spatialGains: (GainNode | null)[] = [];
  private spatialMerger: ChannelMergerNode | null = null;
  private spatialEnabled = false;
  // PDC: Der masteringProcessor hat 5 ms Lookahead-Latenz. Monitor-/Cue-Pfade
  // werden um denselben Betrag verzögert, damit Cue und Main-Mix phasenrichtig sind.
  private readonly PDC_MASTERING_LOOKAHEAD_SEC = 0.005;
  private pdcMonitorDelay: Tone.Delay | null = null;
  private spatialMode: 'ON_TOP' | 'SEPARATION' = 'ON_TOP';
  private masterToDestinationConnected = true;
  // Finaler Ausgangs-Gain (zwischen Analyzer und Destination) für de-klickte
  // Spatial-Mode-Wechsel (SEPARATION blendet den Stereo-Master weich aus).
  private outputGain: GainNode | null = null;
  private spatialRebuildTimer: ReturnType<typeof setTimeout> | null = null;

  // Synthesizers & FX Nodes
  private kickSynth!: Tone.MembraneSynth;
  private hatSynth!: Tone.MetalSynth;
  private clapSynth!: Tone.NoiseSynth;
  private clapFilter!: Tone.Filter;
  private bassSynth!: Tone.MonoSynth;
  private bassFilter!: Tone.Filter;
  private bassDelay!: Tone.FeedbackDelay;

  /**
   * Echte per-Kanal-Mischung: Jeder Track (channel1..8) hat eine eigene
   * Gain- und Pan-Stufe. Damit steuern die Mischpult-Fader tatsächlich die
   * Audiokette (statt nur nachbildende UI-Werte).
   */
  private channelGains: Partial<Record<TrackType, Tone.Volume>> = {};
  private channelPans: Partial<Record<TrackType, Tone.Panner>> = {};
  // #DJ: Pro-Kanal 3-Band-EQ (Low/Mid/High) für DJ-Mischpult-Regler.
  private channelEQs: Partial<Record<TrackType, { low: Tone.Filter; mid: Tone.Filter; high: Tone.Filter }>> = {};

  private samplePlayers: Record<string, Tone.Player> = {};
  /** Einzelner, wiederverwendeter Preview-Player (kein Leak bei schnellem Klicken). */
  private previewPlayer: Tone.Player | null = null;
  private trackSampleUrl: Record<TrackType, string | null> = {
    channel1: null, channel2: null, channel3: null, channel4: null,
    channel5: null, channel6: null, channel7: null, channel8: null
  };

  private masterMePreGain!: Tone.Volume;
  private masterMeHighpass!: Tone.Filter;
  private masterMeCompressor!: Tone.Compressor;
  private masterMeMultiband!: Tone.MultibandCompressor;
  private masterMeLimiter!: Tone.Limiter;

  private toneShiftEqBands: Tone.Filter[] = [];
  private toneShiftTilt!: Tone.Filter;

  private patterns: Record<TrackType, boolean[]> = {
    channel1: Array(16).fill(false), channel2: Array(16).fill(false),
    channel3: Array(16).fill(false), channel4: Array(16).fill(false),
    channel5: Array(16).fill(false), channel6: Array(16).fill(false),
    channel7: Array(16).fill(false), channel8: Array(16).fill(false)
  };
  private mutedStems: Record<TrackType, boolean> = {
    channel1: false, channel2: false, channel3: false, channel4: false,
    channel5: false, channel6: false, channel7: false, channel8: false
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
  private scheduleArea = 0.1; // seconds
  private nextNoteTime = 0.0;
  private timerID: any = null;

  private scheduleTick(time: number) {
    this.tick(time);
  }

  private scheduler() {
    if (!this.isPlaying) return;

    while (this.nextNoteTime < Tone.context.currentTime + this.scheduleArea) {
      this.scheduleTick(this.nextNoteTime);
      this.advanceNote();
    }
    this.timerID = setTimeout(() => this.scheduler(), this.lookahead);
  }


  // --- Task 2: Swing & Gate Parameter (einheitliches Sequencermodell) ---
  public swing = 0.0; // 0..1 – Shuffle-Anteil auf ungeraden 16teln
  public gate = 0.9;  // 0..1 – Gate-Länge relativ zur Step-Dauer

  /** P2-1: aktuelles Lookahead-Budget (8–15 ms adaptiv). */
  public getLookaheadMs(): number {
    return this.lookahead;
  }

  /** P2-1: Xrun/Underrun melden → Lookahead eine Stufe erhöhen (max 15 ms). */
  public reportXrun(): void {
    this.lookahead = Math.min(15, this.lookahead + 2);
  }

  /** NEW-MONK-8/P2-2: Swing systemweit setzen (Worklet-Clock + Scheduler). */
  public setSwing(swing: number): void {
    this.swing = Math.max(0, Math.min(1, swing));
    try {
      (this.clockNode?.parameters as any)?.get('swing')?.setValueAtTime(this.swing, this.ctx?.currentTime ?? 0);
    } catch { /* Clock-Worklet nicht aktiv */ }
  }
  // --- Task 2: optionaler AudioWorklet-Clock-Generator ---
  private clockNode: AudioWorkletNode | null = null;

  // --- Task 7: WASM/WAM-Synth-Worklet (Lead/Pads, PolyBLEP) ---
  private synthWorklet: AudioWorkletNode | null = null;

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
  private monitorGains: Record<string, Tone.Volume> = {};
  // Welche Spur (TrackType) hört welcher Monitor? (individuelle Cue-Mix-Matrix)
  private monitorTrackGain: Record<string, Record<string, number>> = {};


  constructor() {
    ['GLOBAL_MASTER', 'USER_1', 'USER_2', 'USER_3', 'USER_4', 'MON1', 'MON2', 'MON3', 'MON4'].forEach(bus => {
      this.masterBuses[bus] = new Tone.Volume(0);
    });
        // Cue-Mix-Matrix: jeder Monitor (1..4) hat pro Spur (channel1..8) einen Pegel 0..1.
    ['MON1', 'MON2', 'MON3', 'MON4'].forEach(mon => {
      this.monitorGains[mon] = new Tone.Volume(0);
      this.monitorTrackGain[mon] = {
        channel1: 1, channel2: 1, channel3: 1, channel4: 1,
        channel5: 1, channel6: 1, channel7: 1, channel8: 1,
      };
      // Voreinstellungen für Rollen (DJ/Producer/Engineer/Stem-Host)
      if (mon === 'MON2') { // Producer: weniger Hats, mehr Bass/Pads
        this.monitorTrackGain[mon].channel2 = 0.5;
        this.monitorTrackGain[mon].channel6 = 1.2;
      }
      if (mon === 'MON4') { // Stem-Host: viel Drums und Lead
        this.monitorTrackGain[mon].channel1 = 1.2;
        this.monitorTrackGain[mon].channel8 = 1.2;
      }
    });
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
    // Firefox-Robustheit: `instanceof AudioContext` schlägt in Firefox fehl,
    // weil Tone den Context in einem anderen Realm/Global erzeugt (constructor
    // name leer). Wir validieren per Duck-Typing: createGain + audioWorklet +
    // destination reichen aus, um Worklets zu registrieren.
    const looksLikeAudioContext = (c: unknown): c is AudioContext =>
      c != null &&
      typeof (c as any).createGain === 'function' &&
      typeof (c as any).audioWorklet?.addModule === 'function' &&
      typeof (c as any).destination === 'object';
    const validCtx = looksLikeAudioContext(rawCtx) ? (rawCtx as AudioContext) : null;

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
    // Ohne Handler plant der setTimeout-Scheduler in eine suspendierte Timeline
    // und erzeugt beim Resume Noten-Bursts/Phasenversatz.
    try {
      this.ctx.onstatechange = () => {
        const state = this.ctx?.state;
        if (state === 'suspended') {
          this.wasPlayingBeforeSuspend = this.isPlaying;
          if (this.isPlaying) {
            this.isPlaying = false;
            if (this.timerID) { clearTimeout(this.timerID); this.timerID = null; }
            try { Tone.Transport.pause(); } catch { /* ignore */ }
          }
        } else if (state === 'running' && this.wasPlayingBeforeSuspend) {
          this.wasPlayingBeforeSuspend = false;
          this.isPlaying = true;
          this.nextNoteTime = this.ctx.currentTime + 0.1;
          try { Tone.Transport.start(); } catch { /* ignore */ }
          if (!this.clockNode) this.scheduler();
        }
        this.onStateChange?.(state ?? 'closed');
      };
    } catch { /* kein onstatechange verfügbar */ }

    // Worklets robust erzeugen: Fehlt eine module-Registrierung (oder der
    // Context ist nicht nutzbar), liefert der Helfer einen neutralen Gain-Knoten
    // als Platzhalter, damit die Audio-Kette durchgängig bleibt (kein harter
    // Reject von init()).
    const makeWorklet = (
      name: string, opts?: AudioWorkletNodeOptions,
    ): AudioWorkletNode => {
      try {
        if (!this.ctx || typeof this.ctx.createGain !== 'function') {
          throw new Error('kein AudioContext');
        }
        return new AudioWorkletNode(this.ctx, name, opts);
      } catch (e) {
        console.warn(`AudioWorklet '${name}' nicht verfügbar – nutze neutralen Gain-Fallback.`, e);
        try {
          if (this.ctx && typeof this.ctx.createGain === 'function') {
            return this.ctx.createGain() as unknown as AudioWorkletNode;
          }
        } catch { /* kontextloses Silent */ }
        // Minimaler, never-connectbarer Stand-in damit der Rest nicht crasht.
        return null as unknown as AudioWorkletNode;
      }
    };

    this.dspNode = makeWorklet('dsp-processor');
    this.eqNode = makeWorklet('eq-processor');
    this.masteringNode = makeWorklet('mastering-processor');
    this.analyzerNode = makeWorklet('analyzer-processor');

    // SharedArrayBuffer ist ohne crossOriginIsolated (COOP/COEP-Header) in
    // Firefox NICHT definiert – nutze einen sicheren Fallback (ArrayBuffer),
    // damit init() nie an `ReferenceError: SharedArrayBuffer is not defined`
    // scheitert. Der BeatVisualizer fängt einen leeren Buffer ab.
    const sab = makeSafeArrayBuffer(128 * 4);
    this.sharedWaveformBuffer = new Float32Array(sab);
    try { this.analyzerNode.port.postMessage({ buffer: sab }); } catch { /* Gain-Fallback ohne Port */ }

    // Dropout-/Underrun-Telemetrie aus dem Audio-Thread (analyzerProcessor)
    // an den Main-Thread durchreichen. App/PerformanceMonitor meldet den
    // Zähler an /api/telemetry (P0 Architecture-Audit).
    // Guard: Wenn das Worklet nicht verfügbar ist (Gain-Fallback), existiert
    // kein MessagePort – dann gibt es auch keine Dropout-Telemetrie (kein Reject).
    if (this.analyzerNode && typeof this.analyzerNode.port?.postMessage === 'function') {
      try {
        this.analyzerNode.port.onmessage = (e: MessageEvent) => {
          const d = e.data as { type?: string; count?: number };
          if (d?.type === 'dropout' && typeof d.count === 'number') {
            this.dropoutCount = d.count;
            this.onDropout?.(d.count);
          }
        };
      } catch { /* Port nicht verfügbar – Dropout-Telemetrie entfällt */ }
    }

    this.lufsNode = makeWorklet('lufs-processor');
    const lufsSab = makeSafeArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.lufsBufferView = new Int32Array(lufsSab);
    try { this.lufsNode.port.postMessage({ buffer: lufsSab }); } catch { /* Gain-Fallback ohne Port */ }

    // Mastering Chain
    this.masterMePreGain = new Tone.Volume(0);
    this.masterMeHighpass = new Tone.Filter(20, 'highpass');
    this.masterMeCompressor = new Tone.Compressor({ threshold: -14, ratio: 4, attack: 0.005, release: 0.08, knee: 12 });
    this.masterMeMultiband = new Tone.MultibandCompressor({
      lowFrequency: 150, highFrequency: 3000,
      low: { threshold: -12, ratio: 4 }, mid: { threshold: -14, ratio: 3 }, high: { threshold: -16, ratio: 2 }
    });
    this.masterMeLimiter = new Tone.Limiter(-1);

    for (let i = 0; i < 12; i++) this.toneShiftEqBands.push(new Tone.Filter(1000, 'peaking'));
    this.toneShiftTilt = new Tone.Filter(1000, 'highshelf');

    this.masterVolume = new Tone.Volume(-6);
    this.masterBuses['GLOBAL_MASTER'].connect(this.masterVolume);

    // --- Task 4: Monitor/Cue-Busse (paralleler Cue-Mix vom GLOBAL_MASTER) ---
    // Jeder Monitor (MON1..MON4) erhält einen eigenen Volume-Knoten; dieser kann
    // später als separater Kopfhörer-/Cue-Ausgang (WebRTC-Session) genutzt werden.
    const monitorLimiter = new Tone.Limiter(-1); // entkoppelt + Clip-Schutz
    this.masterVolume.connect(monitorLimiter);
    // PDC: Monitor-Pfad um die Mastering-Lookahead-Latenz verzögern, damit Cue
    // und Main-Mix kohärent sind (kein Kammfilter beim parallelen Abhören).
    // Tone.Delay ist ein reines Wet-Delay (kein Dry-Anteil) – ideal als PDC.
    this.pdcMonitorDelay = new Tone.Delay(this.PDC_MASTERING_LOOKAHEAD_SEC, 0.1);
    monitorLimiter.connect(this.pdcMonitorDelay);
    const monitorFeed = (this.pdcMonitorDelay ?? monitorLimiter);
    ['MON1', 'MON2', 'MON3', 'MON4'].forEach(mon => {
      monitorFeed.connect(this.monitorGains[mon]);
    });

    
    this.masterVolume.connect(this.masterMePreGain);
    this.masterMePreGain.connect(this.masterMeHighpass);
    this.masterMeHighpass.connect(this.masterMeCompressor);
    this.masterMeCompressor.connect(this.masterMeMultiband);
    this.masterMeMultiband.connect(this.masterMeLimiter);

    let prevNode: any = this.masterMeLimiter;
    for (let i = 0; i < 12; i++) {
      prevNode.connect(this.toneShiftEqBands[i]);
      prevNode = this.toneShiftEqBands[i];
    }
    prevNode.connect(this.toneShiftTilt);

    // Worklet-Kette verbindet nur tatsächlich vorhandene Knoten. Ohne
    // AudioContext/Worklets (Silent-Modus, jsdom-Tests) bleibt die Kette
    // offen, statt mit `null.connect()` zu rejecten (Error-Recovery).
    const connectSafe = (from: unknown, to: unknown): void => {
      const f = from as { connect?: (n: unknown) => unknown } | null | undefined;
      const t = to as { connect?: (n: unknown) => unknown } | null | undefined;
      if (f && t && typeof f.connect === 'function') {
        try { f.connect(t); } catch { /* Worklet-Fallback – Kette bleibt offen */ }
      }
    };
    connectSafe(this.toneShiftTilt, this.eqNode);
    connectSafe(this.eqNode, this.masteringNode);
    connectSafe(this.masteringNode, this.dspNode);
    connectSafe(this.dspNode, this.lufsNode);
    connectSafe(this.lufsNode, this.analyzerNode);
    // Use raw destination for AudioWorkletNode – über einen finalen Gain,
    // damit Spatial-Mode-Wechsel (SEPARATION) weich ausgeblendet werden kann.
    if (this.ctx && typeof this.ctx.createGain === 'function') {
      this.outputGain = this.ctx.createGain();
      this.outputGain.gain.value = 1;
      connectSafe(this.analyzerNode, this.outputGain);
      connectSafe(this.outputGain, this.ctx.destination);
    } else {
      connectSafe(this.analyzerNode, this.ctx?.destination);
    }

    for(let i=0; i<12; i++) { this.toneShiftEqBands[i].gain.value = 0; }
    this.toneShiftTilt.gain.value = 0;

    this.analyser = new Tone.Analyser('waveform', 256);
    // PDC: Analyser NACH der Mastering-Kette abgreifen (sonst eilt die
    // Wellenform dem Main-Out um die Lookahead-Latenz voraus).
    // lufsNode ist nativ, Tone.Analyser.input ist ein Tone.Gain -> dessen
    // .input ist der native GainNode (Firefox-safe).
    // Analyser ist optional: ohne Worklet/Context kein Crash (Error-Recovery).
    if (this.lufsNode && this.analyser) {
      connectSafe(this.lufsNode, (this.analyser as any).input?.input ?? (this.analyser as any).input ?? this.analyser);
    }

    // Synth (jede Stimme über eigene Kanal-Gain/Pan für echtes Mischpult-Routing)
    this.ensureChannelNode('channel1'); // kick
    this.ensureChannelNode('channel2'); // hat
    this.ensureChannelNode('channel3'); // clap
    this.ensureChannelNode('channel7'); // bass
    this.channelGains.channel1!.volume.value = 0.8;
    this.channelGains.channel2!.volume.value = 0.6;
    this.channelGains.channel3!.volume.value = 0.7;
    this.channelGains.channel7!.volume.value = 0.8;

    this.kickSynth = new Tone.MembraneSynth({ octaves: 8, envelope: { attack: 0.005, decay: 0.1, sustain: 0.02, release: 0.3 } }).connect(this.channelGains.channel1!);
    this.hatSynth = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.1, sustain: 0.05, release: 0.05 }, harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5 }).connect(this.channelGains.channel2!);
    this.clapFilter = new Tone.Filter(1800, 'bandpass', -12).connect(this.channelGains.channel3!);
    this.clapSynth = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.2, sustain: 0.0, release: 0.05 }, volume: -10 }).connect(this.clapFilter);
    this.bassFilter = new Tone.Filter({ type: 'lowpass', frequency: 600, Q: 1.0 }).connect(this.channelGains.channel7!);
    this.bassDelay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.25, wet: 0.3 }).connect(this.bassFilter);
    this.bassSynth = new Tone.MonoSynth().connect(this.bassDelay);

    // --- P0-2: Synth-Worklets werden LAZY bei erster Plugin-Aktivierung erzeugt
    // (kein global verbundenes Synth-/Noise-Rauschen bei Start-Silence).
    // this.tryInitSynthWorklet();   → jetzt in ensureSynthGraph()
    // this.tryInitItSynthWorklet(); → jetzt in ensureSynthGraph()
    // Apply routing.json only now that all audio nodes exist.
    await this.applyRoutingConfig();

    // --- Task 2: optionaler präziser AudioWorklet-Clock-Generator ---
    this.initClockWorklet();

    this.buildSpatialBus();

    this.initialized = true;

    // Sicherstellen, dass beim ersten Start ein hörbarer Drum-Loop aktiv ist
    // (falls keine Patterns gesetzt wurden). So liefert "Play" sofort Musik,
    // ohne dass externe Sample-Dateien vorhanden sein müssen.
    this.ensureDemoPattern();
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
    (['channel1','channel2','channel3','channel4','channel5','channel6','channel7','channel8'] as TrackType[]).forEach((t) => {
      this.patterns[t] = this.normalizeSteps(this.patterns[t] ?? [], this.stepCount);
    });
    this.synthNotes = this.normalizeNotes(this.synthNotes, this.stepCount);
  }

  private normalizeSteps(steps: boolean[], count: number): boolean[] {
    if (steps.length === count) return [...steps];
    if (steps.length > count) return steps.slice(0, count);
    return [...steps, ...Array(count - steps.length).fill(false)];
  }

  private normalizeNotes(notes: number[], count: number): number[] {
    if (notes.length === count) return [...notes];
    if (notes.length > count) return notes.slice(0, count);
    return [...notes, ...Array(count - notes.length).fill(0)];
  }

  /** Schaltet den Sequencer zwischen 16 und 32 Steps um (Patterns werden gepolstert). */
  public setStepCount(count: 16 | 32): void {
    if (count !== 16 && count !== 32) return;
    this.stepCount = count;
    this.normalizeAllPatterns();
    this.currentStep = this.currentStep % count;
    this.emitStep(this.currentStep);
  }

  /** Globales Transport-Tempo setzen (clamped, z. B. für Sprach-/KI-Steuerung). */
  public setBpm(bpm: number): void {
    if (!Number.isFinite(bpm)) return;
    Tone.Transport.bpm.value = Math.max(30, Math.min(300, bpm));
  }

  /** Setzt einen einzelnen Drum-Step. */
  public setStep(track: TrackType, step: number, on: boolean): void {
    if (step < 0 || step >= this.stepCount) return;
    this.patterns[track][step] = on;
  }

  /** Setzt das Muster eines Kanals (16 oder 32 Steps). */
  public setPattern(track: TrackType, steps: boolean[]): void {
    if (!steps || (steps.length !== 16 && steps.length !== 32)) return;
    this.patterns[track] = this.normalizeSteps(steps, this.stepCount);
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
    ];
    for (const k of keys) {
      const arr = patterns?.[k];
      if (arr && Array.isArray(arr) && (arr.length === 16 || arr.length === 32)) {
        this.patterns[k] = this.normalizeSteps(arr, this.stepCount);
      }
    }
    if (synthNotes && Array.isArray(synthNotes) && (synthNotes.length === 16 || synthNotes.length === 32)) {
      this.synthNotes = this.normalizeNotes(synthNotes, this.stepCount);
    }
    if (bpm && Number.isFinite(bpm) && bpm > 20 && bpm < 300) {
      Tone.Transport.bpm.value = bpm;
    }
  }

  /** Erstellt den Clock-Worklet (falls geladen) als präzise Step-Quelle. */
  private async initClockWorklet() {
    try {
      this.clockNode = new AudioWorkletNode(this.ctx, 'clock-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 0,
        parameterData: { bpm: Tone.Transport.bpm.value, swing: this.swing, gate: this.gate },
      });
      // Clock-Worklet liefert 'step'-Impulse von der Audio-Clock (kein JS-Timer-Jitter).
      this.clockNode.port.onmessage = (e) => {
        const msg = e.data;
        if (!msg || msg.type !== 'step') return;
        this.tickAt(msg.time, msg.gate, msg.swing);
      };
    } catch (e) {
      // Clock-Worklet nicht verfügbar → Fallback auf bestehende setTimeout-Schleife.
      this.clockNode = null;
      console.warn('clock-processor not loaded; using setTimeout scheduler.', (e as Error).message);
    }
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
      if (routingConfig.tracks && Array.isArray(routingConfig.tracks)) {
        routingConfig.tracks.forEach(trackConfig => {
          if (trackConfig.params) {
            switch(trackConfig.instrument) {
              case "kickSynth": this.kickSynth.set(trackConfig.params); break;
              case "hatSynth": this.hatSynth.set(trackConfig.params); break;
              case "clapSynth": this.clapSynth.set(trackConfig.params); break;
              case "bassSynth": this.bassSynth.set(trackConfig.params); break;
            }
          }
        });
      }
    } catch (error) {
      console.error('Failed to load or parse routing.json:', error);
    }
  }


  public adjustLatency(oneWayLatency: number) {
      // lookAhead is a property on Tone.context, not Transport
      Tone.context.lookAhead = oneWayLatency / 1000 + 0.05;
  }

  public setWorkletParam(name: string, value: number) {
    this.ensureInitialized();
    if (!this.dspNode || typeof (this.dspNode as any).parameters?.get !== 'function') return;
    this.dspNode.parameters!.get(name)?.setValueAtTime(value, Tone.now());
  }

  /** Effekt-Engine (effectProcessor) steuern – Insert/Send. */
  private effectNode: AudioWorkletNode | null = null;
  public setEffectParam(p: { wet?: number; feedback?: number; rate?: number; depth?: number; bits?: number; sampleReduction?: number }) {
    this.ensureInitialized();
    if (!this.effectNode) {
      try {
        // Raw-Context-Fallback: setEffectParam kann vor Abschluss der async
        // init() aufgerufen werden (ensureInitialized wird nicht awaited).
        const rawCtx: any = (this.ctx && typeof (this.ctx as any).createGain === 'function')
          ? this.ctx
          : (Tone.context as any)?.rawContext;
        if (!rawCtx || typeof (rawCtx as any).createGain !== 'function') return;
        this.effectNode = new AudioWorkletNode(rawCtx, 'effect-processor', { numberOfInputs: 1, numberOfOutputs: 1 });
      } catch (e) {
        console.warn('[audioEngine] effect-worklet nicht verfügbar:', (e as Error).message);
        return;
      }
    }
    try { this.effectNode.port.postMessage({ ...p }); } catch { /* noop */ }
  }

  /** Sample-genaue Effekt-Parameter-Rampe (effectProcessor automate). */
  public automateEffect(param: 'wet' | 'feedback' | 'depth', value: number, rampTime = 0.05) {
    if (!this.effectNode) return;
    try { this.effectNode.port.postMessage({ type: 'automate', param, value, rampTime }); } catch { /* noop */ }
  }

  /** Sample-genaue DSP-Parameter-Rampe (dspProcessor automate). */
  public automateDsp(param: 'drive' | 'depth' | 'resonance' | 'phase', value: number, rampTime = 0.05) {
    try { this.dspNode?.port?.postMessage({ type: 'automate', param, value, rampTime }); } catch { /* noop */ }
  }

  /** Sample-genaue Mastering-Parameter-Rampe (masteringProcessor automate). */
  public automateMastering(param: 'threshold' | 'makeup' | 'ceiling', value: number, rampTime = 0.05) {
    try { this.masteringNode?.port?.postMessage({ type: 'automate', param, value, rampTime }); } catch { /* noop */ }
  }

  /** Block-genaue EQ-Band-Gain-Rampe (eqProcessor automate, Band 0-11). */
  public automateEqBandGain(band: number, gainDb: number, rampTime = 0.05) {
    try { this.eqNode?.port?.postMessage({ type: 'automate', param: 'bandGain', band, value: gainDb, rampTime }); } catch { /* noop */ }
  }

  /** Task 11: Mastering-Limiter/Kompression steuern (masteringProcessor). */
  public setMasteringParams(p: { threshold?: number; ratio?: number; knee?: number; attack?: number; release?: number; makeup?: number; ceiling?: number }) {
    this.ensureInitialized();
    try { this.masteringNode?.port?.postMessage({ ...p }); } catch { /* Gain-Fallback */ }
  }

  /** Task 10: DSP-Engine steuern (Phasenkorrektur, dynamisches Filter, Drive). */
  public setDspParam(p: { phase?: number; filterCutoff?: number; resonance?: number; depth?: number; drive?: number }) {
    this.ensureInitialized();
    try { this.dspNode?.port?.postMessage({ ...p }); } catch { /* Gain-Fallback */ }
  }

  /** Task 9: EQ-Band parametrisch setzen (eqProcessor). */
  public setEqBand(band: 'low'|'mid'|'high'|'hp', gain: number, freq?: number, q?: number) {
    this.ensureInitialized();
    try { this.eqNode?.port?.postMessage({ band, gain, freq, q }); } catch { /* Gain-Fallback */ }
  }

  /** Task 8: Glatte Fader-/Panner-Übergänge (Zipper-frei via setTargetAtTime). */
  public setMixChannelParam(target: 'gain'|'pan'|'monitor'|'master', value: number, rampSec = 0.02) {
    let node: { param: any; } | null = null;
    if (target === 'master') node = this.masterVolume ? { param: this.masterVolume.volume } : null;
    if (node && node.param) {
      node.param.setTargetAtTime(value, Tone.now(), rampSec);
    }
    // Für Channel-/Monitor-Wege geben wir den Wert zurück (UI-synergistisch).
    return value;
  }

  /**
   * Stellt den per-Kanal-Gain/Pan für einen Track bereit (zwischenspeichert
   * die Tone-Nodes und verdrahtet sie auf den GLOBAL_MASTER-Bus).
   * #DJ: zusätzlich 3-Band-EQ (Low-Shelf → Peaking Mid → High-Shelf) inline.
   */
  private ensureChannelNode(track: TrackType): void {
    if (!this.channelGains[track]) {
      const rawCtx = (this.ctx || (Tone.context as any)?.rawContext) as AudioContext;
      const g = new Tone.Volume(0);
      // Pro-Kanal-EQ nach dem Gain, vor dem Pan.
      const low = new Tone.Filter(220, 'lowshelf');
      const mid = new Tone.Filter(1000, 'peaking');
      const high = new Tone.Filter(4000, 'highshelf');
      low.gain.value = 0; mid.gain.value = 0; high.gain.value = 0;
      low.connect(mid); mid.connect(high);
      this.channelEQs[track] = { low, mid, high };
      // Tone.Panner statt nativem StereoPannerNode: Der native Konstruktor
      // verlangt in Firefox einen echten BaseAudioContext (Realm-Check) und
      // schlug mit 'does not implement BaseAudioContext' fehl.
      const p = new Tone.Panner(0);
      g.connect(low);        // Gain -> EQ
      high.connect(p);       // EQ -> Pan
      p.connect(this.masterBuses['GLOBAL_MASTER']);
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

  public setGranularParams(_params: { grainSize: number; density: number; position: number }) {
    // console.log("AudioEngine: Applying Granular Params", _params);
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

    try {
      if (kick && this.kickSynth) {
        this.kickSynth.set({
          pitchDecay: kick.pitchDecay ?? 0.05,
          octaves: kick.octaves ?? 8,
          envelope: { attack: 0.005, decay: kick.decay ?? 0.3, sustain: 0.02, release: 0.25 },
        });
      }
      if (hat && this.hatSynth) {
        this.hatSynth.set({
          harmonicity: hat.harmonicity ?? 5.1,
          modulationIndex: hat.modulationIndex ?? 32,
          resonance: hat.noiseFilter ?? 4000,
          envelope: { attack: 0.001, decay: hat.decay ?? 0.1, sustain: 0.05, release: 0.05 },
        });
      }
      if (clap) {
        if (this.clapFilter) this.clapFilter.frequency.value = clap.noiseFilter ?? 1800;
        this.clapSynth.set({
          envelope: { attack: 0.001, decay: clap.decay ?? 0.2, sustain: 0, release: 0.05 },
        });
      }
    } catch (e) {
      console.warn('Drum-Kit nicht vollständig anwendbar:', e);
    }
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

    // Reines WebAudio: AudioBufferSourceNode → Gain (Velocity) → GLOBAL_MASTER.
    const t = this.ctx.currentTime + 0.002;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = Math.max(0, Math.min(1.5, velocity));
    src.connect(g);
    const masterInput = (this.masterBuses['GLOBAL_MASTER'] as any)?.input;
    g.connect(masterInput || this.ctx.destination);
    src.start(t);
    src.stop(t + buffer.duration + 0.05);
    src.onended = () => {
      try { src.disconnect(); g.disconnect(); } catch { /* bereits getrennt */ }
    };
  }

  /** Rendert einen Drum-Sound über einen OfflineAudioContext in einen AudioBuffer. */
  private async renderDrumBuffer(sound: DrumSoundPreset): Promise<AudioBuffer | null> {
    const sr = this.ctx?.sampleRate || 48000;
    const dur = Math.max(0.08, Math.min(1.5, (sound.decay ?? 0.25) + 0.08));
    const frames = Math.max(64, Math.ceil(sr * dur));
    try {
      const off = new OfflineAudioContext(1, frames, sr);
      const out = off.createGain();
      out.gain.value = 1;
      out.connect(off.destination);
      this.buildDrumGraph(off, out, sound, sr, dur);
      return await off.startRendering();
    } catch (e) {
      console.warn('Offline-Drum-Render nicht verfügbar – Math-Fallback:', (e as Error).message);
      return this.renderDrumBufferMath(sound, sr, frames);
    }
  }

  /** Baut den nativen WebAudio-Graph eines Drum-Sounds (Offline-Render). */
  private buildDrumGraph(off: OfflineAudioContext, out: GainNode, sound: DrumSoundPreset, sr: number, dur: number) {
    const decay = Math.max(0.02, sound.decay ?? 0.25);

    switch (sound.type) {
      case 'kick':
      case 'tom': {
        const osc = off.createOscillator();
        osc.type = 'sine';
        const f0 = Math.max(20, sound.freqStart ?? (sound.freq ? sound.freq * 2.5 : 160));
        const f1 = Math.max(20, sound.freqEnd ?? sound.freq ?? 50);
        osc.frequency.setValueAtTime(f0, 0);
        osc.frequency.exponentialRampToValueAtTime(f1, Math.min(decay, dur * 0.8));
        const g = off.createGain();
        g.gain.setValueAtTime(1, 0);
        g.gain.exponentialRampToValueAtTime(0.001, decay);
        osc.connect(g); g.connect(out);
        osc.start(0); osc.stop(dur);
        break;
      }
      case 'hat': {
        const src = off.createBufferSource();
        src.buffer = this.makeNoiseBuffer(off, dur, sr);
        const bp = off.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = sound.noiseFilter ?? 8000;
        bp.Q.value = 1.2;
        const g = off.createGain();
        g.gain.setValueAtTime(1, 0);
        g.gain.exponentialRampToValueAtTime(0.001, decay);
        src.connect(bp); bp.connect(g); g.connect(out);
        src.start(0);
        break;
      }
      case 'snare':
      case 'clap': {
        // Noise-Anteil (bandpass-gefiltert)
        const nsrc = off.createBufferSource();
        nsrc.buffer = this.makeNoiseBuffer(off, dur, sr);
        const bp = off.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = sound.noiseFilter ?? 1800;
        bp.Q.value = 0.8;
        const ng = off.createGain();
        ng.gain.setValueAtTime(1, 0);
        ng.gain.exponentialRampToValueAtTime(0.001, decay);
        nsrc.connect(bp); bp.connect(ng); ng.connect(out);
        nsrc.start(0);
        // Ton-Anteil (Körper)
        const osc = off.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = sound.freq ?? 180;
        const og = off.createGain();
        og.gain.setValueAtTime(0.6, 0);
        og.gain.exponentialRampToValueAtTime(0.001, decay * 0.6);
        osc.connect(og); og.connect(out);
        osc.start(0); osc.stop(dur);
        break;
      }
      case 'perc':
      default: {
        if (sound.noise) {
          const src = off.createBufferSource();
          src.buffer = this.makeNoiseBuffer(off, dur, sr);
          const hp = off.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = Math.min(sound.noiseFilter ?? 5000, sr * 0.45);
          const g = off.createGain();
          g.gain.setValueAtTime(1, 0);
          g.gain.exponentialRampToValueAtTime(0.001, decay);
          src.connect(hp); hp.connect(g); g.connect(out);
          src.start(0);
        } else {
          const osc = off.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = sound.freq ?? 1000;
          const g = off.createGain();
          g.gain.setValueAtTime(1, 0);
          g.gain.exponentialRampToValueAtTime(0.001, decay);
          osc.connect(g); g.connect(out);
          osc.start(0); osc.stop(dur);
        }
      }
    }
  }

  /** Erzeugt einen weißen Rausch-AudioBuffer (für Noise-basierte Drums). */
  private makeNoiseBuffer(ctx: BaseAudioContext, seconds: number, sr: number): AudioBuffer {
    const len = Math.max(64, Math.ceil(sr * seconds));
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = this.noiseRandom() * 2 - 1;
    return buf;
  }

  /** Fallback: Drum-Sound rein mathematisch in einen AudioBuffer rendern. */
  private renderDrumBufferMath(sound: DrumSoundPreset, sr: number, frames: number): AudioBuffer | null {
    try {
      const buf = this.ctx.createBuffer(1, frames, sr);
      const d = buf.getChannelData(0);
      const decay = Math.max(0.02, sound.decay ?? 0.25);
      const env = (t: number, dec: number) => Math.exp((-t * 7) / dec);
      for (let i = 0; i < frames; i++) {
        const t = i / sr;
        let v = 0;
        switch (sound.type) {
          case 'kick':
          case 'tom': {
            const f0 = Math.max(20, sound.freqStart ?? (sound.freq ? sound.freq * 2.5 : 160));
            const f1 = Math.max(20, sound.freqEnd ?? sound.freq ?? 50);
            const r = f1 / f0;
            const sweep = Math.min(t / decay, 1);
            const phase = (2 * Math.PI * f0 * decay * (Math.pow(r, sweep) - 1)) / Math.log(r);
            v = Math.sin(phase) * env(t, decay);
            break;
          }
          case 'hat':
          case 'snare':
          case 'clap': {
            const n = this.noiseRandom() * 2 - 1;
            v = n * env(t, decay) + Math.sin(2 * Math.PI * (sound.freq ?? 180) * t) * env(t, decay) * 0.5;
            break;
          }
          default: {
            if (sound.noise) v = (this.noiseRandom() * 2 - 1) * env(t, decay);
            else v = Math.sin(2 * Math.PI * (sound.freq ?? 1000) * t) * env(t, decay);
          }
        }
        d[i] = v;
      }
      return buf;
    } catch (e) {
      console.warn('Math-Drum-Render fehlgeschlagen:', (e as Error).message);
      return null;
    }
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

    // --- Tone-Filter-Kette (12 Bänder) ebenfalls 1:1 setzen – Fallback
    // bzw. parallele Klangformung, falls der Worklet nicht aktiv ist. ---
    this.toneShiftEqBands.forEach((f, i) => {
      try {
        const b = bands[i];
        if (b) {
          const t = (b.type === 'lowshelf' || b.type === 'highshelf' || b.type === 'peaking') ? b.type : 'peaking';
          (f as any).type = t;
          f.frequency.value = b.freq;
          f.Q.value = b.q;
          f.gain.value = b.gain;
        } else {
          f.gain.value = 0;
        }
      } catch { /* ignore */ }
    });

    // Tilt-Shelf aus den Mastering-Presets übernehmen (falls vorhanden).
    const tilt = Number(params?.tilt_gain ?? 0);
    if (Number.isFinite(tilt)) {
      try { this.toneShiftTilt.gain.value = tilt; } catch { /* ignore */ }
    }
  }
  public updateMasterMe(params: any) {
    this.ensureInitialized();
    // console.log("Mastering Updated", params);

    // Apply smoothing
    if (params.input_gain !== undefined) {
        this.masterMePreGain.volume.rampTo(params.input_gain, 0.1);
    }
    // ... add more parameter smoothing as needed
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

  private tick(time: number) {
    const step = this.currentStep;

    // Trigger Synths (semantische Rollen aus dem Track-Role-Modell)
    //  channel1=kick, channel2=hat, channel3=clap, channel7=bass
    if (this.patterns.channel1[step] && !this.mutedStems.channel1 && TRACK_ROLE_MAP.channel1 === 'kick') {
      this.kickSynth.triggerAttackRelease('C1', '8n', time);
    }
    if (this.patterns.channel2[step] && !this.mutedStems.channel2 && TRACK_ROLE_MAP.channel2 === 'hat') {
      this.hatSynth.triggerAttackRelease('16n', time);
    }
    if (this.patterns.channel3[step] && !this.mutedStems.channel3 && TRACK_ROLE_MAP.channel3 === 'clap') {
      this.clapSynth.triggerAttackRelease('16n', time);
    }
    if (this.patterns.channel7[step] && !this.mutedStems.channel7 && TRACK_ROLE_MAP.channel7 === 'bass') {
      const note = MUSIC_SCALES[this.currentScaleName as keyof typeof MUSIC_SCALES]?.[this.synthNotes[step] % 8] || 'C2';
      this.bassSynth.triggerAttackRelease(note, '16n', time);
    }

    // Trigger Samplers (Lead-Spur channel8 kann auch über den Worklet-Synth laufen)
    (['channel4', 'channel5', 'channel6', 'channel8'] as TrackType[]).forEach(track => {
      if (this.patterns[track][step] && !this.mutedStems[track]) {
        if (this.samplePlayers[track]) {
          this.samplePlayers[track].start(time);
        } else if (track === 'channel8' && this.synthWorklet) {
          // Kein Sample auf Lead => PolyBLEP-Synth-Worklet als Stimme verwenden.
          const note = MUSIC_SCALES[this.currentScaleName as keyof typeof MUSIC_SCALES]?.[this.synthNotes[step] % 8] || 'C5';
          const freq = this.noteToFreq(note);
          this.synthWorklet.port.postMessage({ osc: 'saw', freq, trigger: 1, gain: 0.7 });
          this.synthWorklet.port.postMessage({ noteOff: true }); // kurze Gate-Emulation
        }
      }
    });

    this.currentStep = (this.currentStep + 1) % this.stepCount;
    this.emitStep(this.currentStep);
    this.onBeatCallback(this.currentStep);
  }

  /**
   * Task 2: Step-Trigger von der Audio-Clock (AudioWorklet) mit Swing & Gate.
   * Swing wird im Clock-Worklet vorberechnet; hier übernehmen wir nur den
   * exakten Audio-Zeitstempel und das Gate für die Note-Gesamtlänge.
   */
  private tickAt(time: number, gate: number, swing: number) {
    // Swing in diesem Frame abgezogen (der Clock-Worklet verschiebt ohnehin den Takt);
    // wir speichern Swing lediglich als Metadaten für EQ/DSP (synchrone Hinweise).
    this.swing = swing;
    this.gate = gate;

    // Task 20: PLL-Drift-Kompensation für jitterfreie Sync.
    // Die Worklet-Zeit ist die Audio-Referenz; Abweichung zur Transportzeit korrigieren.
    const transportNow = Tone.Transport.seconds;
    const drift = this.pll.update(time - transportNow);
    Tone.Transport.seconds += drift;

    // Schritt auf Basis der Audio-Clock ausführen (bestehende tick()-Logik nutzen).
    this.tick(time);
  }

  /** Swing-aware Step-Fortschritt für die Main-Thread-Lookahead-Schleife. */
  private advanceNote() {
    const secondsPerBeat = 60.0 / Tone.Transport.bpm.value;
    // 16 Steps = 16tel, 32 Steps = 32tel (Schrittlänge aus stepCount).
    const baseStep = (4 / this.stepCount) * secondsPerBeat;
    const isOdd = (this.currentStep % 2) === 1;
    // Swing: ungerade Steps werden um das Swing-Verhältnis des Step-Abstands verzögert.
    const swingOffset = isOdd ? baseStep * this.swing * 0.5 : 0;
    this.nextNoteTime += baseStep + swingOffset;
  }

  public triggerEvent(track: TrackType, velocity: number = 1.0) {
    if (this.playbackMode === 'v2') {
      this.graphPlayback.trigger(velocity);
      return;
    }
    if (!this.initialized) return;
    this.processEvent({ track, velocity }, Tone.now());
  }

  private processEvent(event: { track: TrackType; velocity: number }, time: number) {
    if (this.mutedStems[event.track]) return;

    // #DJ: Geladener Track gewinnt – der DJ-Mixer spielt auf einem belegten
    // Kanal die geladene Musik statt der synthetischen Rollen-Stimme
    // (kick/hat/clap/bass). Nur unbelegte Kanäle fallen auf Synth zurück.
    if (this.samplePlayers[event.track]) {
      this.samplePlayers[event.track].start(time);
      return;
    }

    switch (TRACK_ROLE_MAP[event.track]) {
      case 'kick': this.kickSynth.triggerAttackRelease('C1', '8n', time, event.velocity); break;
      case 'hat': this.hatSynth.triggerAttackRelease('16n', time, event.velocity); break;
      case 'clap': this.clapSynth.triggerAttackRelease('16n', time, event.velocity); break;
      case 'bass': {
        const noteM = MUSIC_SCALES[this.currentScaleName as keyof typeof MUSIC_SCALES]?.[0] || 'C2';
        this.bassSynth.triggerAttackRelease(noteM, '16n', time, event.velocity);
        break;
      }
      default:
        if (this.samplePlayers[event.track]) {
          this.samplePlayers[event.track].start(time);
        }
    }
  }

  // ------------------------------------------------------------------ //
  //  Task 4: Monitor/Cue-Mix-Steuerung (1..4 Personen)                //
  // ------------------------------------------------------------------ //
  /** Gesamtpegel eines Monitors (0..1, 0 = stumm). */
  public setMonitorGain(mon: 'MON1'|'MON2'|'MON3'|'MON4', gain: number) {
    const v = Math.max(0, Math.min(1, gain));
    if (this.monitorGains[mon]) {
      // Gain in dB relativ (0..1 Fader-Anteil) umrechnen: stumm bei 0, voll bei 0dB.
      this.monitorGains[mon].volume.rampTo(v <= 0 ? -Infinity : 20 * Math.log10(v), 0.05);
    }
  }

  /** Setzt den individuellen Spur-Pegel (0..2) eines Tracks in einem Monitor-Cue. */
  public setMonitorTrackGain(mon: 'MON1'|'MON2'|'MON3'|'MON4', track: TrackType, gain: number) {
    if (this.monitorTrackGain[mon]) this.monitorTrackGain[mon][track] = Math.max(0, Math.min(2, gain));
  }

  /** Liest den Track-Pegel eines Monitors aus (für UI-Darstellung). */
  public getMonitorTrackGain(mon: 'MON1'|'MON2'|'MON3'|'MON4'): Record<TrackType, number> {
    return this.monitorTrackGain[mon] ?? ({} as any);
  }

  /** Liefert die Monitor-Bus-Namen (gekürzt) als Konfig-Snapshot. */
  public getMonitorConfig() {
    return {
      count: this.monitorCount,
      gains: Object.fromEntries(Object.entries(this.monitorGains).map(([k, v]) => [k, v.volume.value])),
      tracks: Object.fromEntries(Object.entries(this.monitorTrackGain)),
    };
  }

  // ------------------------------------------------------------------ //
  //  Monitor-Quelle (pro User): MAIN | USER-MIX (MON1..MON4) | PLUGIN  //
  // ------------------------------------------------------------------ //
  private monitorSource: 'MAIN' | 'MON' | 'PLUGIN' = 'MAIN';
  private savedChannelGains: Partial<Record<TrackType, number>> = {};

  /** Liefert die aktuell gewählte Monitor-Quelle des lokalen Users. */
  public getMonitorSource(): 'MAIN' | 'MON' | 'PLUGIN' {
    return this.monitorSource;
  }

  /**
   * Wählt die Monitor-Quelle des lokalen Users:
   *  - 'MAIN'    -> fertige Master-Summe (Default)
   *  - 'MON'     -> eigener kompletter User-Mix (MON1..MON4, PDC-kompensiert)
   *  - 'PLUGIN'  -> MAIN-Summe, aber Solo des aktuell aktiven Plugin-Kanals
   */
  public setMonitorSource(
    mode: 'MAIN' | 'MON' | 'PLUGIN',
    mon: 'MON1' | 'MON2' | 'MON3' | 'MON4' = 'MON1',
    track?: TrackType,
  ): void {
    this.ensureInitialized();
    this.monitorSource = mode;

    // P0-6/D13: MAIN wird NIE vom Ausgang getrennt. MON/PLUGIN sind reine
    // Cue-Wege (per-User-Mix) und verändern ausschließlich die Cue-Matrix
    // `monitorTrackGain` – die Master-Kette bleibt unangetastet.
    const mix = this.monitorTrackGain[mon];
    if (!mix) return;

    const setMix = (t: TrackType, v: number) => {
      const m = mix[t];
      if (typeof m === 'number') mix[t] = v;
    };

    if (mode === 'PLUGIN' && track) {
      // Cue-Solo: nur der Ziel-Kanal ist im Cue hörbar (Main bleibt voll).
      (Object.keys(mix) as TrackType[]).forEach((t) => setMix(t, t === track ? 1 : 0));
    } else {
      // MAIN und MON folgen der vollen Mischung (Rollen-Mix bleibt erhalten).
      (Object.keys(mix) as TrackType[]).forEach((t) => setMix(t, 1));
    }
  }

  /** Wandelt einen MIDI-Noten-String (z. B. 'C5') in eine Frequenz um. */
  private noteToFreq(note: string): number {
    const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(note);
    if (!m) return 440;
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    let semitone = names.indexOf(m[1].toUpperCase() + m[2]) ;
    if (semitone < 0) return 440;
    const octave = Number.parseInt(m[3], 10);
    const midi = 12 + (octave + 1) * 12 + semitone; // C4=60
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** Erstellt den PolyBLEP-Synth-Worklet (falls geladen) und verdrahtet ihn. */
  private async tryInitSynthWorklet() {
    try {
      this.synthWorklet = new AudioWorkletNode(this.ctx, 'synth-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      // Verbinde den Worklet-Synth auf einen Lead-Bus (hier direkt auf Master mit eigener Lautstaerke)
      const leadGain = new Tone.Volume(-8);
      // @ts-ignore Tone-Node-Kompatibilitaet fuer Web-Audio-Worklet
      this.synthWorklet.connect(leadGain.input ? leadGain.input : this.ctx.destination);
      // @ts-ignore Tone-Node-Kompatibilitaet
      leadGain.connect(this.masterBuses['GLOBAL_MASTER']);
      console.info('synth-processor (PolyBLEP) aktiviert.');
    } catch (e) {
      this.synthWorklet = null;
      console.warn('synth-processor nicht geladen; Statistik-Fallback auf Sampler.', (e as Error).message);
    }
  }

  /** P0-2: Synth-Graph (PolyBLEP + it-synth) erst bei erster Aktivierung aufbauen. */
  public ensureSynthGraph(): Promise<void> {
    if (!this.synthGraphPromise) {
      this.synthGraphPromise = (async () => {
        await this.tryInitSynthWorklet();
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
    try {
      if (!this.ctx || typeof (this.ctx as any).audioWorklet?.addModule !== 'function') return;
      // Falls das Modul (noch) nicht über den Manifest-Pfad geladen wurde,
      // versuchen wir es nachzuladen; idempotent via registerProcessor-Check im Add.
      try {
        new AudioWorkletNode(this.ctx, 'it-synth-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      } catch {
        await (this.ctx as any).audioWorklet.addModule('/worklets/itSynthProcessor.js');
      }
      this.itSynthNode = new AudioWorkletNode(this.ctx, 'it-synth-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      // Stimmen-Status des Worklets an die UI spiegeln (Task 3).
      this.itSynthNode.port.onmessage = (e) => {
        const msg = e.data;
        if (msg?.type === 'states') {
          this.itSynthActiveVoices = Number(msg.active ?? 0);
          this.onItSynthStates(this.itSynthActiveVoices);
        }
      };
      const g = new Tone.Gain(1);
      (this.itSynthNode as any).connect(g);
      g.connect(this.masterBuses['GLOBAL_MASTER']);
      this.itSynthGain = g;
      this.itSynthReady = true;
      console.info('it-synth-processor (instrumentMONK, sample-genau) aktiviert.');
    } catch (e) {
      this.itSynthNode = null;
      this.itSynthReady = false;
      console.warn('it-synth-processor nicht verfügbar – instrumentMONK nutzt Tone.js-Fallback.', (e as Error).message);
    }
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

  /** Steuert den Worklet-Synth (Note-On / Parameter). */
  public noteOnWorklet(freq: number, velocity = 1, osc = 'saw') {
    if (!this.synthWorklet) return;
    this.synthWorklet.port.postMessage({ osc, freq, trigger: velocity, gain: velocity });
  }
  public noteOffWorklet() {
    this.synthWorklet?.port.postMessage({ noteOff: true });
  }

  public async play() {
    if (this.playbackMode === 'v2') {
      this.graphPlayback.start();
      return;
    }
    try {
      await this.init();
    } catch (e) {
      console.error('[audio] init fehlgeschlagen:', (e as Error).message);
      throw e;
    }
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.nextNoteTime = Tone.context.currentTime + 0.1;
    // Task 20: Wenn ein AudioWorklet-Clock-Generator läuft, ist er die primäre
    // Step-Quelle (jitterfrei). Die setTimeout-Lookahead-Schleife ist dann nur
    // ein redundanter Fallback und wird NICHT zusätzlich gestartet.
    if (!this.clockNode) {
      this.scheduler();
    }
    Tone.Transport.start();
  }

  public stop() {
    if (this.playbackMode === 'v2') {
      this.graphPlayback.stop();
      return;
    }
    this.isPlaying = false;
    if (this.timerID) {
        clearTimeout(this.timerID);
        this.timerID = null;
    }
    Tone.Transport.stop();
    this.currentStep = 0;
  }

  public dispose() {
    this.stop();

    // Fallback-Instrument + Preview-Player entsorgen (Leak-Schutz).
    this.disposeInstrumentSynth();
    try { this.previewPlayer?.dispose(); } catch { /* ignore */ }
    this.previewPlayer = null;

    // Dispose all synthesizers
    this.kickSynth?.dispose();
    this.hatSynth?.dispose();
    this.clapSynth?.dispose();
    this.clapFilter?.dispose();
    this.bassSynth?.dispose();
    this.bassFilter?.dispose();
    this.bassDelay?.dispose();

    // Dispose all sample players
    Object.values(this.samplePlayers).forEach(p => p.dispose());
    this.samplePlayers = {};
    this.trackSampleUrl = {
      channel1: null, channel2: null, channel3: null, channel4: null,
      channel5: null, channel6: null, channel7: null, channel8: null,
    };

    // Kanalzuege (Gain/EQ/Pan) und Monitor-Busse entsorgen.
    Object.values(this.channelGains).forEach((n) => { try { n?.dispose(); } catch { /* ignore */ } });
    Object.values(this.channelPans).forEach((n) => { try { n?.disconnect(); } catch { /* ignore */ } });
    Object.values(this.channelEQs).forEach((eq) => {
      try { eq.low.dispose(); eq.mid.dispose(); eq.high.dispose(); } catch { /* ignore */ }
    });
    this.channelGains = {};
    this.channelPans = {};
    this.channelEQs = {};
    Object.values(this.monitorGains).forEach((n) => { try { n?.dispose(); } catch { /* ignore */ } });
    this.monitorGains = {};

    // Spatial-Bus abräumen.
    if (this.spatialRebuildTimer) { clearTimeout(this.spatialRebuildTimer); this.spatialRebuildTimer = null; }
    this.spatialGains.forEach((n) => { try { n?.disconnect(); } catch { /* ignore */ } });
    try { this.spatialMerger?.disconnect(); } catch { /* ignore */ }
    this.spatialGains = [];
    this.spatialMerger = null;
    this.spatialEnabled = false;

    // Finaler Output-Gain abräumen.
    try { this.outputGain?.disconnect(); } catch { /* ignore */ }
    this.outputGain = null;

    // PDC-Delay abräumen.
    try { this.pdcMonitorDelay?.dispose(); } catch { /* ignore */ }
    this.pdcMonitorDelay = null;

    // Drum-Buffer-Cache freigeben.
    this.drumBufferCache.clear();
    this.drumBufferPromises.clear();

    // Dispose mastering chain
    this.masterMePreGain?.dispose();
    this.masterMeHighpass?.dispose();
    this.masterMeCompressor?.dispose();
    this.masterMeMultiband?.dispose();
    this.masterMeLimiter?.dispose();

    this.toneShiftEqBands.forEach(b => b.dispose());
    this.toneShiftEqBands = [];
    this.toneShiftTilt?.dispose();

    this.masterVolume?.dispose();
    Object.values(this.masterBuses).forEach(b => b.dispose());
    this.analyser?.dispose();

    // Worklets don't have a direct dispose() but they should be disconnected
    this.dspNode?.disconnect();
    this.eqNode?.disconnect();
    this.masteringNode?.disconnect();
    this.lufsNode?.disconnect();
    this.analyzerNode?.disconnect();
    // instrumentMONK-/Synth-/Clock-/Effekt-Worklets ebenfalls trennen.
    this.itSynthNode?.disconnect();
    this.synthWorklet?.disconnect();
    this.clockNode?.disconnect();
    this.effectNode?.disconnect();
    this.itSynthNode = null;
    this.synthWorklet = null;
    this.clockNode = null;
    this.effectNode = null;
    this.itSynthReady = false;

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
      if (!this.ctx || typeof this.ctx.createMediaStreamDestination !== 'function' || !this.masterVolume) return null;
      const dest = this.ctx.createMediaStreamDestination();
      this.masterVolume.connect(dest);
      return dest;
    } catch {
      return null;
    }
  }

  /** Trennt eine zuvor erzeugte Master-Stream-Destination sauber. */
  public disconnectMasterStreamDestination(dest: MediaStreamAudioDestinationNode): void {
    try {
      this.masterVolume?.disconnect(dest);
      dest.disconnect();
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

  /** V1→V2-Migrationsbrücke: hält Engine (V1) und AudioGraph (V2) synchron. */
  public graphAdapter = new GraphEngineAdapter({
    exportState: () => this.exportGraphState(),
    importState: (state) => this.importGraphState(state),
  });

  /** V2-Playback-Engine (voller Ersatzpfad für den V1-Transport). */
  public playbackMode: 'v1' | 'v2' = 'v1';
  public graphPlayback = new GraphPlaybackEngine((source, _ctx) =>
    this.buildWorkletChain(['it-synth', 'eq3', 'mastering'], source).output,
  );

  public setPlaybackMode(mode: 'v1' | 'v2'): void {
    this.playbackMode = mode;
    if (mode === 'v2') this.stop();
  }

  // NEW-D4-1: V2-StudioGraph (backend-unabhängiger 8-Kanal-Mischpfad).
  public v2Studio = new V2StudioGraph();

  /** Rendert einen V2-Block (128 Samples Stereo) durch den Graph. */
  public renderV2Block(): Float32Array[] | null {
    try {
      const sr = this.ctx?.sampleRate ?? 48000;
      return this.v2Studio.render({ sampleRate: sr, bufferSize: 128, quantum: 128 / sr, currentTime: Tone.now() });
    } catch {
      return null;
    }
  }

  /** V1-Zustand in den V2-Graph spiegeln (Hybrid-Betrieb, Meilenstein hörbar). */
  public syncV2FromV1(): void {
    (['channel1','channel2','channel3','channel4','channel5','channel6','channel7','channel8'] as TrackType[]).forEach((t) => {
      const db = this.channelGains[t]?.volume.value ?? 0;
      const pan = this.channelPans[t]?.pan.value ?? 0;
      this.v2Studio.setGainDb(t, db);
      this.v2Studio.setPan(t, pan);
    });
    this.v2Studio.setMasterGain(Math.pow(10, (this.masterVolume?.volume.value ?? -6) / 20));
  }

  /** Exportiert den kompletten hörbaren Zustand als JSON-fähiges Objekt. */
  public exportGraphState(): AudioGraphState {
    const gains: Record<string, number> = {};
    const pans: Record<string, number> = {};
    (['channel1','channel2','channel3','channel4','channel5','channel6','channel7','channel8'] as TrackType[]).forEach((t) => {
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
    const source = (this.itSynthNode ?? this.synthWorklet) as AudioNode | null;
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
      // Finaler Ausgangs-Gain -> Haupt-Master (Vor der FX) nutzen.
      vol.connect(this.masterBuses['GLOBAL_MASTER']);

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
    const master = this.masterBuses['GLOBAL_MASTER'];

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
          out.connect(master);
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
          out.connect(master);
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
            env.connect(master);
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
            env.connect(master);
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
          out.connect(master);
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
          out.connect(master);
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
    } else if (this.samplePlayers[track]) {
      this.samplePlayers[track].start(time);
    }
  }

  /** Einmalige Hörprobe eines synthetischen Samples (biblioMONK Play-Button). */
  public previewSynthesizedSample(params: { frequency?: number; decay?: number; pitchDecay?: number; oscillatorType?: string }): void {
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
      const bus = this.masterBuses['GLOBAL_MASTER'];
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

  public async loadTrackSample(track: TrackType, url: string | null) {
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
      // Gain -> 3-Band-EQ -> Pan -> GLOBAL_MASTER routen, damit die
      // Mischpult-Regler (Fader/EQ/Pan/Mute) tatsächlich auf geladene
      // Tracks wirken – vorher ging der Player direkt auf den Master.
      this.ensureChannelNode(track);
      const player = new Tone.Player(url).connect(this.channelGains[track]!);
      // player.autostart = true; // Or player.start() when needed
      this.samplePlayers[track] = player;
      this.trackSampleUrl[track] = url;
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

    // HRTF-basiertes Stereo-Cue (Kopfhörer/Engineer).
    const stereoPan = Math.max(-1, Math.min(1, (hrtf.azimuth || 0) / 90));
    const channelStr = track.replace('channel', '');
    this.setWorkletParam(`ch${channelStr}_volume`, -hrtf.ildDb);
    this.setMixChannelParam('pan', stereoPan, 0.03);

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
      } else if (mode === 'SEPARATION' && this.masterToDestinationConnected) {
        this.analyzerNode.disconnect(this.ctx.destination);
        this.masterToDestinationConnected = false;
      } else if (mode === 'ON_TOP' && !this.masterToDestinationConnected) {
        this.analyzerNode.connect(this.ctx.destination);
        this.masterToDestinationConnected = true;
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

      // Verbindung: Master-Signal in den Splitter einspeisen.
      const masterOut: any = this.masterMeLimiter || this.masterVolume || this.analyzerNode;
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

export const audioEngine = new AudioEngine();

// Referenz-Worklets (itSynth/eq/mastering) für den graphbasierten Pfad registrieren.
registerReferenceWorkletSpecs(workletGraphRuntime);
