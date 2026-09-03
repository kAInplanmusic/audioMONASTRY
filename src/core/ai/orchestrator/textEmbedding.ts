/**
 * audioMONASTRY · Deterministische Text-Embeddings (semantische Suche)
 * =====================================================================
 * Lokale, serverlose Text-Embedding-Funktion für die Bibliotheks-Suche:
 * Token-Hash-Projektion (FNV-1a) auf einen 256-dimensionalen Vektor,
 * L2-normalisiert. Bewusst deterministisch → Tests/Offline-Betrieb nutzbar.
 * Für Produktionsqualität kann später ein echtes Embedding-Modell (Supabase
 * Edge Function / HF `audio.embed`-Pendant) denselben Vektorraum befüllen;
 * die `match_samples`-RPC bleibt identisch.
 */

export const EMBEDDING_DIMS = 256;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Tokenisiert deutschen/englischen Freitext grob. */
export function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/)
    .filter((t) => t.length > 0);
}

/** Erzeugt einen 256-dim L2-normalisierten Embedding-Vektor. */
export function embedText(text: string, dims: number = EMBEDDING_DIMS): number[] {
  const vec = new Float32Array(dims);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const h = fnv1a(token);
    vec[h % dims] += 1;
    // Bigramm-Features für etwas Kontext (Wortanfang).
    if (token.length >= 2) {
      const bigram = token.slice(0, 2);
      vec[fnv1a(bigram) % dims] += 0.5;
    }
  }

  // L2-normalisieren.
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out: number[] = new Array(dims);
  for (let i = 0; i < dims; i++) out[i] = vec[i] / norm;
  return out;
}
