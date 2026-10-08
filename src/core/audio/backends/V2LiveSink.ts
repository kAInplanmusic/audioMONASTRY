/**
 * audioMONASTRY · V2LiveSink
 * ===========================
 * Browser-Adapter für den V2-Live-Output-Sink (Phase 1).
 *
 * Der Sink lädt den `v2-sink-processor` (AudioWorklet), verbindet ihn mit der
 * AudioContext-Destination und steuert den V2-Testton sowie Gain/Pan/Master
 * über Port-Nachrichten. Der eigentliche V2-Graph (`V2SinkEngine`) läuft im
 * AudioWorklet-Thread sample-genau; diese Klasse enthält nur die dünne
 * WebAudio-Verdrahtung.
 *
 * In Node/jsdom (Tests, CI) sind alle Aufrufe sichere No-Ops.
 *
 * RT-AUDIT-P0-007: Fehler des Prozessors (`processorerror` = Prozessor tot,
 * `render-error`/`message-error` = im Worklet gefangen) gehen an `onFault`.
 * Die Reaktion (Neuaufbau, UI-Hinweis) entscheidet die Audio-Engine.
 *
 * RT-AUDIT-P1-010: Große Daten (Samples, SFZ-Quellen) gehen nur per Transfer
 * an den Prozessor (`postMessage(msg, transfer)`), nie per strukturiertem
 * Klonen – das würde im EMPFANGENDEN Thread, also im Audio-Thread,
 * deserialisiert. Samples liegen im Prozessor in einem Pool mit IDs
 * (`loadSample` einmal, danach `assignSample`/`triggerSample`). Der Sink merkt
 * sich, welche IDs der AKTUELLE Prozessor kennt; ein neuer Knoten (connect,
 * Neuaufbau nach Fehler, Layout-Wechsel) beginnt mit leerem Pool.
 */
import { parseSfz } from '../../instrument/sfzParser';
import type { SfzRegion } from '../../instrument/sfzRegion';
import type { V2Channel } from '../V2StudioGraph';
import type { V2SinkMessage, V2SynthVoice } from '../live/V2SinkEngine';
import type { MonitorRoutingPlan } from '../monitorRouting';
import { v2OutputChannelCount } from '../V2OutputGraph';
import type { V2SinkFaultInfo } from './sinkRecovery';

const V2_SINK_PROCESSOR_NAME = 'v2-sink-processor';
const V2_SINK_WORKLET_URL = '/worklets/v2SinkProcessor.js';

/**
 * RT-AUDIT-P1-010: Obergrenze für NICHT zugeordnete Samples im Pool des
 * Prozessors (Bytes). Zugeordnete Samples zählen mit, werden aber nie
 * verdrängt; darüber hinaus fliegen die am längsten unbenutzten zuerst raus.
 * Ein verdrängtes Sample wird bei erneutem Gebrauch einmal neu geladen.
 */
export const V2_SAMPLE_POOL_BUDGET_BYTES = 128 * 1024 * 1024;
/** Präfix der IDs des Kompatibilitätswegs `setSampleBuffer` (nie wiederverwendet). */
const ANON_SAMPLE_PREFIX = 'anon:';

export interface V2LiveSinkOptions {
  /** RT-AUDIT-P0-007: Fehler-Callback (Prozessor tot oder Fehler im Worklet gefangen). */
  onFault?: (info: V2SinkFaultInfo) => void;
  /** RT-AUDIT-P1-010: Pool-Budget in Bytes (Default `V2_SAMPLE_POOL_BUDGET_BYTES`). */
  samplePoolBudgetBytes?: number;
}

