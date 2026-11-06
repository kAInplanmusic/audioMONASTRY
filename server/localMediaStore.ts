/**
 * Server-Ablage für Audio (Betreiber 2026-10-06)
 * ==============================================
 * „NICHTS wird auf den Geräten der Nutzer gespeichert. Keine Sounds, keine
 * Audio, nichts." Früher landete ein Upload ohne Cloud-Ablage (R2) im Browser
 * des Nutzers (OPFS). Jetzt legt der SERVER die Datei selbst ab, wenn R2 nicht
 * eingerichtet ist, und führt eine Liste für die Bibliothek aller Nutzer.
 *
 *   Ablage:  AUDIOMONASTRY_MEDIA_DIR (Standard: data/uploads)
 *   Abruf:   GET /api/media/uploads/<datei>   (Studio-Token, no-store)
 *   Liste:   GET /api/library/uploads
 *
 * INFRA-2026-11-06-001 (P1) – zwei Befunde, ein Modul:
 *
 *   1. VERLORENE EINTRAEGE. `addLocalSample` war ein ungeschütztes
 *      Read-Modify-Write auf `index.json` (lesen, filtern, push, writeFile).
 *      Gemessen: 40 gleichzeitige Aufrufe -> 1 Eintrag, 39 still verloren,
 *      0 Fehler; ein Reader traf in 382 von 400 Reads einen halb
 *      geschriebenen Index. Fix: In-Process-Queue serialisiert das
 *      Read-Modify-Write, geschrieben wird atomar (Temp-Datei + fsync +
 *      rename + fsync des Verzeichnisses). Ein Reader sieht damit entweder
 *      den alten oder den neuen vollständigen Index, nie einen Torso.
 *
 *   2. STILLE LEERE BIBLIOTHEK. `listLocalSamples` verschluckte JEDEN Fehler
 *      und lieferte `[]` – ein kaputter oder unlesbarer Index sah aus wie
 *      „keine Uploads". Ebenso warf `saveLocalMedia` bei `EACCES` (read-only
 *      Container ohne Volume, docker-compose.hetzner.yml) einen rohen
 *      Errno-Fehler, den die Upload-Route als `502 r2-write-failed`
 *      fehletikettierte. Fix: `LocalStorageError` mit stabilem
 *      Problem-Code + Hinweis + Pfad; nur `ENOENT` (noch keine Datei) gilt
 *      als legitime leere Liste.
 *
 * GRENZE (bewusst dokumentiert): die Serialisierung ist IN-PROCESS. Sie deckt
 * genau den Fall „viele gleichzeitige Requests in EINEM Node-Prozess" (das ist
 * die Aufstellung: ein `audiomonastry`-Container je Knoten). Mehrere Prozesse
 * oder mehrere Replikate auf demselben Verzeichnis brauchen einen
 * Datei-/Advisory-Lock (z. B. `flock` auf `index.lock`) – der ist hier NICHT
 * implementiert. Wer die App horizontal skaliert, muss entweder auf R2 +
 * Supabase umstellen (dann greift dieser Store nicht) oder den Lock ergänzen.
 */
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface LocalSampleEntry {
  id: string;
  name: string;
  category: string;
  type: string;
  url: string;
  description: string;
  tags: string[];
  parameters: Record<string, unknown>;
  createdAt: string;
}

export function mediaDir(): string {
  return path.resolve(process.env.AUDIOMONASTRY_MEDIA_DIR || path.join(process.cwd(), 'data', 'uploads'));
}

const INDEX_FILE = 'index.json';

// ---------------------------------------------------------------------------
// Fehler (INFRA-2026-11-06-001, Punkt 3)
// ---------------------------------------------------------------------------

/** Stabile Problem-Codes der Server-Ablage (Grundlage für HTTP-Antwort und Log). */
export type LocalStorageProblem =
  /** Verzeichnis existiert nicht / ist nicht beschreibbar (EACCES, EROFS, read-only Container). */
  | 'dir-unwritable'
  /** `index.json` existiert, ist aber kein gültiges JSON bzw. keine Liste. */
  | 'index-corrupt'
  /** Datei/Verzeichnis vorhanden, aber nicht lesbar (Rechte, IO). */
  | 'read-failed'
  /** Schreiben der Datei/des Index ist fehlgeschlagen (Platte voll, Rechte, IO). */
  | 'write-failed'
  /** Dateiname nicht erlaubt (Pfadanteile/Steuerzeichen). */
  | 'invalid-name';

