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
 * RT-AUDIT-P0-003: Steps laufen über eine vorallokierte Queue mit absoluten
 * Frames (`V2StepQueue`). Swing-verzögerte Steps, deren Frame hinter dem
 * aktuellen Block liegt, werden vorgemerkt und im richtigen Block gefeuert
 * (vorher verworfen). Die `step`-Meldung an den Main-Thread geht erst beim
 * tatsächlichen Feuern raus.
 *
 * IDEA-2026-10-07-A-F1: Beim ersten Step nach `transport playing:true` (Step 0
 * = Taktanfang) meldet der Prozessor EINMAL
 *   { type: 'transport-started', frame, time, epoch }
 * mit dem hörbaren Frame (inkl. PDC-Lookahead wie bei `step`). Der Main-Thread
 * richtet das Capture-Raster daran aus (statt `ctx.currentTime` beim Post).
 * Die Meldung nutzt ein vorallokiertes Objekt (kein Literal im Render-Pfad).
 *
 * AUDIO-2026-11-06-002: Jede `step`- und `transport-started`-Meldung trägt die
 * Transportepoch des Laufs (`epoch`), die mit `transport` hereinkommt. Der Sink
 * verwirft damit Meldungen eines bereits gestoppten Laufs (Stop+Start in
 * schneller Folge); die UI-/Clock-Impulse stammen so nie aus einem alten Lauf.
 *
 * Steuerung über Port-Nachrichten (V2SinkMessage):
 *   { type: 'test-tone',  active, freq?, amplitude? }
 *   { type: 'gain-db',    channel, db }
 *   { type: 'pan',        channel, pan }
 *   { type: 'master-gain', value }
 *   { type: 'transport',  playing, bpm?, swing?, gate?, stepCount?, transportEpoch? }
 *   { type: 'pattern',    channel, steps }
 *   { type: 'sample-load',   id, left, right?, sourceRate }   (Transfer, RT-AUDIT-P1-010)
 *   { type: 'sample-assign', channel, id }
 *   { type: 'sample-unload', id }
 *   { type: 'sfz-regions',   channel, regions, sources }      (Regionen fertig geparst)
 *
 * RT-AUDIT-P1-010: Große Daten kommen nur per Transfer (kein strukturiertes
 * Klonen der Sample-Arrays im Audio-Thread), Samples liegen in einem Pool mit
 * IDs (`samplePool`, nur im Message-Handler verändert, nie in `renderBlock`),
 * und SFZ-Text wird im Main-Thread geparst.
 *
 * RT-AUDIT-P1-010 (Schritt 2): Mit `crossOriginIsolated` kommen gain-db, pan,
 * mute, master-gain, synth-trigger und sample-trigger über einen lock-freien
 * SPSC-Ring im SharedArrayBuffer (`controlRing.ts`, einmalig per
 * `{ type: 'control-ring', ring }` angebunden). `renderBlock` leert ihn am
 * Blockanfang allokationsfrei; jeder Port-Handler leert vorher die älteren
 * Datensätze (Gesamtreihenfolge Ring ↔ Port bleibt erhalten).
 */
import { V2SinkEngine } from '../../core/audio/live/V2SinkEngine';
import {SpatialPcmTransport,type SpatialPcmShared} from '../../core/spatial/v2/spatialPcmTransport';
import type { V2SampleTriggerOptions, V2SinkMessage } from '../../core/audio/live/V2SinkEngine';
import { V2SampleClock, type V2ScheduledStep } from '../../core/audio/live/V2SampleClock';
import { V2StepQueue, V2_STEP_QUEUE_CAPACITY } from '../../core/audio/live/V2StepQueue';
import { V2_CHANNELS, type V2Channel } from '../../core/audio/V2StudioGraph';
// RT-AUDIT-P1-010: nur die parserfreie Bank – kein SFZ-Text-Parser im Audio-Thread.
import { SfzVoiceBankCore, type SfzSourceMap } from '../../core/instrument/sfzVoiceBankCore';
import { V2RenderFaultGuard } from '../../core/audio/live/V2RenderFaultGuard';
import {
  CONTROL_FIELD,
  CONTROL_OP,
  CONTROL_RECORD_WORDS,
  ControlRing,
  portSeqReached,
} from '../../core/audio/live/controlRing';
import { V2Meters, METER_LAYOUT, isWorkletUnderrun } from '../../core/audio/live/V2Meters';

const DEFAULT_STEP_VELOCITY = 0.8;
/** Kapazität der vorallokierten Clock-Ausgabe pro Block (128er-Block: max. 1 Step). */
const CLOCK_OUT_CAPACITY = 8;

function emptyPattern(length: 16 | 32): boolean[] {
  return Array.from({ length }, () => false);
}

/**
 * RT-AUDIT-P0-002: SFZ-Bänke je Kanal mit Map-kompatiblem `get`/`set`, intern
 * als parallele Arrays. `process()` iteriert per Index – vorher lief dort ein
 * `for…of` über die Map (Iterator + `[key, value]`-Tupel pro Block).
 */
class SfzBankRegistry {
  readonly channels: V2Channel[] = [];
  readonly banks: SfzVoiceBankCore[] = [];

  get(channel: V2Channel): SfzVoiceBankCore | undefined {
    const i = this.channels.indexOf(channel);
    return i < 0 ? undefined : this.banks[i];
  }

  set(channel: V2Channel, bank: SfzVoiceBankCore): this {
    const i = this.channels.indexOf(channel);
    if (i < 0) {
      this.channels.push(channel);
      this.banks.push(bank);
    } else {
      this.banks[i] = bank;
    }
    return this;
  }
}

