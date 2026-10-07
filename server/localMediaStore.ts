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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export async function listLocalSamples(): Promise<LocalSampleEntry[]> {
  try {
    const raw = await readFile(path.join(mediaDir(), INDEX_FILE), 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as LocalSampleEntry[]) : [];
  } catch {
    return [];
  }
}

/** Eintrag in die Bibliotheksliste (neueste zuletzt, gleiche ID ersetzt). */
export async function addLocalSample(entry: LocalSampleEntry): Promise<void> {
  const list = (await listLocalSamples()).filter((e) => e.id !== entry.id);
  list.push(entry);
  await mkdir(mediaDir(), { recursive: true });
  await writeFile(path.join(mediaDir(), INDEX_FILE), JSON.stringify(list, null, 2));
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