/** Fehlercode, den die API nach außen gibt – nie `r2-write-failed` für lokale Ablage. */
export const LOCAL_STORAGE_ERROR_CODE = 'local-storage-unavailable';

function describeCause(cause: unknown): string {
  if (!cause) return 'unbekannter Fehler';
  const e = cause as NodeJS.ErrnoException;
  const message = e.message ?? String(cause);
  const code = typeof e.code === 'string' && !message.startsWith(`${e.code}:`) ? `${e.code}: ` : '';
  return `${code}${message}`;
}

/** Reparatur-Hinweis je Problem – landet im Log UND im HTTP-Body. */
export function localStorageProblemHint(problem: LocalStorageProblem): string {
  switch (problem) {
    case 'dir-unwritable':
      return 'AUDIOMONASTRY_MEDIA_DIR prüfen. Im Container läuft die App als `node` mit `read_only: true`; '
        + '/app/data/uploads muss deshalb ein beschreibbares, benanntes Volume sein (docker-compose.hetzner.yml, '
        + 'Service `audiomonastry`) und dem Benutzer `node` (UID 1000) gehören. Ohne R2-Konfiguration ist diese '
        + 'Ablage der einzige Ort für Uploads.';
    case 'index-corrupt':
      return 'index.json ist kein gültiges JSON. Die Datei wird NICHT automatisch überschrieben – sichern/prüfen '
        + 'und erst dann ersetzen (z. B. `[]`), damit keine Einträge still verloren gehen.';
    case 'read-failed':
      return 'Leserechte/Dateisystem der Server-Ablage prüfen (Eigentümer `node`, Rechte mindestens r-x).';
    case 'write-failed':
      return 'Schreibrechte, freien Platz und Dateisystem der Server-Ablage prüfen.';
    case 'invalid-name':
      return 'Der Dateiname muss ein einfacher Name sein (a-z, 0-9, . _ -, kein Pfad, kein `..`).';
    default:
      return 'Server-Ablage prüfen.';
  }
}

/**
 * Klarer lokaler Fehler der Server-Ablage.
 *
 * Ersetzt das frühere „still `[]`" bzw. den rohen Errno-Fehler, den die
 * Upload-Route als R2-Fehler fehletikettierte. Trägt Problem-Code, Pfad,
 * Ursache und Reparatur-Hinweis.
 */
export class LocalStorageError extends Error {
  readonly code = LOCAL_STORAGE_ERROR_CODE;
  readonly problem: LocalStorageProblem;
  readonly mediaDir: string;
  readonly hint: string;
  override readonly cause?: unknown;

