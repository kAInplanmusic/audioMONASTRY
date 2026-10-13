/**
 * recordMONK · Aufnahme als WAV herunterladen (STORE-P1-001)
 * ===========================================================
 * Ausnahme „recordMONK-Aufnahmen" (AGENTS.md §2.2): nur per Nutzeraktion.
 * Das Audio kommt vom SERVER (Bibliothek / Session-Store), nie aus einer
 * Gerätekopie: der Take muss hochgeladen sein, gelesen wird mit
 * `cache: 'no-store'`. WAV läuft bit-identisch durch; andere Aufnahmeformate
 * (WebM/Opus) werden einmal decodiert und als WAV kodiert. Gespeichert wird
 * über src/utils/userExport.ts (Nutzerwahl bzw. Download, Blob-URL wird
 * sofort freigegeben).
 */
import { encodeWavFromAudioBuffer } from './wavEncode';
import { saveBlobToUserFile, WAV_FILE_TYPE, type UserSaveResult } from './userExport';

export class RecordingDownloadError extends Error {
  constructor(public readonly code: 'NOT_ON_SERVER' | 'FETCH_FAILED' | 'DECODE_FAILED', message: string) {
    super(message);
    this.name = 'RecordingDownloadError';
  }
}

export interface RecordingDownloadDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>;
  save: (blob: Blob, fileName: string) => Promise<UserSaveResult>;
}

/** Nur Server-Adressen sind Quelle für den Download (keine `blob:`/`data:`-Kopien). */
export function isServerAudioUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  return !/^(blob|data|filesystem):/i.test(url);
}

/** Endung auf `.wav` setzen, Pfad-/Sonderzeichen entfernen. */
export function wavFileName(name: string): string {
  const base = String(name ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return `${base || 'recordMONK-take'}.wav`;
}

/** RIFF/WAVE-Kopf? */
export function isWavBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

/** Lädt den Take vom Server und speichert ihn als WAV-Datei (Nutzeraktion). */
export async function downloadRecordingAsWav(url: string | undefined | null, name: string, deps: RecordingDownloadDeps): Promise<UserSaveResult> {
  if (!isServerAudioUrl(url)) {
    throw new RecordingDownloadError('NOT_ON_SERVER', 'Aufnahme ist noch nicht auf dem Server.');
  }
  let data: ArrayBuffer;
  try {
    const res = await deps.fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.arrayBuffer();
  } catch (e) {
    throw new RecordingDownloadError('FETCH_FAILED', `Server-Abruf fehlgeschlagen: ${(e as Error).message}`);
  }
  let wav: Blob;
  if (isWavBytes(new Uint8Array(data, 0, Math.min(12, data.byteLength)))) {
    wav = new Blob([data], { type: 'audio/wav' });
  } else {
    try {
      wav = encodeWavFromAudioBuffer(await deps.decode(data));
    } catch (e) {
      throw new RecordingDownloadError('DECODE_FAILED', `Aufnahme nicht lesbar: ${(e as Error).message}`);
    }
  }
  return deps.save(wav, wavFileName(name));
}

/** Standard-Abhängigkeiten im Browser (Speichern über userExport.ts). */
export function browserRecordingDownloadDeps(decode: RecordingDownloadDeps['decode']): RecordingDownloadDeps {
  return {
    fetch: (u, init) => fetch(u, init),
    decode,
    save: (blob, fileName) => saveBlobToUserFile(blob, fileName, WAV_FILE_TYPE),
  };
}
