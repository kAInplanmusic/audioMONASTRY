import { describe, expect, it } from 'vitest';
import {
  analyzeDropAudio,
  deriveDropSuggestions,
  nextPlacementBar,
  type DropAnalysisRaw,
} from '../src/core/drop/DropAudioAnalyzer';

/** Das Beispiel aus der Flotten-Spezifikation: 808-Loop, 140 BPM, F minor. */
function exampleRaw(): DropAnalysisRaw {
  return {
    fileName: 'my_808_loop.wav',
    durationSeconds: 4.2,
    dsp: { bpm: 140, key: 'F minor', loudnessLufs: -9.4, peakDbfs: -0.3, transientStrength: 0.82 },
    labels: [
      { label: 'Bass drum', score: 0.91 },
      { label: 'Drum and bass', score: 0.44 },
    ],
    embeddings: {
      energy: 0.82,
      danceability: 0.76,
      genreAffinity: [
        { genre: 'Trap', score: 0.71 },
        { genre: 'Hip-Hop', score: 0.64 },
        { genre: 'Electronic', score: 0.58 },
      ],
    },
  };
}

describe('dropMONK · DropAudioAnalyzer', () => {
  it('erzeugt das vollständige Drop-Profil aus dem Spec-Beispiel', () => {
    const features = analyzeDropAudio(exampleRaw());

    expect(features.fileName).toBe('my_808_loop.wav');
    expect(features.bpm).toBe(140);
    expect(features.key).toBe('F minor');
    expect(features.durationSeconds).toBe(4.2);
    expect(features.loudnessLufs).toBe(-9.4);
    expect(features.peakDbfs).toBe(-0.3);
    expect(features.type).toBe('808 bass loop');
    expect(features.instrument).toBe('Bass');
    expect(features.vocal).toBe('none');
    expect(features.transient).toBe('strong');
    expect(features.energy).toBe(0.82);
    expect(features.danceability).toBe(0.76);
    expect(features.genreAffinity[0]).toEqual({ genre: 'Trap', score: 0.71 });
    expect(features.estimated).toEqual({ energy: false, danceability: false, genreAffinity: false });
  });

  it('platziert den Drop auf Takt 33 und Spur B bei passendem Tempo', () => {
    const features = analyzeDropAudio(exampleRaw());
    const suggestions = deriveDropSuggestions(features, { tempo: 140, arrangementBars: 32 });

    const place = suggestions.find((s) => s.kind === 'place');
    expect(place).toMatchObject({ kind: 'place', bar: 33, track: 'B' });
    expect(place?.reason).toContain('Takt 33');
    expect(place?.reason).toContain('Spur B');

    // Kein Time-Stretch nötig (140 == 140).
    expect(suggestions.some((s) => s.kind === 'time-stretch')).toBe(false);
  });

  it('schlägt Time-Stretch mit korrektem Faktor vor', () => {
    const features = analyzeDropAudio(exampleRaw()); // 140 BPM
    const suggestions = deriveDropSuggestions(features, { tempo: 128 });
    const stretch = suggestions.find((s) => s.kind === 'time-stretch');

    expect(stretch).toMatchObject({ kind: 'time-stretch', fromBpm: 140, toBpm: 128 });
    if (stretch?.kind === 'time-stretch') {
      expect(stretch.ratio).toBeCloseTo(128 / 140, 4);
      expect(stretch.reason).toContain('128 BPM');
    }
  });

  it('bietet immer eine Ähnlichkeitssuche mit konkretem Suchbegriff an', () => {
    const features = analyzeDropAudio(exampleRaw());
    const similar = deriveDropSuggestions(features, { tempo: 140 }).find((s) => s.kind === 'similar-samples');
    expect(similar).toMatchObject({ kind: 'similar-samples', query: '808 bass loop Trap Bass' });
  });

  it('warnt bei True Peak über -0.5 dBFS', () => {
    const features = analyzeDropAudio(exampleRaw());
    const notes = deriveDropSuggestions(features, { tempo: 140 }).filter((s) => s.kind === 'note');
    expect(notes.some((n) => n.reason.includes('True Peak'))).toBe(true);
  });

  it('markiert Energy/Danceability als geschätzt, wenn Embeddings fehlen', () => {
    const raw = exampleRaw();
    delete raw.embeddings;

    const features = analyzeDropAudio(raw);

    expect(features.estimated).toEqual({ energy: true, danceability: true, genreAffinity: true });
    expect(features.genreAffinity).toEqual([]);
    expect(features.energy).toBeGreaterThan(0);
    expect(features.danceability).toBeGreaterThan(0);
    // Der Hinweis muss sichtbar sein – keine stillen Fake-Werte.
    const notes = deriveDropSuggestions(features, { tempo: 140 }).filter((s) => s.kind === 'note');
    expect(notes.some((n) => n.reason.includes('geschätzt'))).toBe(true);
  });

  it('stuft Transientenstärke in drei Klassen', () => {
    const base = exampleRaw();
    const withTransient = (t: number) =>
      analyzeDropAudio({ ...base, dsp: { ...base.dsp, transientStrength: t } }).transient;
    expect(withTransient(0.1)).toBe('weak');
    expect(withTransient(0.5)).toBe('medium');
    expect(withTransient(0.9)).toBe('strong');
  });

  it('erkennt Vocals und Instrumentengruppen aus AST-Labels', () => {
    const base = exampleRaw();
    const vocal = analyzeDropAudio({ ...base, labels: [{ label: 'Singing', score: 0.8 }] });
    expect(vocal.vocal).toBe('present');
    expect(vocal.type).toBe('vocal');

    const keys = analyzeDropAudio({ ...base, labels: [{ label: 'Electric guitar', score: 0.6 }] });
    expect(keys.type).toBe('instrumental loop');
    expect(keys.instrument).toBe('Keys');

    const unknown = analyzeDropAudio({ ...base, labels: [] });
    expect(unknown.type).toBe('audio');
    expect(unknown.vocal).toBe('unknown');
  });

  it('rundet das Platzierungsraster auf 8-Takt-Blöcke', () => {
    expect(nextPlacementBar(0)).toBe(1);
    expect(nextPlacementBar(1)).toBe(9);
    expect(nextPlacementBar(31)).toBe(33);
    expect(nextPlacementBar(32)).toBe(33);
    expect(nextPlacementBar(33)).toBe(41);
  });
});
