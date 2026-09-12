/**
 * audioMONASTRY · N-Kanal-Spatial-Bus (AUDIO-P1-002 · aus `audioEngine` ausgelagert)
 * =================================================================================
 * Der mehrkanalige WebAudio-Spatial-Bus (2/4.0/6/8/10/12/14/16/18.x) samt
 * HRTF-Stereo-Cue-Zustand, Himmelsrichtungs-Panning (`calculateChannelPan`) und
 * de-klickten Setup-/Mode-Wechseln. Moved 1:1 aus `audioEngine`, ohne
 * Verhaltensänderung: derselbe ChannelSplitter(2)/ChannelMerger(N)-Aufbau,
 * dieselbe Gain-Verschaltung und dieselben 60-ms-Rebuild-Verzögerungen.
 *
 * Nur fremder Zustand wird hereingereicht: AudioContext, Quell-/Zielknoten, der
 * finale Output-Gain (de-klickter SEPARATION-Blend) und das Kanal-Pan der Engine.
 * Die Spatial-Felder (setupId/gains/merger/enabled/mode/rebuildTimer/lastChannels)
 * liegen jetzt hier.
 *
 * Bewusst NICHT hier (eigene Baustellen):
 *  - `routeChannelToSpatialInput`/`getMasterBusInput` – Kanal-Routing der Engine.
 *  - `applyMasterOutputRouting`/`master21` – 2.1-Master-Crossover.
 *  - `spatialSceneV2`/`sourceExtraction` – V2-SpatialScene (core/spatial).
 */
import { calculateChannelPan, calculateHRTF, SPATIAL_SETUPS, type SpatialSetup } from '../utils/spatialMath';
import type { TrackType } from '../types';

export interface SpatialBusDeps {
  /** AudioContext (für Node-Erzeugung, sampleRate und currentTime). */
  getContext(): AudioContext | null;
  /** Quellknoten des Busses: Master-Stream-Tap, sonst Master-Volume. */
  getMasterOut(): AudioNode | null;
  /** Ziel des Merger-Ausgangs (echte Surround-Geräte). */
  getDestination(): AudioNode | null;
  /** Finaler Ausgangs-Gain – wird für den weichen SEPARATION-Blend gefahren. */
  getOutputGain(): GainNode | null;
  /** Kanal-Pan im Engine-Kanalzug (HRTF-Stereo-Cue). */
  setChannelPan(track: TrackType, pan: number): void;
}

export class SpatialBus {
  private setupId: string = '10.0';
  private gains: (GainNode | null)[] = [];
  private merger: ChannelMergerNode | null = null;
  private enabled = false;
  private mode: 'ON_TOP' | 'SEPARATION' = 'ON_TOP';
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChannels: number[] = [];

  constructor(private readonly deps: SpatialBusDeps) {}

  /** Ist der Mehrkanal-Bus aufgebaut (surround-fähiges Setup)? */
  get isEnabled(): boolean {
    return this.enabled;
  }

  getSetupId(): string {
    return this.setupId;
  }

  getMode(): 'ON_TOP' | 'SEPARATION' {
    return this.mode;
  }

  /** Liefert die zuletzt berechneten Kanal-Gewichte (für UI/Visualisierung). */
  getLastChannels(): number[] {
    return this.lastChannels;
  }

  /** Verfügbare Mehrkanal-Konfigurationen (2/4.0/6/8/10/12/14/16/18.x). */
  getSetups(): SpatialSetup[] {
    return SPATIAL_SETUPS;
  }

  /** Legt die Mehrkanal-Konfiguration um (z.B. '10.0', '18.2'). */
  setSetup(setupId: string): void {
    this.setupId = SPATIAL_SETUPS.some((s) => s.id === setupId) ? setupId : '10.0';
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
    // De-Klick: alte Spatial-Gains erst weich auf 0 fahren, dann neu bauen.
    // Ein harter disconnect() während laufender Wiedergabe erzeugt Knackser.
    const ctx = this.deps.getContext();
    if (this.gains.length > 0 && ctx) {
      const t = ctx.currentTime;
      this.gains.forEach((n) => { try { n?.gain.setTargetAtTime(0, t, 0.02); } catch { /* ignore */ } });
      this.rebuildTimer = setTimeout(() => { this.rebuildTimer = null; this.build(); }, 60);
    } else {
      this.build();
    }
  }