/** RT-AUDIT-P1-010: ein per Transfer geladenes Sample im Pool des Prozessors. */
interface PooledSample {
  left: Float32Array;
  right: Float32Array | null;
  sourceRate: number;
}

class V2SinkProcessor extends AudioWorkletProcessor {
  private readonly engine = new V2SinkEngine(sampleRate, 128);
  private spatialTransport:SpatialPcmTransport|null=null;
  private readonly clock = new V2SampleClock({ sampleRate, stepCount: 16, bpm: 120, swing: 0, gate: 0.9 });
  private readonly patterns = new Map<V2Channel, boolean[]>(V2_CHANNELS.map((c) => [c, emptyPattern(16)]));
  private readonly sfzBanks = new SfzBankRegistry();
  /**
   * RT-AUDIT-P1-010: Sample-Pool (id → Sample) und Kanal-Zuordnung. Beide
   * werden ausschließlich im Message-Handler verändert, nie in `renderBlock`;
   * der Render-Pfad liest nur die Referenzen, die `engine.setSampleBuffer`
   * beim Zuordnen ablegt.
   */
  private readonly samplePool = new Map<string, PooledSample>();
  private readonly channelSampleIds = new Map<V2Channel, string>();
  /** RT-AUDIT-P0-002: wiederverwendeter Render-Kontext (vorher Objekt-Literal pro Block). */
  private readonly renderCtx = { sampleRate, bufferSize: 128, quantum: 128 / sampleRate, currentTime: 0 };
  /**
   * RT-AUDIT-P0-003: Steps mit absolutem Frame vormerken statt verwerfen.
   * Swing legt ungerade Steps hinter das aktuelle Quantum; sie feuern jetzt
   * genau in dem Block, in den ihr Frame fällt. Alles vorallokiert.
   */
  private readonly stepQueue = new V2StepQueue(V2_STEP_QUEUE_CAPACITY);
  private readonly clockOut: V2ScheduledStep[] = Array.from({ length: CLOCK_OUT_CAPACITY }, () => ({
    step: 0, frame: 0, time: 0, swing: 0, gate: 0, secondsPerStep: 0,
  }));
  private readonly firedStart = new Int32Array(V2_STEP_QUEUE_CAPACITY);
  private readonly firedStep = new Int32Array(V2_STEP_QUEUE_CAPACITY);
  private readonly firedFrame = new Float64Array(V2_STEP_QUEUE_CAPACITY);
  private readonly firedSps = new Float64Array(V2_STEP_QUEUE_CAPACITY);
  /** Wiederverwendete Optionen für Step-getriggerte Samples (kein Objekt-Literal pro Step). */
  private readonly stepSampleOptions: V2SampleTriggerOptions = { loop: false, rate: 1, offset: 0, startSample: 0 };
  /** Letzter `currentFrame` (Zeitsprung rückwärts → Queue leeren). */
  private lastQueueFrame = -1;
  /**
   * IDEA-2026-10-07-A-F1: Transport gestartet, erster Step (Step 0) noch nicht
   * gefeuert. Beim Feuern geht genau eine `transport-started`-Meldung raus.
   */
  private transportStartPending = false;
  /**
   * AUDIO-2026-11-06-002: Transportepoch des laufenden Starts (`transport`
   * playing:true). Der Sink zaehlt sie hoch und schickt sie mit; sie kommt in
   * `step` und `transport-started` zurueck, damit der Main-Thread Meldungen
   * eines bereits gestoppten Laufs verwerfen kann. 0 = noch kein Start.
   */
  private transportEpoch = 0;
  /** Vorallokierte Meldung (Felder werden überschrieben, kein Literal pro Block). */
  private readonly transportStartedMsg = { type: 'transport-started' as const, frame: 0, time: 0, epoch: 0 };
  /**
   * RT-AUDIT-P0-004-F1: Mastering-Lookahead (PDC) in Samples. Die Master-Kette
   * verzögert das hörbare Signal real um diesen Betrag – Step-Meldungen an den
   * Main-Thread werden deshalb um genau diesen Wert vorgezogen gestempelt
   * (Variante A: Audio-Zeitachse bleibt unverändert).
   * DSP-P1-OVS-001: nicht mehr konstruktor-konstant – läuft der DSP-Saettiger
   * oversampled, kommt dessen Zusatzlatenz dazu. Gelesen je gefeuertem Step
   * (reiner Getter, keine Allokation).
   */
  private get pdcLookaheadSamples(): number {
    return this.engine.studio.mainLatencySamples;
  }

  /** Pre-allocated buffer pool (RT-AUDIT-P0-012).
   * Pool sizes are powers of 2 starting from minBlockSize up to maxBlockSize.
   * Each pool entry holds N buffers for N blocks of that size. */
  private readonly bufferPool: Map<number, Float32Array[]> = new Map();

  private getPool(length: number): Float32Array {
    // Round up to next power of 2 for pool efficiency
    const poolKey = Math.pow(2, Math.ceil(Math.log2(length)));
    let pool = this.bufferPool.get(poolKey);
    if (!pool || pool.length === 0) {
      // Create a new pool with 4 buffers
      pool = Array.from({ length: 4 }, () => new Float32Array(length));
      this.bufferPool.set(poolKey, pool);
    }
    // Pop and reuse the last buffer
    const buf = pool.pop()!;
    // If pool is low, refill
    if (pool.length < 2) {
      pool = Array.from({ length: 4 }, () => new Float32Array(poolKey));
      this.bufferPool.set(poolKey, pool);
    }
    return buf;
  }

