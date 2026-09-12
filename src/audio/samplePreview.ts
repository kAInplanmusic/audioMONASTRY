/**
 * audioMONASTRY · Sample-Preview / Track-Load (AUDIO-P1-002 · aus `audioEngine`)
 * ===========================================================================
 * Kapselt die Hörprobe (Preview-Player + URL) und das Laden von Track-Samples
 * inkl. De-Klick-Abbau des alten Players. Ohne Tone-/Engine-Import: Player- und
 * Decode-Erzeugung sowie die Kanal-/V2-Anbindung werden hereingereicht; die
 * `samplePlayers`/`trackSampleUrl`-Maps bleiben in der Engine.
 */
import type { TrackType } from '../types';

/** Strukturelle Sicht auf einen `Tone.Player` (kein Tone-Import im Modul). */
export interface AudioPlayerLike {
  buffer?: { get?(): AudioBuffer | undefined } | null;
  volume: { rampTo(value: number, time: number): void };
  start(time?: number): void;
  stop(): void;
  disconnect?(): void;
  dispose?(): void;
}

/** Strukturelle Sicht auf einen `Tone.ToneAudioBuffer`. */
export interface ToneBufferLike {
  get?(): AudioBuffer | undefined;
}

export interface SamplePreviewDeps {
  ensureInitialized(): void;
  ensureChannelNode(track: TrackType): void;
  getChannelInput(track: TrackType): AudioNode | null;
  canLoadTrack(track: TrackType): boolean;
  getSamplePlayer(track: TrackType): AudioPlayerLike | null;
  setSamplePlayer(track: TrackType, player: AudioPlayerLike): void;
  deleteSamplePlayer(track: TrackType): void;
  getTrackSampleUrl(track: TrackType): string | null;
  setTrackSampleUrl(track: TrackType, url: string | null): void;
  bridgeBufferToV2(track: TrackType, buffer: AudioBuffer): void;
  triggerV2Sample(track: TrackType): void;
  getMusicBuffer(url: string): Promise<ToneBufferLike>;
  /** Tone-Erzeugung (injiziert, damit das Modul Tone-frei bleibt). */
  createPlayerFromUrl(url: string): AudioPlayerLike;
  createPlayerFromBuffer(buffer: ToneBufferLike, connectTo: AudioNode | null): AudioPlayerLike;
  decodeToV2(url: string, onBuffer: (buffer: AudioBuffer) => void): void;
}

export class SamplePreview {
  private previewPlayer: AudioPlayerLike | null = null;
  private previewUrl: string | null = null;

  constructor(private readonly deps: SamplePreviewDeps) {}

  previewSample(track: TrackType, time?: number, url?: string): void {
    this.deps.ensureInitialized();
    if (url) {
      // Vorherigen Preview-Player entsorgen, damit schnelles Klicken keinen
      // Player-Leak erzeugt (jeder Player hält einen Decoder-Puffer).
      try { this.previewPlayer?.dispose?.(); } catch { /* ignore */ }
      const player = this.deps.createPlayerFromUrl(url);
      this.previewPlayer = player;
      this.previewUrl = url;
      // AUDIO-P0-003: Preview hörbar in den V2-Sink laden und triggern.
      this.deps.decodeToV2(url, (audioBuffer) => {
        if (audioBuffer && audioBuffer.numberOfChannels > 0) {
          this.deps.bridgeBufferToV2(track, audioBuffer);
          this.deps.triggerV2Sample(track);
        }
      });
      return;
    }
    const existing = this.deps.getSamplePlayer(track);
    if (existing) {
      existing.start(time);
      // AUDIO-P0-003: auch zuvor geladene Track-Samples im V2-Sink triggern.
      const buffer = existing.buffer?.get?.();
      if (buffer && buffer.numberOfChannels > 0) {
        this.deps.bridgeBufferToV2(track, buffer);
        this.deps.triggerV2Sample(track);
      }
    }
  }

  /** Stoppt die laufende Hörprobe (falls aktiv) und gibt den Player frei. */
  stopPreview(): void {
    try { this.previewPlayer?.dispose?.(); } catch { /* ignore */ }
    this.previewPlayer = null;
    this.previewUrl = null;
  }

  /** URL der aktuell laufenden Hörprobe (null = keine aktiv). */
  getPreviewUrl(): string | null {
    return this.previewUrl;
  }

  /** Liefert die aktuell auf einem Track geladene Sample-URL (null = frei). */
  getTrackSampleUrl(track: TrackType): string | null {
    return this.deps.getTrackSampleUrl(track);
  }

  /** True, wenn auf dem Track bereits ein Sample geladen ist. */
  isTrackLoaded(track: TrackType): boolean {
    return !!this.deps.getTrackSampleUrl(track);
  }

  async loadTrackSample(track: TrackType, url: string | null): Promise<void> {
    // MAIN-Schutz: laden darf nur der Halter oder ein freigegebener Kanal.
    if (!this.deps.canLoadTrack(track)) return;
    // De-Klick: erst weich ausblenden (Volume-Rampe), dann nach kurzer Zeit
    // disconnect/dispose – ein harter dispose() während der Wiedergabe knackst.
    const oldPlayer = this.deps.getSamplePlayer(track);
    if (oldPlayer) {
      try { oldPlayer.volume.rampTo(-60, 0.02); } catch { /* ignore */ }
      try { oldPlayer.stop(); } catch { /* ignore */ }
      const p = oldPlayer;
      setTimeout(() => {
        try { p.disconnect?.(); } catch { /* ignore */ }
        try { p.dispose?.(); } catch { /* ignore */ }
      }, 100);
      this.deps.deleteSamplePlayer(track);
    }

    if (!url) {
      this.deps.setTrackSampleUrl(track, null);
      return;
    }

    // Ensure context is running (und AudioGraph inkl. this.ctx) vor dem Laden.
    await this.deps.ensureInitialized();
    // #DJ: Kanalzug sicherstellen und Player DURCH die Kette routen
    // (Pre-Fader → Gain → EQ → Pan → GLOBAL_MASTER), damit Mischpult-Regler wirken.
    this.deps.ensureChannelNode(track);
    // WF-2: Decode-Cache – identische URL wird nur einmal dekodiert.
    const buffer = await this.deps.getMusicBuffer(url);
    const player = this.deps.createPlayerFromBuffer(buffer, this.deps.getChannelInput(track));
    this.deps.setSamplePlayer(track, player);
    this.deps.setTrackSampleUrl(track, url);
    // Phase 3: denselben dekodierten Buffer als V2-Sample-Source registrieren.
    const audioBuffer = buffer.get?.();
    if (audioBuffer) this.deps.bridgeBufferToV2(track, audioBuffer);
  }

  /** Zustand zurücksetzen (dispose). */
  reset(): void {
    try { this.previewPlayer?.dispose?.(); } catch { /* ignore */ }
    this.previewPlayer = null;
    this.previewUrl = null;
  }
}
