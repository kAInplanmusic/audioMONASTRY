/**
 * audioMONASTRY · VisualMONK – Ablage der generierten Medien
 * ==========================================================
 * Bilder, Clips und zusammengeführte Shows müssen **dauerhaft erreichbar**
 * sein — für die Show selbst, für den Link in der UI und für das erneute
 * Zusammenführen. Primär geht alles nach **R2** (öffentliche URL). Ist R2 nicht
 * konfiguriert oder die Keys sind ungültig, wird das Medium **lokal** abgelegt
 * und über `/api/ai/vision/artifact/<name>` ausgeliefert.
 *
 * Warum der Fallback: am 2026-09-11 live gemessen — die R2-S3-Keys in der
 * Umgebung antworten mit `SignatureDoesNotMatch` (abgelaufen/rotiert). Ohne
 * Fallback wäre die ganze Video-Kette daran blockiert, obwohl sie mit dem
 * Ergebnis nichts zu tun hat.
 *
 * Ehrlichkeit statt stiller Ersatz: der Aufrufer erfährt über `store`, wo das
 * Medium wirklich liegt (`r2` oder `local`).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadSampleToR2 } from './cloud.ts';

type ArtifactStore = 'r2' | 'local';

export interface StoredArtifact {
  /** Objekt-Key (R2) bzw. flachgelegter Name (lokal). */
  key: string;
  url: string;
  store: ArtifactStore;
  bytes: number;
  contentType: string;
  /** Grund, wenn auf lokal ausgewichen wurde (für Log/Diagnose). */
  note?: string;
}

const EXT_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** Content-Type aus der Endung — `null` = Endung nicht erlaubt. */
export function contentTypeForArtifact(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXT_CONTENT_TYPE[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Strenger Name für die lokale Ablage: kein Pfad, keine `..`, bekannte Endung.
 * Der Name wird ausserdem selbst erzeugt (flachgelegter Objekt-Key).
 */
export function isSafeArtifactName(name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name)) return false;
  if (name.includes('..')) return false;
  return contentTypeForArtifact(name) !== null;
}

/** Verzeichnis der lokalen Ablage (Default: Temp — bewusst nicht im Repo). */
function artifactDir(): string {
  const configured = (process.env.VISION_ARTIFACT_DIR || '').trim();
  return configured || path.join(os.tmpdir(), 'audiomonastry-vision');
}

/** Objekt-Key → flacher Dateiname (Endung bleibt erhalten). */
export function flattenArtifactName(objectKey: string): string {
  const flat = objectKey
    .split('/')
    .filter(Boolean)
    .join('__')
    .replace(/[^A-Za-z0-9._-]/g, '-');
  if (flat.length <= 120) return flat;
  const dot = flat.lastIndexOf('.');
  const ext = dot > 0 ? flat.slice(dot) : '';
  return `${flat.slice(0, 120 - ext.length)}${ext}`;
}

/** Nach einem echten R2-Fehler nicht jede Anfrage erneut warten lassen. */
const R2_RETRY_AFTER_MS = 10 * 60 * 1000;
let r2BlockedUntil = 0;

/**
 * Legt ein Medium ab: erst R2, sonst lokal. Wirft nur, wenn beides scheitert.
 *
 * Nach einem echten R2-Fehler wird R2 für kurze Zeit **nicht** erneut versucht —
 * sonst kostet jede Ablage 1–2 s Wartezeit (live gesehen bei ungültigen Keys).
 */
export async function saveArtifact(objectKey: string, body: Buffer, contentType: string): Promise<StoredArtifact> {
  let note: string | undefined;
  if (Date.now() >= r2BlockedUntil) {
    try {
      const up = await uploadSampleToR2(objectKey, body, contentType);
      return { key: objectKey, url: up.url, store: 'r2', bytes: body.length, contentType };
    } catch (e) {
      note = String((e as Error)?.message ?? e).slice(0, 160);
      r2BlockedUntil = Date.now() + R2_RETRY_AFTER_MS;
    }
  } else {
    note = 'R2 zuletzt fehlgeschlagen – erneuter Versuch wird aufgeschoben';
  }

  const name = flattenArtifactName(objectKey);
  if (!isSafeArtifactName(name)) {
    throw new Error(`Artefakt-Name unzulaessig: ${name.slice(0, 60)}`);
  }
  const dir = artifactDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), body);
  return {
    key: name,
    url: `/api/ai/vision/artifact/${encodeURIComponent(name)}`,
    store: 'local',
    bytes: body.length,
    contentType,
    note,
  };
}

/** Nur für Tests/Diagnose: R2-Sperre aufheben. */
export function resetR2Block(): void {
  r2BlockedUntil = 0;
}

/** Nur für Diagnose: ist R2 gerade gesperrt? */
export function r2Blocked(): boolean {
  return Date.now() < r2BlockedUntil;
}

/** data-URI → Buffer (base64 **und** URL-kodiert). `null` = kein data-URI. */
export function dataUriToBuffer(dataUri: string): Buffer | null {
  const s = String(dataUri ?? '');
  const match = /^data:([^;,]*)(;base64)?,/.exec(s);
  if (!match) return null;
  const payload = s.slice(match[0].length);
  try {
    return match[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Speichert einen data-URI als Artefakt. Liefert `null`, wenn der data-URI
 * unbrauchbar ist (dann bleibt der Aufrufer beim data-URI im Response).
 */
export async function persistDataUri(
  dataUri: string,
  opts: { keyPrefix: string; ext: string },
): Promise<StoredArtifact | null> {
  const buf = dataUriToBuffer(dataUri);
  if (!buf || buf.length === 0) return null;
  const contentType = contentTypeForArtifact(`x.${opts.ext}`) ?? 'application/octet-stream';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(3).toString('hex');
  return saveArtifact(`${opts.keyPrefix}/${stamp}-${rand}.${opts.ext}`, buf, contentType);
}

/** Liest ein lokal abgelegtes Artefakt (nur validierte Namen). */
export async function readArtifact(name: string): Promise<Buffer | null> {
  if (!isSafeArtifactName(name)) return null;
  try {
    return await readFile(path.join(artifactDir(), name));
  } catch {
    return null;
  }
}