  /**
   * Setzt die räumliche Position einer Spur und bindet die gewählte
   * Mehrkanal-Konfiguration ein.
   * - Stereo/HRTF-Cue bleibt für Kopfhörer erhalten.
   * - Zusätzlich werden die N Kanal-Gewichte via calculateChannelPan berechnet
   *   und auf die Kanal-GainNodes des N-Kanal-Spatial-Busses geschrieben.
   */
  setPosition(track: TrackType, x: number, y: number): void {
    const ctx = this.deps.getContext();
    const hrtf = calculateHRTF(x, y, ctx?.sampleRate || 48000);

    // HRTF-basiertes Stereo-Cue (Kopfhörer/Engineer). F1/F6: echtes Kanal-Pan
    // statt No-op-setWorkletParam/setMixChannelParam.
    const stereoPan = Math.max(-1, Math.min(1, (hrtf.azimuth || 0) / 90));
    this.deps.setChannelPan(track, stereoPan);

    // Mehrkanal-Konfigurationspanning (VBAP-artig auf 360°-Ring).
    const pan = calculateChannelPan(x, y, this.setupId);
    this.lastChannels = pan.channels;

    if (this.enabled && this.gains.length >= pan.channels.length) {
      const t = ctx?.currentTime ?? 0;
      pan.channels.forEach((g, i) => {
        const node = this.gains[i];
        if (node) node.gain.setTargetAtTime(g, t, 0.02);
      });
      // LFE-Kanäle (nach den Hauptkanälen) anwenden.
      pan.lfe.forEach((lg, k) => {
        const idx = pan.channels.length + k;
        const node = this.gains[idx];
        if (node) node.gain.setTargetAtTime(lg, t, 0.02);
      });
    }
  }

  /**
   * ON_TOP: Stereo-Master bleibt am Ausgang, Spatial-Bus läuft zusätzlich.
   * SEPARATION: Stereo-Master wird vom Ausgang getrennt → nur noch der
   * N-Kanal-Spatial-Bus ist hörbar (echte Surround-Separation).
   */
  setMode(mode: 'ON_TOP' | 'SEPARATION'): void {
    this.mode = mode;
    const ctx = this.deps.getContext();
    if (!ctx) return;
    try {
      // De-Klick: Stereo-Master wird über den finalen Output-Gain weich ein-/
      // ausgeblendet statt hart vom Ziel getrennt. Kein disconnect() während
      // laufender Wiedergabe mehr nötig.
      const t = ctx.currentTime;
      const out = this.deps.getOutputGain();
      if (out) {
        out.gain.cancelScheduledValues(t);
        out.gain.setTargetAtTime(mode === 'SEPARATION' ? 0.0001 : 1, t, 0.02);
      }
    } catch { /* ignore */ }
  }

  /**
   * Erstellt den N-Kanal-WebAudio-Spatial-Bus (fail-safe):
   * - Stereo-Master (L/R) wird über einen ChannelSplitter(2) gewonnen.
   * - Jede Hauptachse L,R wird über N GainNode pro Himmelsrichtung gewichtet
   *   und in einen ChannelMerger(N) gespeist -> echter Surround-Ausgang.
   * - Für 2.0 wird ein simpler Stereo-Passthrough genutzt.
   */
  build(): void {
    const ctx = this.deps.getContext();
    if (!ctx || typeof ctx.createGain !== 'function') return;
    try {
      const setup = SPATIAL_SETUPS.find((s) => s.id === this.setupId) ?? SPATIAL_SETUPS.find((s) => s.id === '10.0') ?? SPATIAL_SETUPS[0];
      const total = setup.numChannels + setup.lfe;

      // Alte Nodes entsorgen.
      this.gains.forEach((n) => { try { n?.disconnect(); } catch { /* ignore */ } });
      this.merger?.disconnect();

      if (setup.numChannels <= 2) {
        // 2.0 Stereo-Passthrough (kein Mehrkanal-Needs).
        this.gains = [];
        this.merger = null;
        this.enabled = false;
        return;
      }

      const splitter = ctx.createChannelSplitter(2); // L, R
      const gains: (GainNode | null)[] = [];
      const merger = ctx.createChannelMerger(total);

      // Mono-Anteile des Stereo-Eingangs als Quellen für die Ring-Gewichte.
      // Jede GainNode bekommt als Input einen gewichteten Mix aus L und R mit
      // fester Baseline; die eigentliche Richtung steuern wir über die Gains.
      const sourceL = ctx.createGain();
      const sourceR = ctx.createGain();
      // Summe, damit jedes Kanal-Element einen kohärenten Mono-SA hat.
      const monoSource = ctx.createGain();
      // Mono = (L+R) für den Ring (vereinfachtes Downmix UHJ→Ring).
      for (let i = 0; i < total; i++) {
        const g = ctx.createGain();
        g.gain.value = 0;
        monoSource.connect(g);
        g.connect(merger, 0, i);
        gains.push(g);
      }
      splitter.connect(sourceL, 0);
      splitter.connect(sourceR, 1);
      sourceL.connect(monoSource);
      sourceR.connect(monoSource);

      this.gains = gains;
      this.merger = merger;
      this.enabled = true;

      // Verbindung: Master-Signal in den Splitter einspeisen (Phase 9: V2-Tap
      // oder Master-Zustand; der hörbare Spatial-Pfad läuft über V2OutputGraph).
      const masterOut = this.deps.getMasterOut();
      if (masterOut) { try { masterOut.connect(splitter); } catch { /* ignore */ } }

      // Merger-Ausgang an Destination (für echte Surround-Geräte/Devices).
      const dest = this.deps.getDestination();
      if (dest) { try { merger.connect(dest); } catch { /* ignore */ } }
    } catch (e) {
      console.warn('Spatial-Bus nicht erstellt (fallback Stereo).', e);
      this.enabled = false;
      this.gains = [];
    }
  }

  /** Spatial-Zustand zurücksetzen (dispose). */
  reset(): void {
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
    this.gains = [];
    this.merger = null;
    this.enabled = false;
  }
}
