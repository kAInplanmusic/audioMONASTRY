/**
 * audioMONASTRY · stemMONK → RP5 (FLEET-P1-006)
 * =============================================
 * Der Server-Weg von stemMONK. Vorher lief er ausschliesslich über den
 * stem-ai-Dienst (htdemucs, 4 Stems), der daraus Schein-5-Stems baute
 * (mids = highs = melody = other, drums fehlte). Jetzt:
 *
 *   1. RP5 (stems-Pod) – `stem.separate` mit `bs-roformer-sw-6stem`, 5 Stems per
 *      Weiche (handlers_stems.py / stem_crossover.py), optional BPM/Key-Warp
 *      auf das Projekt (stem_warp.py).
 *   2. Ablage: mit R2 lädt der Pod die WAVs per Presigned-PUT direkt in den
 *      Bucket (Antwort bleibt klein). Ohne R2 kommen sie als Base64 an den
 *      Server und landen in der Server-Ablage (data/uploads). Der Client bekommt
 *      IMMER nur URLs – nie Base64 (AGENTS.md: nichts auf den Geräten).
 *   3. Bibliothek: jeder Stem wird serverseitig eingetragen (lokale Liste bzw.
 *      Supabase), gleiche IDs wie im Client – kein Doppel-Upload.
 *
 * Fehlt der Pod oder können Modell/Gewichte nicht geladen werden, gibt es eine
 * klare Fehlermeldung – KEINEN stillen Rückfall auf Schein-Stems. Der
 * 4-Stem-Modus (stem-ai/htdemucs) ist nur auf ausdrücklichen Wunsch (`mode=4stem`)
 * erreichbar und als solcher gekennzeichnet.
 *
 * Alles hier ist ein Offline-Job ausserhalb des Live-Audiopfads.
 */
import { random } from '../src/utils/random';
import { pushSampleToCloud, r2ConfigFromEnv, trimTrailingSlash, uploadSampleToR2 } from './cloud.ts';
import { logR2Once, toR2WriteError } from './r2Health.ts';
import { addLocalSample, saveLocalMedia } from './localMediaStore.ts';
import { presignUrl } from './s3Presign.ts';
import { aiOrchestrator } from '../src/core/ai/orchestrator/aiOrchestrator';
import type { AiTask } from '../src/core/ai/orchestrator/types';

export const RP5_STEM_MODEL = 'bs-roformer-sw-6stem';
/** Erlaubte RP5-Trennmodelle (scnet-xl-ihf = 4-Stem-Fallback, sobald gepinnt). */
export const RP5_STEM_MODELS = new Set([RP5_STEM_MODEL, 'scnet-xl-ihf']);
export const FIVE_STEM_KEYS = ['vocals', 'lows', 'mids', 'highs', 'melody'] as const;
export const FOUR_STEM_KEYS = ['vocals', 'bass', 'drums', 'other'] as const;
export type StemCategory = 'bass' | 'mids' | 'highs';

const CATEGORY: Record<string, StemCategory> = {
  vocals: 'mids', lows: 'bass', mids: 'mids', highs: 'highs', melody: 'mids',
  bass: 'bass', drums: 'mids', other: 'mids',
};

/**
 * Ohne Presigned-PUT reisen die Stems als Base64 in der Job-Antwort. V8-Strings
 * enden bei ca. 512 MB; 5 Stems float32 stereo sind ca. 1,9 MB/s Audio (Base64).
 * Grenze daher bewusst niedrig; darüber verlangt der Pod R2 (klare Meldung).
 */
export const INLINE_MAX_SECONDS = Math.max(30, Number(process.env.STEM_INLINE_MAX_SECONDS ?? 240));
const PRESIGN_TTL_S = 3600;

// ---------------------------------------------------------------------------
// Flotte
// ---------------------------------------------------------------------------
const STEM_TASK: AiTask = 'stem.separate';

/** Kann die Flotte (RP5 bzw. Rolle voiceGen) `stem.separate` gerade annehmen? */
export function rp5StemAvailable(): boolean {
  try {
    return aiOrchestrator.providers.candidates(STEM_TASK).some((p) => p.id !== 'local');
  } catch {
    return false;
  }
}

