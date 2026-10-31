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
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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

/** Nur einfache Dateinamen – kein Pfad, keine Steuerzeichen. */
export function safeMediaName(name: string): string | null {
  const base = String(name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,150}$/i.test(base) || base.includes('..') || base === INDEX_FILE) return null;
  return base;
}

export function mediaUrlFor(fileName: string): string {
  return `/api/media/uploads/${encodeURIComponent(fileName)}`;
}

/** Legt die Datei ab und liefert die Abruf-Adresse. */
export async function saveLocalMedia(objectKey: string, data: Buffer | Uint8Array): Promise<{ url: string; fileName: string }> {
  const fileName = safeMediaName(objectKey.split('/').pop() ?? '');
  if (!fileName) throw new Error('ungültiger Dateiname');
  const dir = mediaDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), data);
  return { url: mediaUrlFor(fileName), fileName };
}

async function readIndex(dir: string): Promise<LocalSampleEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, INDEX_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const list: unknown = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error('Ungültiger Medienindex');
  return list as LocalSampleEntry[];
}

export async function listLocalSamples(): Promise<LocalSampleEntry[]> {
  try {
    return await readIndex(mediaDir());
  } catch {
    return [];
  }
}

// Serialisiert nur innerhalb dieser Modulinstanz. Mehrere Prozesse, Worker oder
// Instanzen duerfen nicht dasselbe Verzeichnis beschreiben: rename allein ist
// kein prozessuebergreifender Read-Modify-Write-Lock.
let indexQueue: Promise<void> = Promise.resolve();

/** Eintrag in die Bibliotheksliste (neueste zuletzt, gleiche ID ersetzt). */
export async function addLocalSample(entry: LocalSampleEntry): Promise<void> {
  const dir = mediaDir();
  const operation = indexQueue.then(async () => {
    const list = (await readIndex(dir)).filter((e) => e.id !== entry.id);
    list.push(entry);
    await mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.index-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(list, null, 2), { flag: 'wx' });
      await rename(temp, path.join(dir, INDEX_FILE));
    } finally {
      await rm(temp, { force: true });
    }
  });
  indexQueue = operation.catch(() => {});
  return operation;
}

export async function readLocalMedia(fileName: string): Promise<Buffer | null> {
  const safe = safeMediaName(fileName);
  if (!safe) return null;
  try {
    return await readFile(path.join(mediaDir(), safe));
  } catch {
    return null;
  }
}
