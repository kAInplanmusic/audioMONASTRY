/**
 * audioMONASTRY · Channel-Strip-State (AUDIO-P1-002-Muster · aus `audioEngine` ausgelagert)
 * ========================================================================================
 * Kapselt den per-Kanal-Mischzustand (Fader/Pan/3-Band-EQ/Pre-Fader-Eingang) sowie
 * die letzte Nutzer-Gain je Kanal (für sanftes OFF/ON, D2-hybrid).
 *
 * Fortsetzung des bestehenden Kollaborator-Musters: die Engine hält die
 * Channel-Maps nicht mehr selbst, sondern delegiert an dieses Objekt. Die
 * Tone-Erzeugung der Knoten wird hereingereicht (wie in `instrumentSynth`),
 * damit der Zustand hier konzentriert bleibt.
 *
 * Verhalten 1:1 aus `audioEngine` übernommen (`ensureChannelNode`,
 * `getChannelGain`, `getChannelPan`, `setChannelGain`, `setChannelPan`,
 * `setChannelEQ`, Restore-Gain-Pfade) – reine Struktur-Extraktion.
 */
import type { TrackType } from '../types';

/** Struktur-Sicht auf die Tone-Knoten eines Kanalzugs (ohne Tone-Import). */
export interface ChannelStripNodes {
  input: { input?: unknown; connect?: (dest: unknown) => unknown; disconnect?: () => void };
  gain: {
    volume: {
      value: number;
      rampTo(value: number, time: number): void;
      setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
    };
    connect?: (dest: unknown) => unknown;
    disconnect?: (dest?: unknown) => void;
  };
  pan: {
    pan: { value: number; setTargetAtTime(value: number, time: number, timeConstant: number): void };
    connect?: (dest: unknown) => unknown;
    disconnect?: (dest?: unknown) => void;
  };
  low: { gain: { value: number; rampTo?(value: number, time: number): void } };
  mid: { gain: { value: number; rampTo?(value: number, time: number): void } };
  high: { gain: { value: number; rampTo?(value: number, time: number): void } };
}

/** EQ-Band-Knoten eines Kanals (Low-Shelf / Peaking / High-Shelf). */
export interface ChannelStripEq {
  low: ChannelStripNodes['low'];
  mid: ChannelStripNodes['mid'];
  high: ChannelStripNodes['high'];
}

export interface ChannelStripDeps {
  /** Erzeugt die Tone-Knoten eines Kanalzugs (Tone bleibt in der Engine). */
  createNodes(): ChannelStripNodes;
  /** Aktuelle AudioContext-Zeit für die Pan-Rampe (klickfrei). */
  now(): number;
}

/**
 * Echte per-Kanal-Mischung: Jeder Track (channel1..channel10) hat eine eigene
 * Gain- und Pan-Stufe; die Mischpult-Fader steuern damit tatsächlich die
 * Audiokette (statt nur nachbildende UI-Werte). #DJ: zusätzlich 3-Band-EQ.
 */
export class ChannelStripState {
  private gains: Partial<Record<TrackType, ChannelStripNodes['gain']>> = {};
  private pans: Partial<Record<TrackType, ChannelStripNodes['pan']>> = {};
  private eqs: Partial<Record<TrackType, ChannelStripEq>> = {};
  /** F1: Pre-Fader-Eingang je Kanal – alle Quellen speisen hier ein, damit
   *  Fader/EQ/Pan und Cue/PFL real wirken. */
  private inputs: Partial<Record<TrackType, ChannelStripNodes['input']>> = {};
  /** Letzte Nutzer-Gains je Kanal – für sanftes OFF/ON (D2-hybrid). */
  private restoreGain: Partial<Record<TrackType, number>> = {};

  constructor(private readonly deps: ChannelStripDeps) {}

  /**
   * Stellt den per-Kanal-Gain/Pan für einen Track bereit (zwischenspeichert die
   * Tone-Nodes). #DJ: zusätzlich 3-Band-EQ (Low-Shelf → Peaking Mid → High-Shelf).
   */
  ensure(track: TrackType): void {
    if (this.gains[track]) return;
    const n = this.deps.createNodes();
    n.low.gain.value = 0; n.mid.gain.value = 0; n.high.gain.value = 0;
    this.eqs[track] = { low: n.low, mid: n.mid, high: n.high };
    this.inputs[track] = n.input;
    this.gains[track] = n.gain;
    this.pans[track] = n.pan;
  }