/** Standard-Ausführung über den Provider-Router (Pod-Modus: Start-Trigger + Warteschlange). */
export const runStemTaskOnFleet: RunStemTask = (model, input, signal) =>
  aiOrchestrator.providers.run(STEM_TASK, model, input, signal);

// ---------------------------------------------------------------------------
// Eingaben
// ---------------------------------------------------------------------------
export interface StemWarpRequest {
  targetBpm?: number;
  targetKey?: string;
  sourceBpm?: number;
  sourceKey?: string;
}

const KEY_RE = /^[A-Ga-g](#|b)?\s*(m|min|minor|moll|maj|major|dur)?$/;

/** Warp-Felder aus dem Multipart-Formular (leer = kein Warp). Wirft bei Unsinn. */
export function parseWarpFields(fields: Record<string, string>): StemWarpRequest | null {
  if ((fields.warp ?? '').trim() === '0') return null;
  const out: StemWarpRequest = {};
  const num = (name: keyof StemWarpRequest) => {
    const raw = (fields[name] ?? '').trim();
    if (!raw) return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 20 || value > 400) throw new StemRequestError(`${name} muss zwischen 20 und 400 BPM liegen`);
    (out as Record<string, number>)[name] = value;
  };
  const key = (name: keyof StemWarpRequest) => {
    const raw = (fields[name] ?? '').trim();
    if (!raw) return;
    if (!KEY_RE.test(raw)) throw new StemRequestError(`${name} unbekannt (z. B. "Am", "C#", "Eb major")`);
    (out as Record<string, string>)[name] = raw;
  };
  num('targetBpm');
  num('sourceBpm');
  key('targetKey');
  key('sourceKey');
  return out.targetBpm !== undefined || out.targetKey !== undefined ? out : null;
}

export class StemRequestError extends Error {
  readonly httpStatus = 400;
  readonly code = 'STEM_INVALID_REQUEST';
}

// ---------------------------------------------------------------------------
// Ablage
// ---------------------------------------------------------------------------
export interface StoredStem {
  url: string;
  storage: 'r2' | 'server';
}

export interface StemStorage {
  /** Presigned-PUT für den Pod; null = kein R2 (dann Base64 an den Server). */
  presignPut(objectKey: string): { putUrl: string; url: string } | null;
  store(objectKey: string, data: Buffer): Promise<StoredStem>;
}

function r2PublicUrl(objectKey: string): string | null {
  const config = r2ConfigFromEnv();
  if (!config.configured || !config.bucket) return null;
  const encodedKey = objectKey.split('/').map((s) => encodeURIComponent(s)).join('/');
  const publicBase = config.publicBaseUrl ? trimTrailingSlash(config.publicBaseUrl) : undefined;
  return publicBase
    ? `${publicBase}/${encodedKey}`
    : `https://${config.bucket}.${config.accountId}.r2.cloudflarestorage.com/${encodedKey}`;
}

/** Ablage wie /api/upload/sample: R2, ohne R2 die Server-Ablage (data/uploads). */
export const defaultStemStorage: StemStorage = {
  presignPut(objectKey) {
    const config = r2ConfigFromEnv();
    if (!config.configured || !config.bucket || !config.endpoint) return null;
    const url = r2PublicUrl(objectKey);
    if (!url) return null;
    const putUrl = presignUrl(
      { endpoint: config.endpoint, bucket: config.bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region },
      'PUT',
      objectKey,
      PRESIGN_TTL_S,
    );
    return { putUrl, url };
  },
  async store(objectKey, data) {
    try {
      const uploaded = await uploadSampleToR2(objectKey, data, 'audio/wav');
      return { url: uploaded.url, storage: 'r2' };
    } catch (e) {
      const writeError = toR2WriteError(e);
      if (writeError.problem !== 'not-configured' && writeError.problem !== 'bucket-missing') throw e;
      logR2Once('stems:server-storage', '[stems] R2 nicht eingerichtet – Stems werden auf dem Server abgelegt (data/uploads).', 'warn');
      const saved = await saveLocalMedia(objectKey, data);
      return { url: saved.url, storage: 'server' };
    }
  },
};

export function safeStemBase(filename: string): string {
  const base = String(filename || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'stem').slice(0, 60);
}