export class V2LiveSink {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private outputLayoutId = 'stereo';
  /** RT-AUDIT-P0-007: Fehler-Callback; kann jederzeit gesetzt werden. */
  onFault: ((info: V2SinkFaultInfo) => void) | null;
  /** Abmelde-Funktion der Fehler-Listener des aktuellen Knotens. */
  private detachFaultListeners: (() => void) | null = null;
  /**
   * RT-AUDIT-P1-010: IDs (→ Bytes), die der AKTUELLE Prozessor im Sample-Pool
   * hat. Einfüge-Reihenfolge = zuletzt benutzt am Ende (LRU für die Verdrängung).
   */
  private readonly pooledSamples = new Map<string, number>();
  private pooledBytes = 0;
  private readonly samplePoolBudgetBytes: number;
  /** RT-AUDIT-P1-010: Kanal → zugeordnete Sample-ID im aktuellen Prozessor. */
  private readonly channelSampleIds = new Map<V2Channel, string>();
  /** Zähler für anonyme IDs des Kompatibilitätswegs `setSampleBuffer`. */
  private anonSampleSerial = 0;

  constructor(options: V2LiveSinkOptions = {}) {
    this.onFault = options.onFault ?? null;
    this.samplePoolBudgetBytes = Math.max(0, options.samplePoolBudgetBytes ?? V2_SAMPLE_POOL_BUDGET_BYTES);
  }

  get isConnected(): boolean {
    return this.node !== null && this.context !== null;
  }

  /** AUDIO-P0-002: Zusätzlichen Abgriff (z. B. MediaStreamDestination) am V2-Ausgang anbinden. */
  connectExtra(dest: AudioNode): boolean {
    if (!this.node || !dest || typeof dest.connect !== 'function') return false;
    try {
      this.node.connect(dest);
      return true;
    } catch (e) {
      console.warn('[v2-sink] Zusatz-Abgriff fehlgeschlagen:', e);
      return false;
    }
  }

  /** AUDIO-P0-002: Zusatz-Abgriff trennen. */
  disconnectExtra(dest: AudioNode): void {
    if (!this.node || !dest) return;
    try { this.node.disconnect(dest); } catch { /* bereits getrennt */ }
  }

