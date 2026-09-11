/**
 * audioMONASTRY · dropMONK – Audio-Features & Drop-Vorschläge
 * ===========================================================
 * dropMONK soll beim Drag & Drop nicht „das ist eine WAV-Datei" sagen, sondern
 * ein strukturiertes Profil liefern und daraus konkrete DAW-Aktionen ableiten.
 *
 * Arbeitsteilung (siehe docs/RUNPOD_AI_V1_SPEC.md):
 *   - **deterministische DSP** (Essentia/librosa, CPU): BPM, Key, LUFS, Peak,
 *     Transientenstärke – läuft NICHT auf der GPU.
 *   - **ears-Rolle** (GPU): AST-Klassifikation (Typ/Instrument/Vocal) und
 *     Embeddings (MERT/CLAP) für Genre-Affinität, Energy, Danceability.
 *   - **brain-Rolle**: formuliert daraus die Empfehlung und ruft MCP-Tools.
 *
 * Dieses Modul ist bewusst rein und deterministisch: es normalisiert die
 * Analyse-Rohdaten zu einem stabilen Feature-Vertrag und leitet daraus
 * Vorschläge ab. Es trifft keine ML-Annahmen – fehlende Embedding-Werte werden
 * als Schätzung markiert, nicht erfunden.
 */

/** Rohdaten der Analyse (aus `audio.analyze` + `audio.classify` + `audio.embed`). */
export interface DropAnalysisRaw {
  fileName: string;
  durationSeconds: number;
  /** Deterministische DSP-Werte (Essentia/librosa, CPU). */
  dsp: {
    bpm: number;
    key: string;
    loudnessLufs: number;
    peakDbfs: number;
    /** 0..1 – Anteil transienter Energie (Onset-Stärke). */
    transientStrength: number;
  };
  /** AST-AudioSet-Labels mit Score (0..1). */
  labels?: Array<{ label: string; score: number }>;
  /** Embedding-Proben (MERT/CLAP); fehlen sie, wird geschätzt. */
  embeddings?: {
    energy?: number;
    danceability?: number;
    genreAffinity?: Array<{ genre: string; score: number }>;
  };
}

type DropVocal = 'none' | 'present' | 'unknown';
type DropTransient = 'weak' | 'medium' | 'strong';

/** Stabiler Feature-Vertrag für UI, aiMONK-Kontext und Vorschlagslogik. */
export interface DropAudioFeatures {
  fileName: string;
  bpm: number;
  key: string;
  durationSeconds: number;
  loudnessLufs: number;
  peakDbfs: number;
  /** z. B. "808 bass loop", "drum loop", "synth loop", "vocal". */
  type: string;
  genreAffinity: Array<{ genre: string; score: number }>;
  energy: number;
  danceability: number;
  instrument: string;
  vocal: DropVocal;
  transient: DropTransient;
  /** true = aus DSP abgeleitet, nicht aus einem Embedding-Modell gemessen. */
  estimated: { energy: boolean; danceability: boolean; genreAffinity: boolean };
  /** Bestes AST-Label (für Audit/Transparenz). */
  topLabel: string | null;
}

/** Projekt-/Arrangement-Kontext des laufenden Tracks. */
export interface DropProjectContext {
  tempo: number;
  key?: string;
  /** Länge des Arrangements in Takten (für die Platzierung). */
  arrangementBars?: number;
  /** Nächstes bzw. aktuelles Arrangement-Ende in Takten. */
  endBar?: number;
  /** Zielspur, falls der User eine gewählt hat. */
  preferredTrack?: string;
}

/** Konkrete, ausführbare Empfehlung (1 Schritt; die Planung macht aiMONK). */
export type DropSuggestion =
  | { kind: 'place'; bar: number; track: string; reason: string }
  | { kind: 'time-stretch'; fromBpm: number; toBpm: number; ratio: number; reason: string }
  | { kind: 'similar-samples'; query: string; reason: string }
  | { kind: 'note'; reason: string };

