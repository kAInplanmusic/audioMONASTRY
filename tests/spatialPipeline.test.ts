import { describe, expect, it } from 'vitest';
import { SpatialScene } from '../src/core/spatial/SpatialScene';
import { SourceExtractionPipeline } from '../src/core/spatial/SourceExtractionPipeline';

describe('Phase 3 – Source → Extraction → AudioObject Pipeline', () => {
  it('wandelt Track/Sample in Stereo-AudioObjects um', () => {
    const scene = new SpatialScene();
    const pipeline = new SourceExtractionPipeline(scene);

    const results = pipeline.process([
      { id: 'track-1', name: 'Track 1', kind: 'track', position: { x: -0.3, y: 0.2, z: 0 } },
      { id: 'sample-1', name: 'Kick', kind: 'sample' },
    ]);

    expect(results).toHaveLength(2);
    expect(scene.listAudioObjects()).toHaveLength(2);
    expect(scene.getAudioObject('track-1')?.position.x).toBe(-0.3);
    expect(scene.getAudioObject('sample-1')?.position).toEqual({ x: 0, y: 0.2, z: 0 });
  });

  it('splittet Stems in mehrere AudioObjects', () => {
    const scene = new SpatialScene();
    const pipeline = new SourceExtractionPipeline(scene);

    pipeline.process([
      {
        id: 'stem-pack-1',
        name: 'Song X',
        kind: 'stem',
        metadata: { stems: ['drums', 'bass', 'vocals'] },
      },
    ]);

    const objects = scene.listAudioObjects();
    expect(objects).toHaveLength(3);
    expect(objects.map((o) => o.id)).toEqual(['stem-pack-1:drums', 'stem-pack-1:bass', 'stem-pack-1:vocals']);
  });

  it('Fallback-Extractor legt unbekannte Quellen in die Mitte', () => {
    const scene = new SpatialScene();
    const pipeline = new SourceExtractionPipeline(scene);

    pipeline.process([{ id: 'rec-1', name: 'Field Recording', kind: 'recording' }]);
    expect(scene.getAudioObject('rec-1')?.position).toEqual({ x: 0, y: 0, z: 0 });
  });
});