  /**
   * Verbindet den V2-Sink mit der AudioContext-Destination.
   * Lädt das Worklet-Modul bei Bedarf nach (idempotent).
   */
  async connect(ctx: AudioContext | null | undefined): Promise<boolean> {
    if (!ctx || typeof ctx.audioWorklet?.addModule !== 'function') return false;
    if (this.node && this.context === ctx) return true;

    this.disconnect();
    try {
      await ctx.audioWorklet.addModule(V2_SINK_WORKLET_URL);
    } catch (e) {
      console.warn(`[v2-sink] Worklet-Modul konnte nicht geladen werden (wird als bereits geladen behandelt):`, e);
    }

    try {
      const node = new AudioWorkletNode(ctx, V2_SINK_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [Math.max(2, Math.min(24, v2OutputChannelCount(this.outputLayoutId)))],
      });
      this.attachFaultListeners(node);
      node.connect(ctx.destination);
      this.context = ctx;
      this.node = node;
      // RT-AUDIT-P1-010: neuer Prozessor = leerer Sample-Pool.
      this.resetSamplePool();
      this.post({ type: 'output-layout', layoutId: this.outputLayoutId });
      return true;
    } catch (e) {
      console.warn('[v2-sink] V2-Live-Sink nicht verfügbar – V2 bleibt offline.', e);
      this.disconnect();
      return false;
    }
  }

  /** Phase 4: Ausgabe-Layout setzen (stereo/2.1/N.x). Wirkt live erst nach Reconnect. */
  setOutputLayout(layoutId: string): boolean {
    this.outputLayoutId = layoutId || 'stereo';
    if (this.isConnected && this.context) {
      this.disconnect();
      void this.connect(this.context); // asynchron reconnect; Fehler werden intern abgefangen
      return true;
    }
    return false;
  }

  getOutputLayout(): string {
    return this.outputLayoutId;
  }

  /** Trennt den Sink von der Destination (idempotent). */
  disconnect(): void {
    this.detachFaultListeners?.();
    this.detachFaultListeners = null;
    if (this.node) {
      try {
        this.node.port.postMessage({ type: 'test-tone', active: false } satisfies V2SinkMessage);
      } catch { /* Port nicht verfügbar */ }
      try {
        this.node.disconnect();
      } catch { /* bereits getrennt */ }
    }
    this.node = null;
    this.context = null;
    this.resetSamplePool();
  }

  /** Startet den hörbaren V2-Testton (channel1 → kompletter V2-Graph → Output). */
  startTestTone(freq = 440, amplitude = 0.2): boolean {
    return this.post({ type: 'test-tone', active: true, freq, amplitude });
  }

  /** Stoppt den V2-Testton. */
  stopTestTone(): boolean {
    return this.post({ type: 'test-tone', active: false });
  }

  /** Setzt den Kanal-Gain in dB auf der V2-Graph-Instanz im Worklet. */
  setChannelGainDb(channel: V2Channel, db: number): boolean {
    return this.post({ type: 'gain-db', channel, db });
  }

  /** Setzt das Stereo-Pan (-1..1) auf der V2-Graph-Instanz im Worklet. */
  setChannelPan(channel: V2Channel, pan: number): boolean {
    return this.post({ type: 'pan', channel, pan });
  }

  /** Setzt den Master-Gain (linear, 0..2) auf der V2-Graph-Instanz im Worklet. */
  setMasterGain(value: number): boolean {
    return this.post({ type: 'master-gain', value });
  }

  // -------------------------------------------------------------------------
  // AUDIO-P0-004: Master-Processing (EQ/DSP/FX/Dynamics/Mastering)
  // -------------------------------------------------------------------------

  /** Master-EQ: 3-Band-Gains in dB. */
  setMasterEq(lowDb: number, midDb: number, highDb: number): boolean {
    return this.post({ type: 'master-eq', lowDb, midDb, highDb });
  }

  /** Master-DSP: dynamisches Lowpass + Drive. */
  setMasterDsp(cutoff: number, resonance: number, depth: number, drive: number): boolean {
    return this.post({ type: 'master-dsp', cutoff, resonance, depth, drive });
  }

  /** FEAT-P3-002: optionale Modulations-Matrix (LFO → Master-Gain). */
  setMasterModMatrix(enabled: boolean, rate: number, depth: number): boolean {
    return this.post({ type: 'master-mod-matrix', modEnabled: enabled, modRate: rate, modDepth: depth });
  }

  /** FEAT-P3-002: optionale HQ-Reverb (4-Leitungs-FDN) auf dem Master. */
  setMasterReverb(enabled: boolean, mix: number, decayS: number, damping: number, sizeScale = 1): boolean {
    return this.post({
      type: 'master-reverb',
      reverbEnabled: enabled,
      reverbMix: mix,
      reverbDecayS: decayS,
      reverbDamping: damping,
      reverbSizeScale: sizeScale,
    });
  }

  /** Master-FX: Reverb/Delay/Chorus-Mix. */
  setMasterFx(wet: number, feedback: number, rate: number, depth: number): boolean {
    return this.post({ type: 'master-fx', wet, feedback, rate, depth });
  }

  /** Master-Dynamics-Insert (Soft-Knee-Kompressor). */
  setMasterDynamics(enabled: boolean, threshold: number, ratio: number, makeup: number): boolean {
    return this.post({ type: 'master-dynamics', enabled, threshold, ratio, makeup });
  }

  /** Master-Mastering (Kompression + Limiter). */
  setMasterMastering(threshold: number, ratio: number, makeup: number, ceiling: number): boolean {
    return this.post({ type: 'master-mastering', threshold, ratio, makeup, ceiling });
  }

  /** Phase 4: Überträgt den lokalen MonitorRoutingPlan in den V2-Sink. */
  setMonitorRouting(plan: MonitorRoutingPlan): boolean {
    if (!plan) return false;
    return this.post({ type: 'monitor-plan', plan });
  }

  /** Startet den sample-genauen V2-Transport (AudioWorklet-Step-Scheduler). */
  startTransport(config: { bpm?: number; swing?: number; gate?: number; stepCount?: 16 | 32 } = {}): boolean {
    return this.post({
      type: 'transport',
      playing: true,
      bpm: config.bpm,
      swing: config.swing,
      gate: config.gate,
      stepCount: config.stepCount,
    });
  }

  /** Stoppt den V2-Transport. */
  stopTransport(): boolean {
    return this.post({ type: 'transport', playing: false });
  }

  /** Aktualisiert laufende Transport-Parameter, ohne den Transport neu zu starten. */
  updateTransport(config: { bpm?: number; swing?: number; gate?: number; stepCount?: 16 | 32 } = {}): boolean {
    return this.post({
      type: 'transport',
      bpm: config.bpm,
      swing: config.swing,
      gate: config.gate,
      stepCount: config.stepCount,
    });
  }

  /** Setzt ein Step-Pattern (boolean[]) für einen V2-Kanal im Worklet. */
  setPattern(channel: V2Channel, steps: boolean[]): boolean {
    if (!Array.isArray(steps) || (steps.length !== 16 && steps.length !== 32)) return false;
    return this.post({ type: 'pattern', channel, steps: [...steps] });
  }

  // -------------------------------------------------------------------------
  // RT-AUDIT-P1-010: Sample-Pool mit IDs + Transfer
  // -------------------------------------------------------------------------

  /**
   * Lädt ein Sample unter `id` in den Pool des Prozessors – per TRANSFER.
   *
   * EIGENTUM: `left`/`right` (genauer: ihre ArrayBuffer) gehen an den
   * Audio-Thread über und sind danach im Main-Thread abgekoppelt
   * (`byteLength === 0`). Nur Arrays übergeben, die der Aufrufer danach nicht
   * mehr braucht – insbesondere NIE `AudioBuffer.getChannelData()` (Ansicht auf
   * den Speicher des AudioBuffer; der wäre danach kaputt). Für AudioBuffer:
   * `copyAudioBufferChannels()` (copyFromChannel in neue Arrays).
   * Ein Array, das nur eine Ansicht auf einen größeren Puffer ist, wird vor dem
   * Senden auf seine eigene Länge kopiert (sonst ginge der ganze Fremdpuffer mit).
   *
   * Erneutes Laden derselben ID ersetzt die Daten (zugeordnete Kanäle übernehmen sie).
   */
  loadSample(id: string, left: Float32Array, right?: Float32Array | null, sourceRate = 48000): boolean {
    if (!id || !left || left.length === 0) return false;
    if (!this.isConnected) return false;
    const l = ownedArray(left);
    const r = right && right.length > 0 ? ownedArray(right) : null;
    const transfer: Transferable[] = [l.buffer as ArrayBuffer];
    if (r && r.buffer !== l.buffer) transfer.push(r.buffer as ArrayBuffer);
    const bytes = l.byteLength + (r ? r.byteLength : 0);
    if (!this.post({ type: 'sample-load', id, left: l, right: r, sourceRate }, transfer)) return false;
    this.forgetPooled(id);
    this.pooledSamples.set(id, bytes);
    this.pooledBytes += bytes;
    this.evictUnusedSamples(id); // das frisch geladene bleibt bis zur Zuordnung
    return true;
  }

  /** Kennt der AKTUELLE Prozessor die Sample-ID? (Neuer Knoten → false.) */
  hasPooledSample(id: string): boolean {
    return this.pooledSamples.has(id);
  }

  /** Belegte Bytes im Pool des aktuellen Prozessors (Diagnose/Tests). */
  get pooledSampleBytes(): number {
    return this.pooledBytes;
  }

  /** Sample-ID, die einem Kanal im aktuellen Prozessor zugeordnet ist. */
  assignedSample(channel: V2Channel): string | null {
    return this.channelSampleIds.get(channel) ?? null;
  }

  /**
   * Ordnet einem Kanal ein bereits geladenes Pool-Sample zu (kleine Nachricht,
   * keine Sample-Daten; bei unveränderter Zuordnung gar keine). Nicht mehr
   * zugeordnete Samples bleiben im Pool (schneller Rückwechsel, z. B. nach einer
   * Hörprobe auf dem Kanal), bis das Budget sie verdrängt.
   */
  assignSample(channel: V2Channel, id: string): boolean {
    const bytes = this.pooledSamples.get(id);
    if (bytes === undefined) return false;
    const previous = this.channelSampleIds.get(channel);
    if (previous === id) return true;
    if (!this.post({ type: 'sample-assign', channel, id })) return false;
    this.channelSampleIds.set(channel, id);
    // LRU: zuletzt zugeordnet → ans Ende.
    this.pooledSamples.delete(id);
    this.pooledSamples.set(id, bytes);
    if (previous !== undefined && previous.startsWith(ANON_SAMPLE_PREFIX)) {
      // Anonyme IDs (Kompatibilitätsweg) werden nie wieder benutzt → sofort frei.
      this.unloadIfUnused(previous);
    } else {
      this.evictUnusedSamples();
    }
    return true;
  }

  /**
   * Kompatibilitätsweg (frühere `sample-set`-Nachricht): kopiert die Arrays
   * (der Aufrufer behält seine), lädt sie unter einer neuen ID per Transfer und
   * ordnet sie dem Kanal zu. Sendet IMMER – für wiederholte Aufrufe mit
   * demselben Sample den zwischengespeicherten Weg (`V2SampleUploader`) nehmen.
   */
  setSampleBuffer(channel: V2Channel, left: Float32Array, right?: Float32Array | null, sourceRate = 48000): boolean {
    if (!left || left.length === 0) return false;
    if (!this.isConnected) return false;
    const id = `${ANON_SAMPLE_PREFIX}${++this.anonSampleSerial}`;
    if (!this.loadSample(id, left.slice(), right ? right.slice() : null, sourceRate)) return false;
    return this.assignSample(channel, id);
  }

  /** Triggert die Sample-Wiedergabe eines Kanals im V2-Sink. */
  triggerSample(channel: V2Channel, options: { loop?: boolean; rate?: number; offset?: number } = {}): boolean {
    return this.post({
      type: 'sample-trigger',
      channel,
      loop: options.loop,
      rate: options.rate,
      offset: options.offset,
    });
  }

  /** Stoppt die Sample-Wiedergabe eines Kanals im V2-Sink. */
  stopSample(channel: V2Channel): boolean {
    return this.post({ type: 'sample-stop', channel });
  }

  /** Registriert eine Synth-/Step-Quelle für einen V2-Kanal. */
  setSynthSource(
    channel: V2Channel,
    freq: number,
    voice?: V2SynthVoice,
    opts: { amount?: number; modIndex?: number } = {},
  ): boolean {
    if (!Number.isFinite(freq) || freq <= 0) return false;
    return this.post({ type: 'synth-source', channel, freq, voice, amount: opts.amount, modIndex: opts.modIndex });
  }

  /** AUDIO-P0-001: Stummschaltung eines Kanals im V2-Sink. */
  setChannelMuted(channel: V2Channel, muted: boolean): boolean {
    return this.post({ type: 'mute', channel, muted });
  }

  /** AUDIO-P0-003: Manueller Synth-Trigger (Pads/Instruments) auf einem Kanal. */
  synthTrigger(channel: V2Channel, velocity = 1): boolean {
    if (!Number.isFinite(velocity)) return false;
    return this.post({ type: 'synth-trigger', channel, velocity });
  }

  /**
   * RT-AUDIT-P1-010: lädt eine im Main-Thread geparste Regionen-Tabelle als
   * V2-Quelle auf einen Kanal. Die Quellen gehen per TRANSFER an den
   * Audio-Thread und sind danach hier abgekoppelt – nur Arrays übergeben, die
   * der Aufrufer nicht mehr braucht (sonst vorher kopieren, s. `SfzBridge`).
   * Mehrere Einträge auf demselben Array werden nur einmal übertragen.
   */
  loadSfzRegions(channel: V2Channel, regions: SfzRegion[], sources: Record<string, Float32Array>): boolean {
    if (!Array.isArray(regions)) return false;
    if (!this.isConnected) return false;
    const sent: Record<string, Float32Array> = {};
    const owned = new Map<Float32Array, Float32Array>();
    const transfer: Transferable[] = [];
    for (const name of Object.keys(sources ?? {})) {
      const src = sources[name];
      if (!(src instanceof Float32Array)) continue;
      let arr = owned.get(src);
      if (!arr) {
        arr = ownedArray(src);
        owned.set(src, arr);
        const buf = arr.buffer as ArrayBuffer;
        if (!transfer.includes(buf)) transfer.push(buf);
      }
      sent[name] = arr;
    }
    return this.post({ type: 'sfz-regions', channel, regions, sources: sent }, transfer);
  }

  /**
   * Kompatibilitätsweg: SFZ-Text im MAIN-Thread parsen, Quellen kopieren (der
   * Aufrufer behält seine) und als Regionen-Tabelle per Transfer senden.
   */
  loadSfzBank(channel: V2Channel, sfzText: string, sources: Record<string, Float32Array>): boolean {
    if (!sfzText) return false;
    if (!this.isConnected) return false;
    return this.loadSfzRegions(channel, parseSfz(sfzText).regions, copySfzSources(sources));
  }

  /** SFZ-Note-On an die V2-Quelle des Kanals senden. */
  sfzNoteOn(channel: V2Channel, note: number, velocity = 100): boolean {
    if (!Number.isFinite(note)) return false;
    return this.post({ type: 'sfz-note-on', channel, note, velocity });
  }

  /** SFZ-Note-Off an die V2-Quelle des Kanals senden. */
  sfzNoteOff(channel: V2Channel, note: number): boolean {
    if (!Number.isFinite(note)) return false;
    return this.post({ type: 'sfz-note-off', channel, note });
  }

  /**
   * RT-AUDIT-P0-007: `processorerror` und die Fehler-Meldungen des Prozessors
   * abonnieren. `onprocessorerror` wird auf dem frisch erzeugten Knoten gesetzt
   * (dort gibt es noch keinen anderen Handler). Der Port-Listener wird per
   * `addEventListener` angehängt statt `port.onmessage` zu überschreiben, damit
   * andere Abnehmer (step/cpu-stats) nicht verdrängt werden. Meldungen eines
   * bereits ersetzten Knotens werden ignoriert.
   */
  private attachFaultListeners(node: AudioWorkletNode): void {
    this.detachFaultListeners?.();
    this.detachFaultListeners = null;
    const onProcessorError = (ev: Event | undefined) => {
      if (this.node !== node) return;
      const message = (ev as ErrorEvent | undefined)?.message;
      this.emitFault({ kind: 'processorerror', message: message || 'AudioWorklet-Prozessor abgestürzt' });
    };
    const onPortMessage = (ev: MessageEvent) => {
      if (this.node !== node) return;
      const data = ev?.data as { type?: unknown; message?: unknown; count?: unknown; messageType?: unknown } | null | undefined;
      if (!data || (data.type !== 'render-error' && data.type !== 'message-error')) return;
      this.emitFault({
        kind: data.type,
        message: typeof data.message === 'string' ? data.message : '',
        count: typeof data.count === 'number' ? data.count : undefined,
        messageType: typeof data.messageType === 'string' ? data.messageType : undefined,
      });
    };
    node.onprocessorerror = onProcessorError;
    const port = node.port as MessagePort | undefined;
    try {
      port?.addEventListener?.('message', onPortMessage);
      // Bei addEventListener startet der Port erst mit start() (onmessage täte das implizit).
      port?.start?.();
    } catch { /* Port nicht verfügbar */ }
    this.detachFaultListeners = () => {
      if (node.onprocessorerror === onProcessorError) node.onprocessorerror = null;
      try { port?.removeEventListener?.('message', onPortMessage); } catch { /* ignore */ }
    };
  }

  private emitFault(info: V2SinkFaultInfo): void {
    try {
      this.onFault?.(info);
    } catch (e) {
      console.warn('[v2-sink] Fehler-Callback fehlgeschlagen:', e);
    }
  }

  /** RT-AUDIT-P1-010: Pool-Buchführung zurücksetzen (neuer/kein Prozessor). */
  private resetSamplePool(): void {
    this.pooledSamples.clear();
    this.pooledBytes = 0;
    this.channelSampleIds.clear();
  }

  private isSampleAssigned(id: string): boolean {
    for (const used of this.channelSampleIds.values()) if (used === id) return true;
    return false;
  }

  private forgetPooled(id: string): void {
    const bytes = this.pooledSamples.get(id);
    if (bytes === undefined) return;
    this.pooledSamples.delete(id);
    this.pooledBytes -= bytes;
  }

  /** Gibt ein Pool-Sample frei, wenn kein Kanal es mehr nutzt. */
  private unloadIfUnused(id: string): void {
    if (!this.pooledSamples.has(id) || this.isSampleAssigned(id)) return;
    if (this.post({ type: 'sample-unload', id })) this.forgetPooled(id);
  }

  /** Verdrängt nicht zugeordnete Samples (älteste zuerst), bis das Budget passt. */
  private evictUnusedSamples(keep?: string): void {
    if (this.pooledBytes <= this.samplePoolBudgetBytes) return;
    for (const id of [...this.pooledSamples.keys()]) {
      if (this.pooledBytes <= this.samplePoolBudgetBytes) return;
      if (id !== keep) this.unloadIfUnused(id);
    }
  }

  /**
   * Sendet eine Nachricht an den Prozessor. `transfer` (RT-AUDIT-P1-010):
   * ArrayBuffer, die übertragen statt geklont werden – nur für große, danach
   * im Main-Thread nicht mehr benötigte Daten.
   */
  private post(message: V2SinkMessage, transfer?: Transferable[]): boolean {
    if (!this.node || typeof this.node.port?.postMessage !== 'function') return false;
    try {
      if (transfer && transfer.length > 0) this.node.port.postMessage(message, transfer);
      else this.node.port.postMessage(message);
      return true;
    } catch (e) {
      console.warn('[v2-sink] Port-Nachricht fehlgeschlagen:', e);
      return false;
    }
  }
}

