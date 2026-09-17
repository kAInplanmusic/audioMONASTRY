import { describe, expect, it } from 'vitest';
import {
  AUDIO_EMBED_DIMS,
  AUDIO_EMBED_MODEL,
  AUDIO_SEARCH_DEFAULT_LIMIT,
  AUDIO_SEARCH_MAX_LIMIT,
  AudioSearchError,
  extractAudioEmbedding,
  findLibrarySample,
  parseAudioSearchLimit,
  toAudioSearchResults,
} from '../src/core/library/audioSearch';
import { PRESET_SAMPLE_DATABASE } from '../src/data/samples';

/**
 * DB-P1-005: Der Audio-Embedding-Space war gefuellt, aber unlesbar. Geprueft
 * wird die reine Kette (Worker-Antwort -> Embedding -> Treffer-Mapping) - die
 * Route selbst deckt tests/server.test.ts mit gestubbtem Worker und RPC ab.
 */
const vector = (dims = AUDIO_EMBED_DIMS) => Array.from({ length: dims }, (_, i) => Math.sin(i));

describe('DB-P1-005 · Audio-Embedding aus der Worker-Antwort', () => {
  it('liest das Embedding aus { result: { embedding } }', () => {
    const embedding = extractAudioEmbedding({ result: { embedding: vector(), dim: AUDIO_EMBED_DIMS } });
    expect(embedding).toHaveLength(AUDIO_EMBED_DIMS);
    expect(AUDIO_EMBED_MODEL).toBe('clap-music');
  });

  it('weist falsche Formen ab, statt eine pgvector-Fehlermeldung zu provozieren', () => {
    expect(() => extractAudioEmbedding(null)).toThrow(AudioSearchError);
    expect(() => extractAudioEmbedding({ result: {} })).toThrowError(/kein Embedding/);
    expect(() => extractAudioEmbedding({ result: { embedding: [1, 2, 3] } })).toThrowError(/unerwartete Embedding-Form: 3/);
    expect(() => extractAudioEmbedding({ result: { embedding: vector(512).map((_, i) => (i === 0 ? Number.NaN : 1)) } }))
      .toThrowError(/unerwartete Embedding-Form/);
    try {
      extractAudioEmbedding({ result: { embedding: [1] } });
    } catch (error) {
      expect((error as AudioSearchError).code).toBe('EMBED_SHAPE');
    }
  });
});

describe('DB-P1-005 · Treffer auf die Bibliothek abbilden', () => {
  it('kennt Preset-Sample-IDs', () => {
    const known = PRESET_SAMPLE_DATABASE[0];
    const result = findLibrarySample(known.id);
    expect(result?.id).toBe(known.id);
    expect(findLibrarySample('gibt-es-nicht')).toBeUndefined();
  });

  it('bildet id/name/category/score ab und laesst unbekannte IDs sichtbar', () => {
    const known = PRESET_SAMPLE_DATABASE[0];
    const results = toAudioSearchResults([
      { sample_id: known.id, similarity: 0.987654 },
      { sample_id: 'unbekannt-1', similarity: 0.5 },
      { sample_id: 'kaputt', similarity: Number.NaN },
    ]);
    expect(results[0]).toEqual({ id: known.id, name: known.name, category: known.category, score: 0.9877 });
    expect(results[1]).toEqual({ id: 'unbekannt-1', name: 'unbekannt-1', category: 'unbekannt', score: 0.5 });
    // Kein NaN in der Antwort - das waere in JSON null und still falsch.
    expect(results[2].score).toBe(0);
    expect(JSON.stringify(results)).not.toContain('null,"score"');
  });

  it('begrenzt das Limit auf 1..50 (Default 10)', () => {
    expect(parseAudioSearchLimit(undefined)).toBe(AUDIO_SEARCH_DEFAULT_LIMIT);
    expect(parseAudioSearchLimit('0')).toBe(AUDIO_SEARCH_DEFAULT_LIMIT);
    expect(parseAudioSearchLimit('abc')).toBe(AUDIO_SEARCH_DEFAULT_LIMIT);
    expect(parseAudioSearchLimit('7')).toBe(7);
    expect(parseAudioSearchLimit('999')).toBe(AUDIO_SEARCH_MAX_LIMIT);
  });
});
