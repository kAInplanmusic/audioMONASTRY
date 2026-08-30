/**
 * audioMONASTRY · VoiceMONK V2-Ausgabe-Bridge
 * ============================================
 * Brücke vom Song-Generator zur V2-Ausgabe: Ein fertig generierter Song
 * (SessionMediaItem mit kind='song') wird in eine AudioSourceInput überführt
 * und über die SourceExtractionPipeline in der SpatialScene (V2) abgelegt.
 * DJ/Plugins können ihn dort als AudioObject aufgreifen.
 */
import type { SessionMediaItem } from '../session/SessionMediaStore';
import type { AudioSourceInput } from '../spatial/SourceExtractionPipeline';

/** V2-Ausgabesenke: nimmt Audio-Quellen entgegen (z.B. audioEngine.ingestAudioSources). */
export interface ISongOutputSink {
  publish(source: AudioSourceInput): void;
}

/** Wandelt ein Session-Medium in eine V2-AudioSource um (rein, ohne Seiteneffekte). */
export function songItemToAudioSource(item: SessionMediaItem): AudioSourceInput {
  return {
    id: item.id,
    name: item.text?.trim() ? item.text.trim().slice(0, 80) : item.id,
    kind: 'sample',
    sourceRef: item.audioUrl,
    gain: 1,
    metadata: { ...item.metadata, sessionKind: item.kind, createdAt: item.createdAt },
  };
}

/** SongOutputBridge: Session-Medium → Sink. */
export class SongOutputBridge {
  constructor(private sink: ISongOutputSink) {}

  publishSong(item: SessionMediaItem): AudioSourceInput {
    const source = songItemToAudioSource(item);
    this.sink.publish(source);
    return source;
  }
}

/**
 * Browser-Senke: veröffentlicht über die echte V2-Engine (audioEngine).
 * Bewusst lazy importiert, damit Core-Module ohne Tone/Web-Audio ladbar bleiben.
 */
export class V2EngineSongSink implements ISongOutputSink {
  publish(source: AudioSourceInput): void {
    void import('../../utils/audioEngine')
      .then(({ audioEngine }) => {
        try {
          audioEngine.ingestAudioSources([source]);
        } catch (err) {
          // Doppelte IDs oder fehlende Audio-Engine sind im Ausgabe-Pfad tolerierbar.
          console.warn('V2-Ausgabe-Bridge: Song konnte nicht veröffentlicht werden.', err);
        }
      })
      .catch(() => {
        // Audio-Engine nicht ladbar (z. B. Node/jsdom ohne Tone-Context) – bewusst still.
      });
  }
}

/** Default-Bridge für die aktuelle Session (V2 SpatialScene-Ausgabe). */
export const songOutputBridge = new SongOutputBridge(new V2EngineSongSink());