export function stemObjectKey(jobId: string, filename: string, stem: string): string {
  return `uploads/stems/${jobId}-${safeStemBase(filename)}-${stem}.wav`;
}

// ---------------------------------------------------------------------------
// Bibliothek
// ---------------------------------------------------------------------------
export interface StemLibraryEntry {
  id: string;
  key: string;
  name: string;
  category: StemCategory;
  type: 'Stem';
  description: string;
  url: string;
  tags: string[];
}

export type LibraryWriter = (entry: StemLibraryEntry, storage: StoredStem['storage']) => Promise<void>;

/** Server-Bibliothek: lokale Liste (Server-Ablage) bzw. Supabase (R2), best effort. */
export const defaultLibraryWriter: LibraryWriter = async (entry, storage) => {
  const sample = {
    id: entry.id, name: entry.name, category: entry.category, type: entry.type,
    url: entry.url, description: entry.description, tags: entry.tags, parameters: {},
  };
  if (storage === 'server') {
    await addLocalSample({ ...sample, createdAt: new Date().toISOString() });
    return;
  }
  const res = await pushSampleToCloud(sample, { kind: 'stem' });
  if (!res.ok) console.warn('[stems] Bibliothekseintrag (Supabase) nicht geschrieben:', res.error);
};

function libraryEntries(
  jobId: string,
  filename: string,
  urls: Record<string, string>,
  keys: readonly string[],
  label: string,
  tags: string[],
): StemLibraryEntry[] {
  const base = String(filename || '').replace(/\.[^.]+$/, '') || 'stem';
  return keys.filter((k) => urls[k]).map((k) => ({
    id: `stem-${jobId}-${k}`,
    key: k,
    name: `${base}_${k}`,
    category: CATEGORY[k] ?? 'mids',
    type: 'Stem' as const,
    description: `${k}-Stem aus ${filename} (${label})`,
    url: urls[k],
    tags: ['stem', k, ...tags],
  }));
}