  constructor(problem: LocalStorageProblem, detail: string, mediaDir: string, cause?: unknown) {
    const hint = localStorageProblemHint(problem);
    super(`Server-Ablage [${problem}]: ${detail} (${mediaDir}). ${hint}`);
    this.name = 'LocalStorageError';
    this.problem = problem;
    this.mediaDir = mediaDir;
    this.hint = hint;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Nur einfache Dateinamen – kein Pfad, keine Steuerzeichen. */
export function safeMediaName(name: string): string | null {
  const base = String(name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,150}$/i.test(base) || base.includes('..') || base === INDEX_FILE) return null;
  return base;
}

export function mediaUrlFor(fileName: string): string {
  return `/api/media/uploads/${encodeURIComponent(fileName)}`;
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Problem für einen fehlgeschlagenen Schreibzugriff: Rechte/RO-Dateisystem vs. sonstiges. */
function writeProblem(error: unknown): LocalStorageProblem {
  const code = errnoCode(error);
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOTDIR' ? 'dir-unwritable' : 'write-failed';
}

async function ensureMediaDir(): Promise<string> {
  const dir = mediaDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new LocalStorageError('dir-unwritable', `Verzeichnis nicht anlegbar (${describeCause(error)})`, dir, error);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Schreib-Serialisierung (nur In-Process, siehe Modul-Kommentar „GRENZE")
// ---------------------------------------------------------------------------

let indexTail: Promise<void> = Promise.resolve();

/**
 * Serialisiert Index-Operationen hintereinander.
 *
 * `then(work, work)`: Ein FEHLGESCHLAGENER Vorgänger darf die Queue nicht
 * blockieren – der nächste Aufruf läuft trotzdem (und scheitert ggf. mit
 * eigenem Fehler). Der Rejection-Pfad wird separat abgefangen, damit kein
 * unbehandelter Rejection entsteht.
 */
function withIndexLock<T>(work: () => Promise<T>): Promise<T> {
  const run = indexTail.then(work, work);
  indexTail = run.then(() => undefined, () => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Index lesen (Fehler NICHT mehr als [] maskieren)
// ---------------------------------------------------------------------------

async function readIndex(dir: string): Promise<LocalSampleEntry[]> {
  const file = path.join(dir, INDEX_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    // ENOENT = Erststart bzw. noch kein Upload: die EINZIGE legitime leere Liste.
    if (errnoCode(error) === 'ENOENT') return [];
    throw new LocalStorageError('read-failed', `Index nicht lesbar: ${describeCause(error)}`, dir, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LocalStorageError(
      'index-corrupt',
      `Index ist kein gültiges JSON (${raw.length} Bytes): ${describeCause(error)}`,
      dir,
      error,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new LocalStorageError('index-corrupt', `Index ist eine ${typeof parsed}, keine Liste`, dir);
  }
  // Kein stilles Wegfiltern: ein Eintrag ohne String-ID ist ein Datenfehler,
  // kein „unbrauchbarer Eintrag", den man verschweigen dürfte.
  const broken = parsed.findIndex((e) => typeof e !== 'object' || e === null || typeof (e as LocalSampleEntry).id !== 'string');
  if (broken >= 0) {
    throw new LocalStorageError('index-corrupt', `Index-Eintrag ${broken} hat keine String-ID`, dir);
  }
  return parsed as LocalSampleEntry[];
}

/** Liest die Bibliotheksliste. Wirft `LocalStorageError` statt still `[]`. */
export async function listLocalSamples(): Promise<LocalSampleEntry[]> {
  return readIndex(mediaDir());
}

// ---------------------------------------------------------------------------
// Index atomar schreiben: Temp-Datei + fsync + rename + Verzeichnis-fsync
// ---------------------------------------------------------------------------

async function writeIndexAtomic(dir: string, list: LocalSampleEntry[]): Promise<void> {
  const file = path.join(dir, INDEX_FILE);
  // Der Punkt am Anfang hält den Namen aus `safeMediaName` heraus – eine
  // halb geschriebene Temp-Datei ist damit nie über /api/media/uploads
  // abrufbar und kollidiert nie mit einem echten Upload.
  const tmp = path.join(dir, `.${INDEX_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'w');
    await handle.writeFile(JSON.stringify(list, null, 2), 'utf8');
    // fsync VOR dem rename: sonst kann der rename nach einem Crash auf einen
    // leeren/alten Inode zeigen.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, file);
    await syncDirectory(dir);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw new LocalStorageError(writeProblem(error), `Index nicht schreibbar: ${describeCause(error)}`, dir, error);
  }
}

/** fsync auf das Verzeichnis, damit der rename selbst dauerhaft ist. */
async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Nicht jede Plattform erlaubt fsync auf einem Verzeichnis; der atomare
    // rename bleibt trotzdem wirksam (nur die Crash-Dauerhaftigkeit ist
    // plattformabhängig).
  } finally {
    await handle?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Öffentliche Ablage-Operationen
// ---------------------------------------------------------------------------

/** Legt die Datei ab und liefert die Abruf-Adresse. */
export async function saveLocalMedia(objectKey: string, data: Buffer | Uint8Array): Promise<{ url: string; fileName: string }> {
  const fileName = safeMediaName(objectKey.split('/').pop() ?? '');
  if (!fileName) throw new LocalStorageError('invalid-name', `ungültiger Dateiname: ${objectKey}`, mediaDir());
  const dir = await ensureMediaDir();
  try {
    await writeFile(path.join(dir, fileName), data);
  } catch (error) {
    throw new LocalStorageError(writeProblem(error), `Datei nicht schreibbar: ${describeCause(error)}`, dir, error);
  }
  return { url: mediaUrlFor(fileName), fileName };
}

/** Eintrag in die Bibliotheksliste (neueste zuletzt, gleiche ID ersetzt). */
export async function addLocalSample(entry: LocalSampleEntry): Promise<void> {
  await withIndexLock(async () => {
    const dir = await ensureMediaDir();
    // Lesen INNERHALB des Locks: sonst überschreibt der nächste Schreiber die
    // Änderung des vorigen (genau der gemessene 39-von-40-Verlust).
    const list = (await readIndex(dir)).filter((e) => e.id !== entry.id);
    list.push(entry);
    await writeIndexAtomic(dir, list);
  });
}

export async function readLocalMedia(fileName: string): Promise<Buffer | null> {
  const safe = safeMediaName(fileName);
  if (!safe) return null;
  const dir = mediaDir();
  try {
    return await readFile(path.join(dir, safe));
  } catch (error) {
    // Fehlende Datei = 404; unlesbare Ablage = klarer Fehler, kein 404.
    if (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR') return null;
    throw new LocalStorageError('read-failed', `Datei nicht lesbar: ${describeCause(error)}`, dir, error);
  }
}

// ---------------------------------------------------------------------------
// Health-/Startup-Check (W_OK) – Signatur „Ablage nicht beschreibbar"
// ---------------------------------------------------------------------------

export interface LocalStorageHealth {
  ok: boolean;
  writable: boolean;
  dir: string;
  problem: LocalStorageProblem | null;
  message: string | null;
  hint: string | null;
  checkedAt: number;
}

/**
 * Prüft die Ablage REAL: Verzeichnis anlegen und eine Probe-Datei schreiben.
 * `access(W_OK)` allein lügt auf read-only Dateisystemen und bei vollen
 * Platten; der Schreibversuch ist der einzige belastbare Test.
 *
 * Gedacht für den Start (Log) und als Health-Signal in `GET /api/library/uploads`.
 * Wirft nie – liefert das Ergebnis als Objekt.
 *
 * `maxAgeMs` > 0 erlaubt einen kurzen Cache (die Route fragt pro Request, der
 * Start fragt immer frisch).
 */
let healthCache: { at: number; value: LocalStorageHealth } | null = null;

export async function localMediaStorageHealth(options: { maxAgeMs?: number } = {}): Promise<LocalStorageHealth> {
  const maxAgeMs = options.maxAgeMs ?? 0;
  if (maxAgeMs > 0 && healthCache && Date.now() - healthCache.at < maxAgeMs) return healthCache.value;

  const dir = mediaDir();
  const base = { dir, checkedAt: Date.now() };
  const probe = path.join(dir, `.health-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  let value: LocalStorageHealth;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe).catch(() => {});
    value = { ...base, ok: true, writable: true, problem: null, message: null, hint: null };
  } catch (error) {
    await unlink(probe).catch(() => {});
    const problem = writeProblem(error);
    value = {
      ...base,
      ok: false,
      writable: false,
      problem,
      message: `Server-Ablage nicht beschreibbar: ${describeCause(error)} (${dir}). ${localStorageProblemHint(problem)}`,
      hint: localStorageProblemHint(problem),
    };
  }
  healthCache = { at: value.checkedAt, value };
  return value;
}

/**
 * Startup-Check: wirft `LocalStorageError`, wenn die Ablage nicht beschreibbar
 * ist. Bewusst NICHT beim Import aufgerufen (Seiteneffekt beim Test-Import),
 * sondern aus dem Bootstrap bzw. `registerUploadRoutes`.
 */
export async function assertLocalMediaWritable(): Promise<LocalStorageHealth> {
  const health = await localMediaStorageHealth();
  if (!health.ok) {
    throw new LocalStorageError(health.problem ?? 'dir-unwritable', health.message ?? 'nicht beschreibbar', health.dir);
  }
  return health;
}
