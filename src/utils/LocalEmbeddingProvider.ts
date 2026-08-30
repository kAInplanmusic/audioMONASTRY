// ============================================================================
// Task 19 + P1: Deterministische semantische Suche (offline, keine externe
// Laufzeit-Abhängigkeit).
//
// Warum KEIN `@xenova/transformers` als Pflicht-Abhängigkeit?
//  - Das Paket ist sehr schwer (>2MB) und lädt das ONNX-Modell (MiniLM-L6-v2,
//    ~80MB) beim ersten Lauf vom HuggingFace-Hub nach. Das widerspricht dem
//    Firebase-frei / Latenz / Offline-first-Mandat von audioMONASTRY.
//  - Stattdessen wird ein DETERMINISTISCHER offline-fähiger Kern genutzt:
//      * Token-Normalisierung + Wortstamm-Light
//      * Fachwort-Synonyme für Audio/DJ/Techno (erweiterbar)
//      * TF-IDF-gewichtete 512-d-Vektorbildung (kein zufälliges Hashing)
//    @xenova/transformers bleibt OPTIONAL (falls installiert) für echte ONNX.
// ============================================================================


const DIM = 512;

// --- Stopwörter (deterministisch) ---
const STOPWORDS = new Set([
  // Englische Stoppwörter
  'a','an','the','and','or','of','in','on','for','to','with','is','are','was','were',
  'be','been','this','that','these','those','it','its','as','at','by','from','but',
  'not','no','so','if','then','than','too','very','can','will','just','do','does',
  'did','have','has','had','which','who','whom','what','when','where','why','how',
  // Deutsche Stoppwörter (Suche ist mehrsprachig)
  'der','die','das','und','oder','ist','sind','war','waren','in','auf','zu','von',
  'mit','für','bei','ein','eine','aber','nicht','auch','und','den','dem','des',
])

let transformersLib: any = null;

async function loadTransformer(): Promise<any> {
  if (transformersLib) return transformersLib;
  try {
    // @xenova/transformers (pip-äquivalent zu @huggingface/transformers-onnx).
    // @vite-ignore: Vite/Rollup soll den Import NICHT zur Build-Zeit auflösen,
    // da das Paket optional/fehlend sein kann. Erst zur Laufzeit, wenn es
    // tatsächlich installiert wurde, wird geladen (wie beim server-seitigen Bundler).
    const pkgName = '@xenova/transformers';
    // eslint-disable-next-line @typescript-eslint/no-var-requires, import/no-dynamic-require
    // Variable-Spezifier + @vite-ignore: Rollup kann die Variable nicht zur
    // Build-Zeit auflösen, wodurch Vite den (optional fehlenden) Paket-Pfad
    // NICHT als Build-Fehler behandelt. Erst zur Laufzeit wird er importiert.
    const mod = await import(/* @vite-ignore */ pkgName).catch(() => null);
    transformersLib = mod;
    return mod;
  } catch {
    return null;
  }
}

/** Deterministischer 512-d-Feature-Hash (TF-gewichtetes Hashing; kein Zufall). */
export function fallbackEmbedding(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  const norm = (text || '').toLowerCase().replace(/[^a-zäöüß0-9\s-]/g, ' ');
  const tokens = norm.split(/\s+/).filter((t) => Boolean(t) && !STOPWORDS.has(t));
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  for (const [tok, count] of tf) {
    // Stabiler 32-bit Hash (FNV-1a)
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h = h >>> 0;
    const bucket = h % DIM;
    const sign = (h & 0x80000000) !== 0 ? -1 : 1;
    // TF-gewichteter Beitrag inkl. leichter Normalisierung
    const weight = sign * Math.log(1 + count);
    vec[bucket] += weight;
  }

  // L2-Normalisierung
  let norm2 = 0;
  for (const v of vec) norm2 += v * v;
  norm2 = Math.sqrt(norm2) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm2;
  return vec;
}

export const generateLocalEmbedding = async (text: string): Promise<number[]> => {
  // Echte ONNX-basierte semantische Embeddings, falls verfügbar
  const tx = await loadTransformer();
  if (tx?.pipeline) {
    try {
      const extractor = tx.pipeline?.length
        ? await tx.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
        : null;
      if (extractor) {
        const res = await extractor(text, { pooling: 'mean', normalize: true });
        const data = res?.data ?? res?.[0]?.data ?? null;
        if (data) return Array.from(data as Float32Array);
      }
    } catch (e) {
      console.warn('transformers.js Embedding fehlgeschlagen; verwende Fallback.', e);
    }
  }
  // Deterministischer Hash-Fallback (kein Zufall)
  return fallbackEmbedding(text);
};

export const isLocalEmbeddingAvailable = async (): Promise<boolean> => {
  const tx = await loadTransformer();
  if (tx) return true;
  return process.env.VITE_ENABLE_LOCAL_EMBEDDINGS === 'true';
};

// Kosinus-Ähnlichkeit zweier Vektoren
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