/**
 * RT-AUDIT-P1-010: liefert ein Array mit EIGENEM, exakt passendem ArrayBuffer.
 * Ist `arr` nur eine Ansicht (Offset ≠ 0 oder kürzer als der Puffer), wird
 * kopiert – ein Transfer gäbe sonst den ganzen fremden Puffer ab. Geteilter
 * Speicher (SharedArrayBuffer) ist nicht übertragbar und wird ebenfalls kopiert.
 */
function ownedArray(arr: Float32Array): Float32Array {
  const buf = arr.buffer;
  const shared = typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer;
  if (!shared && arr.byteOffset === 0 && arr.byteLength === buf.byteLength) return arr;
  return arr.slice();
}

/** Kopiert eine SFZ-Quellen-Map (dasselbe Array unter mehreren Namen → eine Kopie). */
export function copySfzSources(sources: Record<string, Float32Array>): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  const copies = new Map<Float32Array, Float32Array>();
  for (const name of Object.keys(sources ?? {})) {
    const src = sources[name];
    if (!(src instanceof Float32Array)) continue;
    let copy = copies.get(src);
    if (!copy) {
      copy = src.slice();
      copies.set(src, copy);
    }
    out[name] = copy;
  }
  return out;
}

/**
 * RT-AUDIT-P1-010: Kanäle eines AudioBuffer in NEUE Float32Arrays kopieren
 * (`copyFromChannel`). `getChannelData()` liefert eine Ansicht auf den Speicher
 * des AudioBuffer, die nicht übertragen werden darf (der AudioBuffer wäre
 * danach kaputt). Die Kopien gehören dem Aufrufer und dürfen an
 * `V2LiveSink.loadSample` übertragen werden.
 */
export function copyAudioBufferChannels(buffer: AudioBuffer): { left: Float32Array; right: Float32Array | null } {
  const copy = (ch: number): Float32Array => {
    const out = new Float32Array(buffer.length);
    if (typeof buffer.copyFromChannel === 'function') buffer.copyFromChannel(out, ch);
    else out.set(buffer.getChannelData(ch));
    return out;
  };
  return { left: copy(0), right: buffer.numberOfChannels > 1 ? copy(1) : null };
}