/** BPM-Toleranz, ab der ein Time-Stretch vorgeschlagen wird. */
const BPM_TOLERANCE = 2;
/** Raster, auf das Drops platziert werden (Taktschritte). */
const PLACEMENT_GRID_BARS = 8;

/** AST-Label → Drop-Typ. Erste Übereinstimmung gewinnt (Reihenfolge = Priorität). */
const TYPE_RULES: Array<{ pattern: RegExp; type: string; instrument: string }> = [
  { pattern: /808|bass\s*drum|kick/i, type: '808 bass loop', instrument: 'Bass' },
  { pattern: /bass(?!\s*drum)/i, type: 'bass loop', instrument: 'Bass' },
  { pattern: /drum|snare|hi-?hat|hihat|cymbal|percussion|beatbox/i, type: 'drum loop', instrument: 'Drums' },
  { pattern: /singing|vocal|choir|voice|speech|male|female/i, type: 'vocal', instrument: 'Voice' },
  { pattern: /synthesizer|synth|electronic|sampler|pad|lead/i, type: 'synth loop', instrument: 'Synth' },
  { pattern: /guitar|piano|keyboard|organ/i, type: 'instrumental loop', instrument: 'Keys' },
];

/** AST-Label, die auf eine Gesangs-/Spurstimme hindeuten. */
const VOCAL_PATTERN = /singing|vocal|voice|speech|choir|male|female/i;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function classify(labels: Array<{ label: string; score: number }> | undefined): {
  type: string;
  instrument: string;
  vocal: DropVocal;
  topLabel: string | null;
} {
  if (!labels || labels.length === 0) {
    return { type: 'audio', instrument: 'unknown', vocal: 'unknown', topLabel: null };
  }
  const sorted = [...labels].sort((a, b) => b.score - a.score);
  const topLabel = sorted[0]?.label ?? null;

  // Bestes Label, das eine Typregel erfüllt (nicht nur das global beste).
  for (const rule of TYPE_RULES) {
    const hit = sorted.find((l) => rule.pattern.test(l.label));
    if (hit) {
      const vocal: DropVocal = VOCAL_PATTERN.test(hit.label) ? 'present' : 'none';
      return { type: rule.type, instrument: rule.instrument, vocal, topLabel };
    }
  }
  const vocal: DropVocal = VOCAL_PATTERN.test(topLabel ?? '') ? 'present' : 'none';
  return { type: 'audio', instrument: 'unknown', vocal, topLabel };
}

function transientFrom(strength: number): DropTransient {
  if (strength >= 0.66) return 'strong';
  if (strength >= 0.33) return 'medium';
  return 'weak';
}

/**
 * Normalisiert Analyse-Rohdaten zu einem stabilen Feature-Profil.
 * Reine Funktion – keine IO, kein Netzwerk, deterministisch.
 */
export function analyzeDropAudio(raw: DropAnalysisRaw): DropAudioFeatures {
  const { type, instrument, vocal, topLabel } = classify(raw.labels);

  const energyFromModel = raw.embeddings?.energy;
  const danceFromModel = raw.embeddings?.danceability;
  const genres = raw.embeddings?.genreAffinity;

  // Energie-Proxy: Lautheit relativ zu einem typischen Loop-Pegel (-24 … -6 LUFS).
  const energyProxy = clamp01((raw.dsp.loudnessLufs + 24) / 18);
  // Danceability-Proxy: Transientenstärke plus Nähe zu typischen Club-Tempi (120–145).
  const tempoAffinity = raw.dsp.bpm >= 120 && raw.dsp.bpm <= 145
    ? 1
    : clamp01(1 - Math.abs(raw.dsp.bpm - 132) / 60);
  const danceProxy = clamp01(0.6 * raw.dsp.transientStrength + 0.4 * tempoAffinity);

  return {
    fileName: raw.fileName,
    bpm: round(raw.dsp.bpm, 1),
    key: raw.dsp.key,
    durationSeconds: round(raw.durationSeconds, 2),
    loudnessLufs: round(raw.dsp.loudnessLufs, 1),
    peakDbfs: round(raw.dsp.peakDbfs, 1),
    type,
    genreAffinity: (genres ?? []).map((g) => ({ genre: g.genre, score: round(clamp01(g.score), 2) })),
    energy: round(energyFromModel === undefined ? energyProxy : clamp01(energyFromModel), 2),
    danceability: round(danceFromModel === undefined ? danceProxy : clamp01(danceFromModel), 2),
    instrument,
    vocal,
    transient: transientFrom(raw.dsp.transientStrength),
    estimated: {
      energy: energyFromModel === undefined,
      danceability: danceFromModel === undefined,
      genreAffinity: !genres || genres.length === 0,
    },
    topLabel,
  };
}

