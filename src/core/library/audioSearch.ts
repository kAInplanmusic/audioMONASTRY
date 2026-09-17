/**
 * audioMONASTRY · Audio-Ähnlichkeitssuche (DB-P1-005)
 * =====================================================================
 * Der Batch-Indexer füllt `sample_audio_embeddings` (CLAP, 512-dim), die RPC
 * `match_audio_samples` existiert seit Migration 007 - **gelesen hat sie
 * niemand**: die Bibliotheks-Suche lief ausschließlich über den TEXT-Space
 * (`match_samples`, 256-dim). Dieses Modul ist der fehlende Konsument:
 *
 *   Audio-Query  →  CLAP-Embedding (ears-Rolle)  →  match_audio_samples
 *
 * Rein und damit ohne Netz testbar sind die Extraktion des Embeddings aus der
 * Worker-Antwort (Formprüfung!), die Zuordnung der Treffer auf Bibliotheks-
 * Einträge und das Limit.
 */
import { orchestralSamples } from '../../data/orchestralLibrary';
import { PRESET_SAMPLE_DATABASE, type AudioSample } from '../../data/samples';

/** Modell und Dimension des Audio-Space (Spiegel der Migration 007). */
export const AUDIO_EMBED_MODEL = 'clap-music';
export const AUDIO_EMBED_DIMS = 512;
export const AUDIO_SEARCH_DEFAULT_LIMIT = 10;
export const AUDIO_SEARCH_MAX_LIMIT = 50;

export class AudioSearchError extends Error {
  readonly code: 'EMPTY_AUDIO' | 'EMBED_SHAPE' | 'EMBED_FAILED';

  constructor(code: 'EMPTY_AUDIO' | 'EMBED_SHAPE' | 'EMBED_FAILED', message: string) {
    super(message);
    this.name = 'AudioSearchError';
    this.code = code;
  }
}

/**
 * Zieht das CLAP-Embedding aus der Worker-Antwort und prüft die Form.
 * Der ears-Worker antwortet mit `{ result: { embedding, dim } }`; alles andere
 * ist ein Fehler - ein falsch dimensioniertes Embedding würde die RPC mit einem
 * pgvector-Fehler beenden, statt eine ehrliche Meldung zu liefern.
 */
export function extractAudioEmbedding(output: unknown): number[] {
  const out = output as { result?: { embedding?: unknown; dim?: unknown } } | null;
  const embedding = out?.result?.embedding;
  if (!Array.isArray(embedding)) {
    throw new AudioSearchError('EMBED_SHAPE', 'Worker-Antwort enthaelt kein Embedding');
  }
  if (embedding.length !== AUDIO_EMBED_DIMS || !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new AudioSearchError(
      'EMBED_SHAPE',
      `unerwartete Embedding-Form: ${embedding.length} (erwartet ${AUDIO_EMBED_DIMS})`,
    );
  }
  return embedding as number[];
}

/** Bibliothekseintrag zu einer Sample-ID (Presets + Orchester-Bibliothek). */
export function findLibrarySample(id: string): AudioSample | undefined {
  const found = PRESET_SAMPLE_DATABASE.find((sample) => sample.id === id);
  if (found) return found;
  return orchestralSamples().find((sample) => sample.id === id);
}

export interface AudioSearchResult {
  id: string;
  name: string;
  category: string;
  score: number;
}

/** Treffer der RPC auf Bibliothekseinträge abbilden (unbekannte IDs bleiben sichtbar). */
export function toAudioSearchResults(
  matches: Array<{ sample_id: string; similarity: number }>,
): AudioSearchResult[] {
  return matches.map((match) => {
    const sample = findLibrarySample(match.sample_id);
    return {
      id: match.sample_id,
      name: sample?.name ?? match.sample_id,
      category: sample?.category ?? 'unbekannt',
      score: Number((Number.isFinite(match.similarity) ? match.similarity : 0).toFixed(4)),
    };
  });
}

/** Limit aus der Query (`?limit=`) auf 1..50 begrenzen; Default 10. */
export function parseAudioSearchLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return AUDIO_SEARCH_DEFAULT_LIMIT;
  return Math.min(AUDIO_SEARCH_MAX_LIMIT, Math.floor(value));
}