async function writeLibrary(entries: StemLibraryEntry[], storage: StoredStem['storage'], writer: LibraryWriter): Promise<boolean> {
  try {
    for (const e of entries) await writer(e, storage);
    return true;
  } catch (err) {
    console.warn('[stems] Bibliothek konnte nicht geschrieben werden:', (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fehler → klare Meldung
// ---------------------------------------------------------------------------
export interface StemFailure {
  httpStatus: number;
  code: string;
  message: string;
  hint?: string;
}

const POD_CODES = /^(NO_PROVIDER|POD_NOT_CONFIGURED|NO_POD_TOKEN|NO_POD_FOR_ROLE|ENDPOINT_NOT_CONFIGURED|NO_KEY|POD_WAKE_.*|AI_.*|KILL.*|CIRCUIT_OPEN|BREAKER_OPEN)$/;

/** Ordnet einen Fehler der Flotte einer ehrlichen Nutzer-Meldung zu. */
export function classifyStemFailure(error: unknown, model: string): StemFailure {
  const code = String((error as { code?: unknown })?.code ?? '');
  const message = error instanceof Error ? error.message : String(error ?? 'unbekannter Fehler');
  if (error instanceof StemRequestError) return { httpStatus: 400, code: error.code, message };
  if (POD_CODES.test(code)) {
    return {
      httpStatus: 503,
      code: 'STEM_POD_UNAVAILABLE',
      message: `stems-Pod (RP5) nicht erreichbar: ${message}`,
      hint: 'RP5 starten (scripts/runpod-pods.py up, RP_POD_ID_STEMS) oder ausdrücklich den 4-Stem-Modus wählen.',
    };
  }
  if (code === 'MODEL_UNAVAILABLE' || code === 'INVALID_MODEL') {
    return {
      httpStatus: 503,
      code: 'STEM_MODEL_UNAVAILABLE',
      message: `${model} ist auf dem stems-Pod nicht ladbar oder lehnt den Auftrag ab (Gewichte nicht gespiegelt, MSST fehlt, Hash falsch, Warp unmöglich oder Datei zu lang für den Weg ohne R2 – Details im Pod-Log).`,
      hint: 'Gewichte spiegeln: python3 scripts/weights-mirror.py --yes --only stems (docs/WEIGHTS_MIRROR_PLAN.md).',
    };
  }
  if (code === 'CANCELLED') return { httpStatus: 499, code: 'STEM_CANCELLED', message: 'Trennung abgebrochen.' };
  return { httpStatus: 502, code: 'STEM_SEPARATION_FAILED', message: `Stem-Trennung auf RP5 fehlgeschlagen: ${message}` };
}

// ---------------------------------------------------------------------------
// RP5-Lauf
// ---------------------------------------------------------------------------
export type RunStemTask = (model: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<{ provider: string; result: unknown }>;

export interface Rp5Deps {
  runTask: RunStemTask;
  storage?: StemStorage;
  writeLibrary?: LibraryWriter;
  newJobId?: () => string;
}

export interface StemSuccess {
  status: 'success';
  provider: 'rp5';
  mode: '5stem';
  model: string;
  stemSet: string[];
  stems: Record<string, string>;
  melodyAvailable: boolean;
  notes: string[];
  sampleRate?: number;
  residualDb?: number;
  warp?: Record<string, unknown>;
  storage: StoredStem['storage'];
  library: StemLibraryEntry[];
  librarySaved: boolean;
}

interface Rp5Result {
  stems?: Record<string, string>;
  stemsUploaded?: string[];
  stemSet?: string[];
  melodyAvailable?: boolean;
  notes?: string[];
  sampleRate?: number;
  residualDb?: number;
  warp?: Record<string, unknown>;
}

function newJobIdDefault(): string {
  return `${Date.now().toString(36)}${random().toString(36).slice(2, 7)}`;
}

/** Worker-Hülle ({status, result}) oder direktes Ergebnis. */
function unwrapResult(raw: unknown): Rp5Result {
  const obj = (raw ?? {}) as { result?: unknown; status?: string };
  const inner = obj && typeof obj === 'object' && 'result' in obj && obj.result && typeof obj.result === 'object' ? obj.result : obj;
  return inner as Rp5Result;
}

export async function separateOnRp5(
  file: { data: Buffer; filename: string },
  options: { model?: string; warp?: StemWarpRequest | null; signal?: AbortSignal },
  deps: Rp5Deps,
): Promise<StemSuccess> {
  const model = options.model && RP5_STEM_MODELS.has(options.model) ? options.model : RP5_STEM_MODEL;
  const storage = deps.storage ?? defaultStemStorage;
  const writer = deps.writeLibrary ?? defaultLibraryWriter;
  const jobId = (deps.newJobId ?? newJobIdDefault)();

  const keys = Object.fromEntries(FIVE_STEM_KEYS.map((k) => [k, stemObjectKey(jobId, file.filename, k)]));
  const presigned = Object.fromEntries(FIVE_STEM_KEYS.map((k) => [k, storage.presignPut(keys[k])]));
  const direct = FIVE_STEM_KEYS.every((k) => presigned[k]);

  const input: Record<string, unknown> = {
    audio: file.data.toString('base64'),
    filename: file.filename,
    sampleFormat: 'float',
  };
  if (direct) input.outputUrls = Object.fromEntries(FIVE_STEM_KEYS.map((k) => [k, presigned[k]!.putUrl]));
  else input.inlineMaxSeconds = INLINE_MAX_SECONDS;
  if (options.warp) input.warp = options.warp;

  const { result } = await deps.runTask(model, input, options.signal);
  const out = unwrapResult(result);

  const urls: Record<string, string> = {};
  let kind: StoredStem['storage'] = 'r2';
  if (direct) {
    const uploaded = new Set(out.stemsUploaded ?? []);
    const missing = FIVE_STEM_KEYS.filter((k) => !uploaded.has(k));
    if (missing.length) throw new Error(`Pod meldet keine Ablage für ${missing.join(', ')}`);
    for (const k of FIVE_STEM_KEYS) urls[k] = presigned[k]!.url;
  } else {
    const inline = out.stems ?? {};
    for (const k of FIVE_STEM_KEYS) {
      const b64 = inline[k];
      if (typeof b64 !== 'string' || !b64) throw new Error(`Pod-Antwort ohne Stem ${k}`);
      const stored = await storage.store(keys[k], Buffer.from(b64, 'base64'));
      urls[k] = stored.url;
      kind = stored.storage;
    }
  }

  const melodyAvailable = out.melodyAvailable !== false;
  // Leere Melodie (4-Stem-Fallback) kommt nicht in die Bibliothek.
  const libKeys = FIVE_STEM_KEYS.filter((k) => melodyAvailable || k !== 'melody');
  const label = melodyAvailable ? `RP5 ${model}` : `RP5 ${model}, 4-Stem-Fallback, Melodie leer`;
  const tags = options.warp ? ['warped'] : [];
  const library = libraryEntries(jobId, file.filename, urls, libKeys, label, tags);
  const librarySaved = await writeLibrary(library, kind, writer);

  return {
    status: 'success',
    provider: 'rp5',
    mode: '5stem',
    model,
    stemSet: [...FIVE_STEM_KEYS],
    stems: urls,
    melodyAvailable,
    notes: Array.isArray(out.notes) ? out.notes.map(String) : [],
    sampleRate: out.sampleRate,
    residualDb: out.residualDb,
    warp: out.warp,
    storage: kind,
    library,
    librarySaved,
  };
}

// ---------------------------------------------------------------------------
// 4-Stem-Modus (stem-ai/htdemucs) – nur auf ausdrücklichen Wunsch
// ---------------------------------------------------------------------------
export interface FourStemSuccess {
  status: 'success';
  provider: 'stem-ai';
  mode: '4stem';
  model: string;
  stemSet: string[];
  stems: Record<string, string>;
  melodyAvailable: false;
  notes: string[];
  storage: StoredStem['storage'];
  library: StemLibraryEntry[];
  librarySaved: boolean;
}

/**
 * Übernimmt eine stem-ai-Antwort ({stems: {vocals: '/stem-file/..'}}): lädt jede
 * Datei vom Dienst, legt sie in der Ablage ab und gibt Server-URLs zurück. Die
 * stem-ai-URLs selbst sind vom Browser aus nicht erreichbar (interner Dienst).
 */
export async function ingestFourStems(
  baseUrl: string,
  data: { stems?: Record<string, string>; model?: string },
  filename: string,
  deps: { fetchFn?: typeof fetch; storage?: StemStorage; writeLibrary?: LibraryWriter; newJobId?: () => string; signal?: AbortSignal } = {},
): Promise<FourStemSuccess> {
  const fetchFn = deps.fetchFn ?? fetch;
  const storage = deps.storage ?? defaultStemStorage;
  const jobId = (deps.newJobId ?? newJobIdDefault)();
  const urls: Record<string, string> = {};
  let kind: StoredStem['storage'] = 'r2';
  for (const k of FOUR_STEM_KEYS) {
    const rel = data.stems?.[k];
    if (typeof rel !== 'string' || !rel.startsWith('/stem-file/')) continue;
    const resp = await fetchFn(baseUrl.replace(/\/+$/, '') + rel, { signal: deps.signal });
    if (!resp.ok) throw new Error(`stem-ai liefert ${k} nicht (HTTP ${resp.status})`);
    const stored = await storage.store(stemObjectKey(jobId, filename, k), Buffer.from(await resp.arrayBuffer()));
    urls[k] = stored.url;
    kind = stored.storage;
  }
  if (Object.keys(urls).length === 0) throw new Error('stem-ai lieferte keine Stems');
  const model = data.model || 'htdemucs';
  const library = libraryEntries(jobId, filename, urls, FOUR_STEM_KEYS, `4-Stem-Modus ${model}`, ['4stem']);
  const librarySaved = await writeLibrary(library, kind, deps.writeLibrary ?? defaultLibraryWriter);
  return {
    status: 'success',
    provider: 'stem-ai',
    mode: '4stem',
    model,
    stemSet: FOUR_STEM_KEYS.filter((k) => urls[k]),
    stems: urls,
    melodyAvailable: false,
    notes: [`4-Stem-Modus (${model}): Gesang, Bass, Drums, Rest – keine Melodie-, Mitten- oder Höhen-Trennung.`],
    storage: kind,
    library,
    librarySaved,
  };
}