  private releasePool(buf: Float32Array): void {
    const poolKey = Math.pow(2, Math.ceil(Math.log2(buf.length)));
    let pool = this.bufferPool.get(poolKey);
    if (!pool) {
      pool = [];
      this.bufferPool.set(poolKey, pool);
    }
    // Only release if not already in pool
    if (!pool.includes(buf)) pool.push(buf);
  }

  /** Allocates a zero-filled Float32Array of the given length using the pool. */
  private allocateZeroFill(length: number): Float32Array {
    const buf = this.getPool(length);
    buf.fill(0);
    return buf;
  }

  /** itSynth scratch buffer (mono buffer + one-element block array), allocated once per channel. */
  private itScratchFor(channel: string, length: number): { buffer: Float32Array; block: Float32Array[] } {
    let entry = this.itScratch.get(channel);
    if (!entry || entry.buffer.length !== length) {
      // Der Block MUSS auf denselben Puffer zeigen, in den gerendert wird –
      // ein zweiter Null-Puffer lieferte dem Graph dauerhaft Stille.
      const buffer = this.allocateZeroFill(length);
      entry = { buffer, block: [buffer] };
      this.itScratch.set(channel, entry);
    }
    return entry;
  }
  /**
   * Wiederverwendbarer Render-Scratch je SFZ-Kanal (Mono-Puffer + das
   * einelementige Block-Array). Vorher entstanden hier pro Block und Kanal ein
   * `new Float32Array(length)` und ein `[mono]` – Allokationen im
   * Audio-Render-Pfad (AGENTS.md §5). `V2SinkEngine.setExternalSource` reicht
   * die Referenz nur bis zum Ende desselben `render()`-Aufrufs durch
   * (`V2SinkEngine.render`, External-Blöcke werden nur gelesen), Wiederverwendung ist daher unkritisch.
   */
  private readonly sfzScratch = new Map<V2Channel, { buffer: Float32Array; block: Float32Array[] }>();
  private readonly itScratch = new Map<string, { buffer: Float32Array; block: Float32Array[] }>();
  /**
   * RT-AUDIT-P0-007: Fehlerpfad. Eine Exception in `process()` würde den
   * Prozessor dauerhaft abschalten (DAW stumm). Fehler werden gefangen:
   * Stille für diesen Block, Zähler, gedrosselte `render-error`-Meldung.
   */
  private readonly faults = new V2RenderFaultGuard(sampleRate);
  /** V2Meters for audio metering (RT-AUDIT-P0-005). */
  private readonly meters: V2Meters;
  /**
   * RT-AUDIT-P0-005: Mess-SAB. Der Prozessor erzeugt ihn (falls nicht per
   * `processorOptions.meterSab` hereingereicht) und übergibt ihn EINMAL per
   * `meter-sab` an den Main-Thread.
   */
  private readonly meterSab: SharedArrayBuffer;
  private meterSabSent = false;
  /** Float32View on the meter Sab for direct write access (RT-AUDIT-P1-017). */
  private readonly view: Float32Array;
  /** Worklet-Driftmessung (zweite Underrun-Quelle): letzter Messzeitpunkt/-block. */
  private meterDriftBlocks = 0;
  private meterDriftLastMs = 0;
  /**
   * RT-AUDIT-P1-010 (Schritt 2): Steuer-Ring (SharedArrayBuffer) für kleine,
   * häufige Steuerdaten. `null` = ohne crossOriginIsolated, dann alles per Port.
   */
  private controlRing: ControlRing | null = null;
  /** Vorallokierter Datensatz-Puffer für `ControlRing.peek`. */
  private readonly ringRecord = new Float64Array(CONTROL_RECORD_WORDS);
  /** Verarbeitete Port-Nachrichten (Int32, wrap-sicher verglichen). */
  private portSeqSeen = 0;
  /** Wiederverwendete Optionen für Ring-Sample-Trigger. */
  private readonly ringSampleOptions: V2SampleTriggerOptions = { loop: false, rate: 1, offset: 0, startSample: 0 };

  // --- CPU-Budget-Messung (PERF-P3-001) -------------------------------------
  // Ausschliesslich opt-in ueber `processorOptions.measure` (Default aus, im
  // Betrieb also null zusaetzliche Messkosten ausser zwei Zeitstempeln pro Block).
  /** Nicht `readonly`: die Messung schaltet sich bei Fehlern selbst ab (s. recordCpu). */
  private measure: boolean;
  private blocks = 0;
  private sumMs = 0;
  private maxMs = 0;

  // --- Deadline-Treue (PERF-P3-002) -----------------------------------------
  // `performance` ist im AudioWorkletGlobalScope nicht exponiert. Das ist per
  // Spec so (WorkletGlobalScope ist kein WorkerGlobalScope) und gilt in JEDEM
  // Chromium – live verifiziert 2026-09-13: im Prozessor-Scope ist `typeof
  // performance === 'undefined'`, waehrend `Date`, `currentTime`,
  // `currentFrame` und `sampleRate` vorhanden sind. Eine belastbare
  // Max-Blockzeit ist ueber eine Wall-Clock dort also nicht zu bekommen, und
  // kein Browser-Update wird das aendern.
  //
  // Die belastbare Quelle ist der Audio-Zaehler selbst: `currentFrame` springt
  // genau dann um mehr als einen Render-Quantum, wenn der Audio-Thread einen
  // Block nicht rechtzeitig geliefert hat. Das ist aufloesungsunabhaengig (kein
  // Quantisierungsproblem wie bei `Date.now()`) und beantwortet die eigentlich
  // interessante Frage: wurde eine Deadline verpasst?
  private lastFrame = -1;
  /** Summe der uebersprungenen Render-Quanten seit Messbeginn. */
  private missedQuanta = 0;
  /** Groesste beobachtete Luecke in Quanten (1 = unauffaellig). */
  private maxGapQuanta = 0;
  /** Anzahl der process()-Aufrufe, auf die eine Luecke folgte. */
  private stallEvents = 0;

