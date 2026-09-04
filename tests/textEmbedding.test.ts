import { describe, expect, it } from 'vitest';
import { embedText, tokenize, EMBEDDING_DIMS } from '../src/core/ai/orchestrator/textEmbedding';

describe('textEmbedding (deterministisch, für match_samples-RPC)', () => {
  it('ist deterministisch und hat 256 Dimensionen', () => {
    const a = embedText('Techno Kick Bass');
    const b = embedText('Techno Kick Bass');
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIMS);
  });

  it('ist L2-normalisiert (Norm ≈ 1)', () => {
    const vec = embedText('Deep warehouse techno drums');
    let norm = 0;
    for (const v of vec) norm += v * v;
    expect(Math.abs(Math.sqrt(norm) - 1)).toBeLessThan(1e-5);
  });

  it('ähnliche Texte sind ähnlicher als unähnliche', () => {
    const a = embedText('Acid Bass 303');
    const b = embedText('Acid Bassline 303');
    const c = embedText('Violine Streicher Orchester');
    const dot = (x: number[], y: number[]) => x.reduce((sum, v, i) => sum + v * y[i], 0);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
  });

  it('tokenize filtert Satzzeichen und normalisiert', () => {
    expect(tokenize('Hallo, WELT! 303')).toEqual(['hallo', 'welt', '303']);
  });
});
