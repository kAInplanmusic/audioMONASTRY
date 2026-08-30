/**
 * audioMONASTRY · Phase 3 – Source → Extraction → AudioObject Pipeline
 * =====================================================================
 * Wandelt Audio-Quellen (Tracks/Samples/Stems) in räumliche AudioObjects
 * um und legt sie in der SpatialScene ab.
 */
import { SpatialScene, type AudioObject, type Vec3 } from './SpatialScene';

export type AudioSourceKind = 'sample' | 'track' | 'stem' | 'recording';

export interface AudioSourceInput {
  id: string;
  name: string;
  kind: AudioSourceKind;
  /** Vorgeschlagene Position (optional, sonst Automatik). */
  position?: Vec3;
  gain?: number;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}

export interface ExtractionResult {
  source: AudioSourceInput;
  objects: AudioObject[];
}

export interface IAudioExtractor {
  readonly id: string;
  /** Kann dieser Extraktor die Quelle verarbeiten? */
  canExtract(source: AudioSourceInput): boolean;
  extract(source: AudioSourceInput): AudioObject[];
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/** Stereo-Quellen bekommen eine feste Links/Rechts-Position. */
export class StereoExtractor implements IAudioExtractor {
  readonly id = 'stereo';

  canExtract(source: AudioSourceInput): boolean {
    return source.kind === 'track' || source.kind === 'sample';
  }

  extract(source: AudioSourceInput): AudioObject[] {
    const position = source.position ?? { x: 0, y: 0.2, z: 0 };
    return [createObject(source, position)];
  }
}

/** Stems werden auf mehrere Objekte aufgeteilt (drums/bass/other/vocals). */
export class StemExtractor implements IAudioExtractor {
  readonly id = 'stems';

  canExtract(source: AudioSourceInput): boolean {
    return source.kind === 'stem' || Boolean(source.metadata?.stems);
  }

  extract(source: AudioSourceInput): AudioObject[] {
    const stems = (source.metadata?.stems as string[] | undefined) ?? ['drums', 'bass', 'other', 'vocals'];
    const positions: Record<string, Vec3> = {
      drums: { x: 0, y: 0, z: -0.5 },
      bass: { x: 0, y: 0.2, z: 0.3 },
      other: { x: -0.6, y: 0.1, z: 0.1 },
      vocals: { x: 0.6, y: 0.1, z: 0.1 },
    };
    return stems.map((stem, index) => createObject(
      { ...source, id: `${source.id}:${stem}`, name: `${source.name} (${stem})`, kind: 'stem' },
      positions[stem] ?? { x: (index % 2 === 0 ? -0.4 : 0.4), y: 0, z: 0 },
    ));
  }
}

/** Fallback: Mono-Aufnahme in die Mitte. */
export class DefaultExtractor implements IAudioExtractor {
  readonly id = 'default';

  canExtract(_source: AudioSourceInput): boolean {
    return true;
  }

  extract(source: AudioSourceInput): AudioObject[] {
    return [createObject(source, source.position ?? ORIGIN)];
  }
}

function createObject(source: AudioSourceInput, position: Vec3): AudioObject {
  return {
    id: source.id,
    name: source.name,
    position: { ...position },
    velocity: { x: 0, y: 0, z: 0 },
    gain: source.gain ?? 1,
    sourceRef: source.sourceRef ?? source.id,
    automation: { position: [{ time: 0, value: { ...position } }], gain: [] },
  };
}

export class SourceExtractionPipeline {
  private extractors: IAudioExtractor[] = [];

  constructor(private scene: SpatialScene) {
    this.register(new StemExtractor());
    this.register(new StereoExtractor());
    this.register(new DefaultExtractor());
  }

  register(extractor: IAudioExtractor): void {
    this.extractors.push(extractor);
  }

  /** Verarbeitet Quellen und legt die AudioObjects in der Szene ab. */
  process(sources: AudioSourceInput[]): ExtractionResult[] {
    const results: ExtractionResult[] = [];
    for (const source of sources) {
      const extractor = this.extractors.find((e) => e.canExtract(source));
      const objects = extractor?.extract(source) ?? [];
      for (const obj of objects) this.scene.addAudioObject(obj);
      results.push({ source, objects });
    }
    return results;
  }

  /** AudioObject-Hierarchie aus der Szene (für UI/Renderer). */
  listObjects(): AudioObject[] {
    return this.scene.listAudioObjects();
  }
}