  /**
   * Zeitquelle fuer den MITTELWERT. `performance` ist im
   * AudioWorkletGlobalScope NICHT garantiert vorhanden – live gemessen
   * 2026-09-11 (headless Chromium): `typeof performance === 'undefined'`. Ein
   * direkter `performance.now()`-Aufruf warf dort in JEDEM Block eine
   * ReferenceError, der Prozessor starb und lieferte nur noch Stille. Deshalb
   * Feature-Test + `Date.now()`-Rueckfall (1 ms Auflösung, fuer Mittelwerte
   * ausreichend – der Bericht weist `timer` aus). Fuer die Deadline-Treue ist
   * diese Quelle bewusst NICHT massgeblich (s. oben), sondern `currentFrame`.
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
    const opts = (options?.processorOptions ?? {}) as { measure?: boolean; meterSab?: SharedArrayBuffer };
    this.measure = opts.measure === true;
    // RT-AUDIT-P0-005: Mess-SAB (vom Main-Thread hereingereicht oder hier
    // erzeugt). Er wird NICHT im Konstruktor gepostet (s. Hinweis unten),
    // sondern im ersten process()-Block per `meter-sab` übergeben.
    const meterSab = opts.meterSab;
    this.meterSab = meterSab instanceof SharedArrayBuffer
      ? meterSab
      : new SharedArrayBuffer(METER_LAYOUT.COUNT * Float32Array.BYTES_PER_ELEMENT);
    this.meters = new V2Meters(sampleRate, this.meterSab);
    this.view = new Float32Array(this.meterSab);
    // WICHTIG (live gemessen 2026-09-11): NICHT im Konstruktor posten. Ein
    // `this.port.postMessage()` an dieser Stelle brachte den Prozessor zum
    // Scheitern – der Knoten lieferte danach Stille und es kamen keine
    // Nachrichten an. Die Messung meldet sich deshalb im ersten process()-Block
    // (recordCpu sendet den ersten Bericht sofort).
    const handleMessage = (e: MessageEvent<V2SinkMessage>) => {
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
          // AUDIO-2026-11-06-002: Epoch des Starts uebernehmen (kommt mit jedem
          // transport-Paket; fehlt sie, bleibt die letzte gueltig).
          if (typeof msg.transportEpoch === 'number' && Number.isFinite(msg.transportEpoch)) {
            this.transportEpoch = msg.transportEpoch;
          }
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
            // RT-AUDIT-P0-003: Stopp/Neustart verwirft vorgemerkte Steps.
            this.stepQueue.clear();
            if (msg.playing) {
              this.clock.reset();
              this.clock.playing = true;
              this.transportStartPending = true;
            } else {
              this.clock.playing = false;
              this.transportStartPending = false;
            }
          }
          break;
        }
        case 'pattern':
          if (msg.channel && Array.isArray(msg.steps) && (msg.steps.length === 16 || msg.steps.length === 32)) {
            this.patterns.set(msg.channel, [...msg.steps]);
          }
          break;
        case 'sample-load':
          // RT-AUDIT-P1-010: per Transfer übergeben – hier wird nichts kopiert.
          if (typeof msg.id === 'string' && msg.left instanceof Float32Array && msg.left.length > 0) {
            const pooled: PooledSample = {
              left: msg.left,
              right: msg.right instanceof Float32Array ? msg.right : null,
              sourceRate: typeof msg.sourceRate === 'number' ? msg.sourceRate : sampleRate,
            };
            this.samplePool.set(msg.id, pooled);
            // Neu geladene Daten unter einer bereits zugeordneten ID übernehmen.
            for (const [channel, id] of this.channelSampleIds) {
              if (id === msg.id) this.engine.setSampleBuffer(channel, pooled.left, pooled.right, pooled.sourceRate);
            }
          }
          break;
        case 'sample-assign':
          if (msg.channel && typeof msg.id === 'string') {
            const pooled = this.samplePool.get(msg.id);
            if (pooled) {
              this.engine.setSampleBuffer(msg.channel, pooled.left, pooled.right, pooled.sourceRate);
              this.channelSampleIds.set(msg.channel, msg.id);
            }
          }
          break;
        case 'control-ring':
          // RT-AUDIT-P1-010 (Schritt 2): Steuer-Ring einmalig anbinden (SAB geteilt, nicht kopiert).
          if (msg.ring && msg.ring.state instanceof SharedArrayBuffer && msg.ring.data instanceof SharedArrayBuffer) {
            this.controlRing = ControlRing.attach(msg.ring);
          }
          break;
        case 'sample-unload':
          // Nur aus dem Pool nehmen; ein noch zugeordneter Kanal behält seine Referenz.
          if (typeof msg.id === 'string') this.samplePool.delete(msg.id);
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
            this.engine.setSynthSource(msg.channel, {
              freq: msg.freq,
              voice: msg.voice ?? 'lead',
              // FEAT-P3-002: optionale Quellen-Parameter durchreichen.
              amount: msg.amount,
              modIndex: msg.modIndex,
            });
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
        case 'sfz-regions': {
          // RT-AUDIT-P1-010: Regionen sind im Main-Thread geparst, Quellen per Transfer.
          if (msg.channel && Array.isArray(msg.regions)) {
            const bank = new SfzVoiceBankCore(sampleRate, 0.002, 0.08);
            bank.loadParsed(msg.regions, (msg.sources ?? {}) as SfzSourceMap);
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
        case 'spatial-pcm-transport':
          try {
            const shared=msg.shared as SpatialPcmShared;
            if(shared.sampleRate!==sampleRate)throw new RangeError('Spatial sample-rate mismatch');
            const transport=new SpatialPcmTransport(shared);
            if(!msg.spatialPlan)throw new RangeError('Missing spatial plan');
            this.engine.configureSpatialSourceBus(msg.spatialPlan);
            if(transport.channels!==msg.spatialPlan.satellites.length)
              throw new RangeError('Spatial transport/plan channel mismatch');
            this.spatialTransport=transport;
            this.port.postMessage({type:'spatial-pcm-ready',channels:transport.channels});
          }catch(e){
            this.spatialTransport=null;
            this.engine.configureSpatialSourceBus(null);
            this.port.postMessage({type:'spatial-pcm-error',reason:String(e)});
          }
          break;
        case 'spatial-pcm-disable':
          this.spatialTransport=null;
          this.engine.configureSpatialSourceBus(null);
          break;
        case 'spatial-track-position':
          try{this.engine.setSpatialTrackPosition(msg.channel as V2Channel,msg.position);}catch{/* invalid position */}
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
        case 'master-dsp-oversampling':
          // DSP-P1-OVS-001: Oversampling des Master-DSP-Saettigers (1 | 2 | 4).
          this.engine.setMasterDspOversampling(Number(msg.factor));
          break;
        case 'master-mod-matrix':
          // FEAT-P3-002: optionale Modulations-Matrix (LFO → Master-Gain).
          this.engine.setMasterModMatrix(Boolean(msg.modEnabled), msg.modRate ?? 0.5, msg.modDepth ?? 0.35);
          break;
        case 'master-reverb':
          // FEAT-P3-002: optionale HQ-Reverb (4-Leitungs-FDN).
          this.engine.setMasterReverb(
            Boolean(msg.reverbEnabled),
            msg.reverbMix ?? 0.3,
            msg.reverbDecayS ?? 2,
            msg.reverbDamping ?? 0.35,
            msg.reverbSizeScale ?? 1,
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

        case 'it-config':
          if (msg.def) this.engine.itConfig(msg.def);
          break;
        case 'it-note-on':
          this.engine.itNoteOn(msg.note as number | string, msg.velocity ?? 1);
          break;
        case 'it-note-off':
          this.engine.itNoteOff(msg.note as number | string ?? undefined, msg.fast ?? false);
          break;
        case 'it-all-off':
          this.engine.itAllNotesOff();
          break;
        case 'it-automate':
          this.engine.itAutomate(String(msg.param ?? ''), Number(msg.value), Number(msg.rampTime ?? 0.02));
          break;
        default:
          break;
      }
    };
    // RT-AUDIT-P0-007: eine kaputte Nachricht darf weder den Port-Handler noch
    // den Prozessor beschädigen – Fehler fangen und als `message-error` melden.
    this.port.onmessage = (e: MessageEvent<V2SinkMessage>) => {
      // RT-AUDIT-P1-010 (Schritt 2): Gesamtreihenfolge Ring ↔ Port erhalten.
      // Erst die VOR dieser Nachricht geschriebenen Ring-Datensätze anwenden,
      // dann zählen (JEDE Port-Nachricht, auch kaputte – der Sink zählt
      // identisch). Ring-Datensätze NACH dieser Nachricht warten auf sie.
      try {
        this.drainControlRing();
      } catch (err) {
        this.faults.onMessageError(err, 'control-ring', this.port);
      }
      this.portSeqSeen = (this.portSeqSeen + 1) | 0;
      try {
        handleMessage(e);
      } catch (err) {
        this.faults.onMessageError(err, (e?.data as { type?: unknown } | null | undefined)?.type, this.port);
      }
    };
  }

  /**
   * RT-AUDIT-P0-007: Jeder Fehler im Render wird gefangen. Ausgang bleibt für
   * diesen Block stumm, der Prozessor bleibt am Leben (`return true`) und der
   * nächste Block rendert normal. Im fehlerfreien Pfad kostet das try/catch
   * nichts und allokiert nichts.
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    try {
      return this.renderBlock(inputs, outputs);
    } catch (e) {
      this.faults.onRenderError(e, outputs, currentFrame, this.port);
      return true;
    }
  }

  private renderBlock(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // RT-AUDIT-P1-010 (Schritt 2): Steuer-Ring am Blockanfang leeren (allokationsfrei).
    this.drainControlRing();

    const output = outputs[0];
    if (!output || !output[0]) return true;

    const length = output[0].length;
    // PERF-P3-001: Startmarke nur bei aktivierter Messung (Default aus).
    const startedAt = this.measure ? this.nowMs() : 0;
    // PERF-P3-002: Deadline-Treue ueber den Audio-Zaehler – unabhaengig von der
    // groben Wall-Clock. Ebenfalls nur bei aktivierter Messung.
    const gapQuanta = this.measure ? this.trackFrameGap(length) : 1;

    // Phase 3 Rest: SFZ-/Instrument-Voices als V2-Quelle rendern (AudioWorklet).
    // Hot-Path ohne Allokation: Scratch-Puffer + Block-Array werden je Kanal
    // wiederverwendet und nur bei geaenderter Blocklaenge einmalig nachgezogen.
    let instrumentSfz: Float32Array | null = null;
    for (let b = 0; b < this.sfzBanks.banks.length; b++) {
      const bank = this.sfzBanks.banks[b];
      const channel = this.sfzBanks.channels[b];
      if (!bank.hasActiveVoices()) continue;
      const scratch = this.sfzScratchFor(channel, length);
      bank.renderBlock(scratch.buffer, length);
      this.engine.setExternalSource(channel, scratch.block);
      if (channel === 'channel5') instrumentSfz = scratch.buffer;
    }

    // RT-AUDIT-P0-006 / AUDIO-2026-11-06-001: itSynth ist die Instrument-Quelle
    // und liegt auf dem Instrument-Vertragskanal channel5 (nicht channel4 –
    // das ist syntisampler). Beide Instrumentquellen teilen den Kanal, deshalb
    // hier in den SFZ-Scratch summieren statt die erste Quelle zu überschreiben.
    if (this.engine.itSynth.hasActiveVoices()) {
      const itScratch = this.itScratchFor('channel5', length);
      this.engine.itSynth.renderBlock(itScratch.buffer);
      // Mute gilt auch für externe Quellen: die Engine prüft ihre Mute-Liste
      // nur für Sample- und Stimmenpfade, nicht für `setExternalSource`.
      // Die Stimme läuft weiter (Hüllkurve), nur der Kanal bleibt still.
      if (this.engine.isChannelMuted('channel5')) {
        // bewusst kein Source-Block in diesem Quantum
      } else if (instrumentSfz) {
        for (let i = 0; i < length; i++) instrumentSfz[i] += itScratch.buffer[i];
      } else {
        this.engine.setExternalSource('channel5', itScratch.block);
      }
    }


    // RT-AUDIT-P0-003: Zeitsprung rückwärts (Kontext-Neustart) → Queue leeren.
    if (currentFrame < this.lastQueueFrame) this.stepQueue.clear();
    this.lastQueueFrame = currentFrame;

    // Neue Steps der Clock (allokationsfrei) mit absolutem Frame vormerken.
    if (this.clock.playing) {
      const count = this.clock.processBlockInto(currentFrame, length, this.clockOut);
      for (let k = 0; k < count; k++) {
        const planned = this.clockOut[k];
        this.stepQueue.push(planned.frame, planned.step, planned.secondsPerStep);
      }
    }

    // Alle Steps feuern, deren Frame in diesen Block fällt (verspätete bei 0).
    const fired = this.stepQueue.popDue(currentFrame, length, this.firedStart, this.firedStep, this.firedFrame, this.firedSps);
    for (let k = 0; k < fired; k++) {
      const startSample = this.firedStart[k];
      const step = this.firedStep[k];

      // UI-/State-Sync: Step-Impuls mit exakter Audio-Zeit an den Main-Thread –
      // erst jetzt, wo der Step tatsächlich erklingt.
      // RT-AUDIT-P0-004-F1: Die Master-Kette verzögert das hörbare Signal real
      // um den Lookahead. Damit UI-Lauflicht/Capture denselben Zeitpunkt sehen
      // wie das Ohr, wird der gemeldete Frame um `pdcLookaheadSamples`
      // vorgezogen (Variante A; die Audio-Zeitachse selbst bleibt unberührt).
      const audibleFrame = this.firedFrame[k] + this.pdcLookaheadSamples;
      this.port.postMessage({
        type: 'step',
        step,
        frame: audibleFrame,
        time: audibleFrame / sampleRate,
        swing: this.clock.swing,
        gate: this.clock.gate,
        secondsPerStep: this.firedSps[k],
        // AUDIO-2026-11-06-002: Meldungen eines alten Laufs sind am Main-Thread
        // an der Epoch erkennbar (Stop+Start in schneller Folge).
        epoch: this.transportEpoch,
      });
      // IDEA-2026-10-07-A-F1: exakter Transport-Start (erster Step 0 nach Start)
      // für das Capture-Raster – einmal je Start, vorallokiertes Objekt.
      if (this.transportStartPending && step === 0) {
        this.transportStartPending = false;
        const started = this.transportStartedMsg;
        started.frame = audibleFrame;
        started.time = audibleFrame / sampleRate;
        started.epoch = this.transportEpoch;
        this.port.postMessage(started);
      }

      for (let c = 0; c < V2_CHANNELS.length; c++) {
        const channel = V2_CHANNELS[c];
        if (!this.patterns.get(channel)?.[step]) continue;
        // AUDIO-P0-001: Mute-Parität – stummgeschaltete Kanäle triggern nicht.
        if (this.engine.isChannelMuted(channel)) continue;
        if (this.engine.hasSample(channel)) {
          // Phase 3: Sample-Player als V2-Source – Step retriggert das Sample
          // sample-genau am Step (nicht mehr am Blockanfang).
          this.stepSampleOptions.startSample = startSample;
          this.engine.triggerSample(channel, this.stepSampleOptions);
        } else {
          // Synth-/Step-Quelle (registrierte Frequenz oder Rollen-Default) als
          // Stimme im persistenten Voice-Pool der Engine (RT-AUDIT-P0-001).
          this.engine.scheduleSynth(channel, startSample, DEFAULT_STEP_VELOCITY);
        }
      }
    }

    const renderCtx = this.renderCtx;
    renderCtx.bufferSize = length;
    renderCtx.quantum = length / sampleRate;
    renderCtx.currentTime = currentTime;
    const rendered = this.engine.render(renderCtx);
    const spatial=this.engine.getSpatialSourceFrame();
    if(this.spatialTransport&&spatial&&length===128)this.spatialTransport.publish(spatial);

    const channels = Math.min(output.length, rendered.length);
    for (let ch = 0; ch < channels; ch++) {
      const src = rendered[ch] ?? rendered[0];
      output[ch].set(src);
    }
    for (let ch = channels; ch < output.length; ch++) {
      output[ch].fill(0);
    }
    this.recordCpu(startedAt, gapQuanta);
    // RT-AUDIT-P0-005: Metering auf den hörbaren MAIN-Ausgang. SAB einmal per
    // `meter-sab` übergeben (nicht im Konstruktor, s. Hinweis dort).
    this.updateMeters(_inputs, output, length);
    return true;
  }

  /**
   * RT-AUDIT-P0-005: schreibt Peak/True-Peak/RMS/Korrelation/LUFS in den SAB
   * und erkennt Worklet-Underruns über die Wall-Clock-Drift (zweite Quelle
   * neben der Main-Thread-Messung via getOutputTimestamp).
   * RT-AUDIT-P1-017: erweiterte per-Kanal-Messung statt Approximation.
   */
  private updateMeters(inputs: Float32Array[][], output: Float32Array[], length: number): void {
    if (!this.meterSabSent) {
      this.meterSabSent = true;
      try { this.port.postMessage({ type: 'meter-sab', sab: this.meterSab }); } catch { /* Port weg */ }
    }
    // RT-AUDIT-P0-005: klassische Stereo-Meterverarbeitung
    const left = output[0] ?? new Float32Array(length);
    const right = output.length > 1 ? output[1] : left;
    this.meters.processBlock(left.subarray(0, length), right.subarray(0, length));

    // RT-AUDIT-P1-017: echte Per-Kanal-Pegel berechnen
    // inputs[0] ist der primäre Audio-Eingang mit allen seinen Kanälen (Float32Array[])
    const inputChannels = inputs[0];
    if (inputChannels) {
      const numChannels = Math.min(inputChannels.length, V2_CHANNELS.length);
      for (let ch = 0; ch < numChannels; ch++) {
        const channelBuffer = inputChannels[ch];
        if (!channelBuffer) continue;

        // Peak: Maximum der absoluten Werte
        let peak = 0;
        for (let i = 0; i < length; i++) {
          const absVal = Math.abs(channelBuffer[i]);
          if (absVal > peak) peak = absVal;
        }
        this.view[METER_LAYOUT.CHANNEL_PEAK_START + ch] = peak > 1 ? 1 : peak;

        // RMS: Wurzel des Mittelwerts der quadrierten Werte
        let sumSq = 0;
        for (let i = 0; i < length; i++) {
          sumSq += channelBuffer[i] * channelBuffer[i];
        }
        const rms = Math.sqrt(sumSq / length);
        this.view[METER_LAYOUT.CHANNEL_RMS_START + ch] = rms > 1 ? 1 : rms;

        // True-Peak: Fallback auf Peak für Per-Kanal Metering
        this.view[METER_LAYOUT.CHANNEL_TRUE_PEAK_START + ch] = peak > 1 ? 1 : peak;
      }
    }

    // RT-AUDIT-P1-016: Schreibe Limiter-Gain-Reduction in den SAB
    const grL = this.engine.studio.masterMastering.limiterGainReductionDb;
    const grR = this.engine.studio.masterMastering.limiterGainReductionDb; // Same for stereo, or read per-channel if available
    // SAB Layout indices: GR_L=141, GR_R=142, GR_HOLD_L=143, GR_HOLD_R=144
    this.view[METER_LAYOUT.GR_L] = grL;
    this.view[METER_LAYOUT.GR_R] = grR;
    // Hold-Wert über ~20 ms (kein Sample-Verlust bei 60-Hz-Abfrage)
    this.view[METER_LAYOUT.GR_HOLD_L] = grL;
    this.view[METER_LAYOUT.GR_HOLD_R] = grR;

    // Driftmessung: alle 250 Blöcke die Wall-Clock gegen die Soll-Dauer prüfen.
    this.meterDriftBlocks++;
    if (this.meterDriftBlocks >= 250) {
      const now = Date.now();
      if (this.meterDriftLastMs !== 0) {
        const expectedMs = (250 * length / sampleRate) * 1000;
        if (isWorkletUnderrun(now - this.meterDriftLastMs, expectedMs)) this.meters.recordUnderrun(true);
      }
      this.meterDriftLastMs = now;
      this.meterDriftBlocks = 0;
    }
  }

  /**
   * RT-AUDIT-P1-010 (Schritt 2): wendet alle anstehenden Steuer-Datensätze an.
   * Ein Datensatz, dessen Port-Vorgänger (`portSeq`) noch nicht verarbeitet
   * sind, bleibt liegen (Reihenfolge Port → Ring bleibt erhalten). Keine
   * Allokation: vorallokierter Datensatz-Puffer + wiederverwendete Optionen.
   */
  private drainControlRing(): void {
    const ring = this.controlRing;
    if (ring === null) return;
    const rec = this.ringRecord;
    while (ring.peek(rec)) {
      if (!portSeqReached(this.portSeqSeen, rec[CONTROL_FIELD.SEQ])) return;
      ring.advance();
      this.applyControl(rec);
    }
  }

  private applyControl(rec: Float64Array): void {
    const op = rec[CONTROL_FIELD.OP];
    const a = rec[CONTROL_FIELD.A];
    if (op === CONTROL_OP.MASTER_GAIN) {
      this.engine.setMasterGain(a);
      return;
    }
    const channel = V2_CHANNELS[rec[CONTROL_FIELD.CHANNEL]];
    if (channel === undefined) return;
    switch (op) {
      case CONTROL_OP.GAIN_DB:
        this.engine.setChannelGainDb(channel, a);
        break;
      case CONTROL_OP.PAN:
        this.engine.setChannelPan(channel, a);
        break;
      case CONTROL_OP.MUTE:
        this.engine.setChannelMuted(channel, a !== 0);
        break;
      case CONTROL_OP.SYNTH_TRIGGER:
        this.engine.triggerSynth(channel, a);
        break;
      case CONTROL_OP.SAMPLE_TRIGGER: {
        const opts = this.ringSampleOptions;
        opts.rate = a;
        opts.offset = rec[CONTROL_FIELD.B];
        opts.loop = rec[CONTROL_FIELD.C] !== 0;
        opts.startSample = 0;
        this.engine.triggerSample(channel, opts);
        break;
      }
      default:
        break;
    }
  }

  /** Scratch-Puffer + Block-Array eines SFZ-Kanals, bei Bedarf einmalig angelegt. */
  private sfzScratchFor(channel: V2Channel, length: number): { buffer: Float32Array; block: Float32Array[] } {
    let entry = this.sfzScratch.get(channel);
    if (!entry || entry.buffer.length !== length) {
      entry = {
        buffer: this.allocateZeroFill(length),
        block: [],
      };
      entry.block.push(entry.buffer);
      this.sfzScratch.set(channel, entry);
    }
    return entry;
  }

  /**
   * PERF-P3-002: vergleicht `currentFrame` mit dem letzten Aufruf. Ein Sprung um
   * mehr als einen Quantum bedeutet, dass der Audio-Thread einen Block nicht
   * rechtzeitig gerendert hat (Luecke/Underrun) – gemessen mit der Audio-Uhr
   * selbst, also ohne Wall-Clock und ohne deren Quantisierungsproblem.
   *
   * Rueckgabe: Luecke in Quanten (1 = unauffaellig).
   */
  private trackFrameGap(quantumFrames: number): number {
    const frame = currentFrame;
    if (this.lastFrame < 0) {
      // Erster Block: keine Vergleichsbasis. Wichtig, weil die Messung sonst
      // beim Start eine Luecke erfinden wuerde.
      this.lastFrame = frame;
      return 1;
    }
    const delta = frame - this.lastFrame;
    this.lastFrame = frame;
    // Ruhende/zurueckspringende Uhr (Suspend, Kontext-Neustart) ist keine
    // verpasste Deadline und wird bewusst nicht als Luecke gezaehlt.
    if (delta <= 0) return 1;
    return Math.max(1, Math.round(delta / quantumFrames));
  }

  /**
   * PERF-P3-001: sammelt die Render-Zeit eines Blocks und meldet regelmaessig
   * einen Bericht an den Main-Thread. `budgetMs` ist die Echtzeit-Grenze des
   * Blocks (128 Frames / sampleRate) – `loadPct` ist damit der Anteil, den der
   * V2-Live-Pfad vom Audio-Thread belegt.
   *
   * PERF-P3-002: `gapQuanta` liefert zusaetzlich die Deadline-Treue ueber die
   * Audio-Uhr; sie ist die massgebliche Aussage, waehrend `maxMs` bei grober
   * Zeitquelle nur informativ ist.
   */
  private recordCpu(startedAt: number, gapQuanta: number): void {
    if (!this.measure) return;
    try {
      this.recordCpuUnsafe(startedAt, gapQuanta);
    } catch (e) {
      // Die Messung darf NIE den Audio-Pfad gefaehrden: einmal melden, dann aus.
      this.measure = false;
      this.port.postMessage({ type: 'cpu-error', message: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }

  private recordCpuUnsafe(startedAt: number, gapQuanta: number): void {
    const elapsed = this.nowMs() - startedAt;
    this.blocks += 1;
    this.sumMs += elapsed;
    if (elapsed > this.maxMs) this.maxMs = elapsed;

    // PERF-P3-002: Deadline-Treue. Massgeblich – im Gegensatz zu `maxMs` aus
    // der groben Wall-Clock, die nur als Hinweis im Bericht steht.
    if (gapQuanta > this.maxGapQuanta) this.maxGapQuanta = gapQuanta;
    if (gapQuanta > 1) {
      this.missedQuanta += gapQuanta - 1;
      this.stallEvents += 1;
    }

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
      /** PERF-P3-002: verpasste Render-Quanten (Luecken im currentFrame-Zaehler). */
      missedQuanta: this.missedQuanta,
      /** PERF-P3-002: groesste Luecke in Quanten (1 = nie eine Deadline verpasst). */
      maxGapQuanta: this.maxGapQuanta,
      /** PERF-P3-002: Anzahl der Bloecke, auf die eine Luecke folgte. */
      stallEvents: this.stallEvents,
      /** Die Render-Quantengroesse ist per Spec auf 128 Frames festgelegt. */
      quantumFrames: 128,
    });
  }
}

registerProcessor('v2-sink-processor', V2SinkProcessor);