  /** Kanal-Gain-Knoten (undefined, wenn der Kanal noch nicht angelegt ist). */
  gainNode(track: TrackType): ChannelStripNodes['gain'] | undefined {
    return this.gains[track];
  }

  /** Kanal-Pan-Knoten (undefined, wenn der Kanal noch nicht angelegt ist). */
  panNode(track: TrackType): ChannelStripNodes['pan'] | undefined {
    return this.pans[track];
  }

  /** 3-Band-EQ-Knoten eines Kanals. */
  eqNode(track: TrackType): ChannelStripEq | undefined {
    return this.eqs[track];
  }

  /** Pre-Fader-Eingang eines Kanals. */
  inputNode(track: TrackType): ChannelStripNodes['input'] | undefined {
    return this.inputs[track];
  }

  /** Kanal-Fader als lineares Gain (0..1.5) zurücklesen. */
  getGain(track: TrackType): number {
    const db = this.gains[track]?.volume.value;
    if (db === undefined || db === -Infinity) return 0;
    return Math.pow(10, db / 20);
  }

  /** Kanal-Pan (-1..1) zurücklesen. */
  getPan(track: TrackType): number {
    return this.pans[track]?.pan.value ?? 0;
  }

  /** Kanal-Fader in dB rampen (rampTo, 30 ms). */
  rampGainToDb(track: TrackType, db: number, rampSec = 0.03): void {
    this.gains[track]!.volume.rampTo(db, rampSec);
  }

  /** Kanal-Fader in dB ohne Rampe setzen (init-Grundpegel). */
  setGainDb(track: TrackType, db: number): void {
    this.gains[track]!.volume.value = db;
  }

  /** Kanal-Fader als lineares Gain in dB umrechnen und rampen (0..1.5 geklemmt). */
  rampGainLinear(track: TrackType, gain01: number, rampSec = 0.03): void {
    const v = Number.isFinite(gain01) ? Math.max(0, Math.min(1.5, gain01)) : 0;
    const db = v <= 0.001 ? -Infinity : 20 * Math.log10(v);
    this.gains[track]!.volume.rampTo(db, rampSec);
  }

  /** Pan klickfrei setzen (-1..1 geklemmt; 30 ms Zeitkonstante). */
  setPan(track: TrackType, pan: number): void {
    const p = this.pans[track];
    if (!p) return;
    p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), this.deps.now(), 0.03);
  }

  /** #DJ: Pro-Kanal 3-Band-EQ setzen. gain in dB, band: 'low'|'mid'|'high'. */
  setEq(track: TrackType, band: 'low' | 'mid' | 'high', gain: number): void {
    const eq = this.eqs[track];
    if (!eq) return;
    // F6-Fix: NaN/Inf abfangen (Math.max/min allein lassen NaN durch).
    const v = Number.isFinite(gain) ? Math.max(-24, Math.min(12, gain)) : 0;
    try { eq[band].gain.rampTo?.(v, 0.03); } catch { /* ignore */ }
  }

  /** Liest die letzte Nutzer-Gain eines Kanals (linear, Default 1). */
  getRestoreGain(track: TrackType): number {
    return this.restoreGain[track] ?? 1;
  }

  /**
   * Merkt die zuletzt hörbare Nutzer-Gain eines Kanals (linear) und schaltet den
   * Kanal sanft auf den gemerkten Pegel laut (D2-hybrid Re-Activate).
   */
  restoreToRememberedGain(track: TrackType, rampSec = 0.03): void {
    const restore = this.restoreGain[track] ?? 1;
    const db = restore <= 0.001 ? -Infinity : 20 * Math.log10(restore);
    try { this.gains[track]!.volume.rampTo(db, rampSec); } catch { /* ignore */ }
  }

  /**
   * Stummschaltung mit Merken der aktuellen Nutzer-Gain: liest den aktuellen
   * dB-Pegel, merkt ihn linear (nur wenn hörbar) und rampt auf -∞.
   */
  muteAndRemember(track: TrackType, rampSec = 0.05): void {
    const g = this.gains[track];
    if (!g) return;
    const current = g.volume.value;
    if (current > 0.001) this.restoreGain[track] = Math.pow(10, current / 20);
    try { g.volume.rampTo(-Infinity, rampSec); } catch { /* ignore */ }
  }

  /** Kanalzug-Zustand zurücksetzen (dispose; die Knoten sind reine Zustandsträger). */
  reset(): void {
    this.inputs = {};
    this.gains = {};
    this.pans = {};
    this.eqs = {};
  }
}