/** Nächstes 8-Takt-Raster ab dem Arrangement-Ende (1-basierte Taktzählung). */
export function nextPlacementBar(endBar: number, grid: number = PLACEMENT_GRID_BARS): number {
  const safeEnd = Math.max(0, Math.floor(endBar));
  return 1 + Math.ceil(safeEnd / grid) * grid;
}

/**
 * Leitet aus Profil + Projektkontext die konkreten Aktionen ab.
 * Reihenfolge = Empfehlungspriorität. Der Aufrufer (aiMONK) führt sie über
 * MCP-Tools aus; diese Funktion entscheidet nur fachlich.
 */
export function deriveDropSuggestions(features: DropAudioFeatures, project: DropProjectContext): DropSuggestion[] {
  const suggestions: DropSuggestion[] = [];
  const projectTempo = project.tempo;

  // 1) Tempo-Abgleich: nur bei echter Abweichung.
  if (projectTempo > 0 && Math.abs(features.bpm - projectTempo) > BPM_TOLERANCE) {
    suggestions.push({
      kind: 'time-stretch',
      fromBpm: features.bpm,
      toBpm: projectTempo,
      ratio: round(projectTempo / features.bpm, 4),
      reason: `Das Sample ist ${features.bpm} BPM, dein Projekt ${projectTempo} BPM. Ich kann es per Time-Stretch auf ${projectTempo} BPM bringen.`,
    });
  }

  // 2) Platzierung im Arrangement.
  if (typeof project.arrangementBars === 'number' || typeof project.endBar === 'number') {
    const endBar = project.endBar ?? project.arrangementBars ?? 0;
    const bar = nextPlacementBar(endBar);
    const track = project.preferredTrack ?? (features.instrument === 'Bass' ? 'B' : 'A');
    suggestions.push({
      kind: 'place',
      bar,
      track,
      reason:
        `Das passt zu deinem aktuellen Track. Ich würde den Drop auf Takt ${bar} setzen ` +
        `und diesen ${features.type} auf Spur ${track} legen.`,
    });
  }

  // 3) Ähnliche Samples immer anbieten – Suchbegriff aus Typ + Genre + Instrument.
  const topGenre = features.genreAffinity.slice().sort((a, b) => b.score - a.score)[0]?.genre;
  const query = [features.type, topGenre, features.instrument].filter(Boolean).join(' ');
  suggestions.push({
    kind: 'similar-samples',
    query,
    reason: `Ich habe ähnliche Samples in deiner Library gesucht (${query}).`,
  });

  // 4) Warnungen, die der User kennen muss.
  if (features.peakDbfs > -0.5) {
    suggestions.push({ kind: 'note', reason: `Der True Peak liegt bei ${features.peakDbfs} dBFS – ich würde vor dem Einbau absenken (Clipping-Gefahr).` });
  }
  if (features.estimated.energy || features.estimated.danceability) {
    suggestions.push({ kind: 'note', reason: 'Energy/Danceability sind aus DSP-Werten geschätzt (kein Embedding-Modell verfügbar) – Beachten beim Vergleich mit anderen Samples.' });
  }

  return suggestions;
}
