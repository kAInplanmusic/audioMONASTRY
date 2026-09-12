/**
 * audioMONASTRY · Master-Stream-Tap + Visual-Analyser (AUDIO-P1-002, aus `audioEngine`)
 * ===================================================================================
 * Kapselt den MediaStream-Abgriff am Master-Ausgang (SFU/Recording) und den
 * Analyser-Tap für VisualMONK. Beide sind **reine Fan-outs**: sie verändern den
 * hörbaren Signalweg nicht. Bewusst ohne Engine-Zustand – Kontext, V2-Sink und
 * der (bewusst nicht aufgebaute) Legacy-Tap werden hereingereicht.
 *
 * AUDIT-AUDIO-006: Kein No-Op-Fallback. Fehlt ein echter Audio-Knoten, wird der
 * Nicht-Zustand explizit mit `null` gemeldet (Stille bleibt sichtbar), statt eine
 * gültige, aber stumme MediaStream-Destination zurückzugeben.
 */
import type { V2LiveSink } from '../core/audio/backends/V2LiveSink';

export interface MasterStreamTapDeps {
  getContext(): AudioContext | null;
  getSink(): V2LiveSink;
  /** Legacy-Tap; wird derzeit nie aufgebaut (immer null) – nur als echter Knoten genutzt. */
  getLegacyTap(): GainNode | null;
}

export class MasterStreamTap {
  private dest: MediaStreamAudioDestinationNode | null = null;
  private connectedViaV2 = false;

  constructor(private readonly deps: MasterStreamTapDeps) {}

  /** Zuletzt erzeugte Master-Stream-Destination (oder null). */
  get currentDest(): MediaStreamAudioDestinationNode | null {
    return this.dest;
  }

  /** Hängt die Destination am hörbaren V2-Ausgang? */
  get isV2Connected(): boolean {
    return this.connectedViaV2;
  }

  /**
   * Erzeugt eine MediaStream-Destination am Master-Ausgang (für Stream/SFU).
   * Liefert null, wenn kein AudioContext/Master vorhanden ist (kein Fake).
   */
  create(): MediaStreamAudioDestinationNode | null {
    try {
      const ctx = this.deps.getContext();
      if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') return null;
      const dest = ctx.createMediaStreamDestination();
      // AUDIO-P0-002: Bevorzugt den hörbaren V2-Ausgang abgreifen.
      if (this.deps.getSink().isConnected && this.deps.getSink().connectExtra(dest)) {
        this.dest = dest;
        this.connectedViaV2 = true;
        return dest;
      }
      // Kein No-Op-Fallback (siehe Modul-Kommentar): ohne echten Knoten null.
      const legacyTap = this.deps.getLegacyTap();
      if (!legacyTap) return null;
      legacyTap.connect(dest);
      this.dest = dest;
      this.connectedViaV2 = false;
      return dest;
    } catch {
      return null;
    }
  }

  /** Trennt eine zuvor erzeugte Master-Stream-Destination sauber. */
  disconnect(dest: MediaStreamAudioDestinationNode): void {
    try {
      // AUDIO-P0-002: V2-Abgriff zuerst trennen, sonst Legacy-Tap.
      this.deps.getSink().disconnectExtra(dest);
      this.deps.getLegacyTap()?.disconnect(dest);
      dest.disconnect();
      if (this.dest === dest) {
        this.dest = null;
        this.connectedViaV2 = false;
      }
    } catch { /* bereits getrennt */ }
  }

  /**
   * VisualMONK: Analyser-Tap am hörbaren V2-Ausgang (reiner Fan-out). Liefert
   * `null`, wenn der V2-Sink nicht verbunden ist – der Visualizer bleibt dann im
   * Ruhezustand, statt Stille als Audio zu verkaufen.
   */
  createAnalyser(fftSize = 2048): AnalyserNode | null {
    try {
      const ctx = this.deps.getContext();
      if (!ctx || typeof ctx.createAnalyser !== 'function') return null;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0.75;
      if (!this.deps.getSink().isConnected || !this.deps.getSink().connectExtra(analyser)) {
        try { analyser.disconnect(); } catch { /* ignore */ }
        return null;
      }
      return analyser;
    } catch {
      return null;
    }
  }

  /** Trennt einen Visual-Analyser sauber vom V2-Ausgang. */
  disconnectAnalyser(analyser: AnalyserNode): void {
    try {
      this.deps.getSink().disconnectExtra(analyser);
      analyser.disconnect();
    } catch { /* bereits getrennt */ }
  }

  /** Nach einem V2-Connect: vorhandene Destination an den V2-Ausgang nachhängen. */
  reattach(): void {
    if (this.dest && !this.connectedViaV2) {
      this.connectedViaV2 = this.deps.getSink().connectExtra(this.dest);
    }
  }

  /** Zustand zurücksetzen (dispose). */
  reset(): void {
    this.dest = null;
    this.connectedViaV2 = false;
  }
}
