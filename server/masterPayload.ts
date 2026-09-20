/**
 * audioMONASTRY · server-seitige Master-Payload-Prüfung (FIX F3)
 * =============================================================
 * Ergänzt `src/types/masterPayload.ts` (Grenzen, Klartext, Antwortform) um das,
 * was nur auf dem Server möglich ist: die Messwerte aus dem echten Body ziehen,
 * ohne die 30-MB-Base64-Strings zu dekodieren.
 *
 *   * `decodedBase64Bytes` rechnet die dekodierte Länge aus (O(1), reine
 *     Zeichenarithmetik) – nötig, um eine WAV-Dauer gegen die tatsächliche
 *     Dateigröße abzugleichen.
 *   * `wavDurationSeconds` liest NUR den RIFF-Kopf (erste 6 kB) und rechnet
 *     `data`-Größe / `byteRate`. Damit fällt eine zu lange Spur auf, BEVOR
 *     ~25 MB durch den Proxy und im Dienst durch FFmpeg laufen.
 *
 * BEWUSSTE GRENZE: Die Dauer ist nur für unkomprimierte RIFF/WAVE-Dateien
 * bestimmbar – bei mp3/flac/ogg ist die Spielzeit ohne Decode nicht bekannt.
 * Dort meldet die Prüfung `longestTrackSeconds: null` und der Dienst entscheidet
 * (er misst nach dem Decode und antwortet 400 „Audio zu lang"). Es wird also nie
 * eine Dauer ERFUNDEN; lieber keine Zahl als eine falsche.
 */
import {
  MASTER_PAYLOAD_LIMITS,
  describeMasterPayloadViolation,
  masterTrackEntries,
  type MasterPayloadFacts,
  type MasterPayloadLimits,
  type MasterPayloadViolation,
} from '../src/types/masterPayload';

/**
 * Länge des Base64-Strings, aus dem der RIFF-Kopf gelesen wird. Vielfaches von 4,
 * damit die Prefix-Dekodierung exakt ist (kein halbes Triple).
 */
const WAV_HEADER_CHARS = 8192;
/** Obergrenze für Chunks, die im Kopf abgelaufen werden (Schutz vor Endlosschleife). */
const WAV_MAX_HEADER_CHUNKS = 64;

/** Data-URL-Präfix („data:audio/wav;base64,…") entfernen – der Dienst macht dasselbe. */
export function stripDataUrlPrefix(data: string): string {
  const raw = data.trim();
  if (raw.toLowerCase().startsWith('data:') && raw.includes(',')) {
    return raw.slice(raw.indexOf(',') + 1);
  }
  return raw;
}

/** Dekodierte Länge eines Base64-Strings, ohne ihn zu dekodieren. */
export function decodedBase64Bytes(data: string): number {
  const raw = stripDataUrlPrefix(data).replace(/\s+/g, '');
  if (raw.length === 0) return 0;
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(raw.length / 4) * 3 - padding);
}

/**
 * Spielzeit einer RIFF/WAVE-Datei aus dem Header. `null`, wenn die Daten kein
 * WAV sind, der Kopf unvollständig ist oder die Dauer nicht bestimmbar ist.
 */
export function wavDurationSeconds(data: string): number | null {
  const raw = stripDataUrlPrefix(data);
  if (raw.length < 44) return null;
  const head = Buffer.from(raw.slice(0, WAV_HEADER_CHARS), 'base64');
  if (head.length < 44) return null;
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;

  // Die tatsächliche Dateigröße begrenzt die Angaben im Header: eine zu große
  // (oder bei Streaming-WAVs fehlende) `data`-Angabe darf die Dauer nicht
  // überschätzen – sonst würde eine gültige Spur abgelehnt.
  const totalBytes = decodedBase64Bytes(raw);
  let byteRate = 0;
  let offset = 12;
  for (let seen = 0; seen < WAV_MAX_HEADER_CHUNKS && offset + 8 <= head.length; seen += 1) {
    const chunkId = head.toString('latin1', offset, offset + 4);
    const declared = head.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ' && body + 16 <= head.length) {
      byteRate = head.readUInt32LE(body + 8);
    }
    if (chunkId === 'data') {
      if (byteRate <= 0) return null;
      const usable = Math.min(
        declared === 0 || declared === 0xffffffff ? Math.max(0, totalBytes - body) : declared,
        Math.max(0, totalBytes - body),
      );
      if (usable <= 0) return null;
      return Math.round((usable / byteRate) * 1000) / 1000;
    }
    if (declared > totalBytes) break; // Chunk-Angabe passt nicht zur Datei -> nicht vertrauen
    offset = body + declared + (declared % 2);
  }
  return null;
}

/** Messwerte eines Master-Bodys: Größe (übergeben), Spurenzahl, längste WAV-Spur. */
export function masterRequestFacts(payload: Record<string, unknown>, serializedBytes: number): MasterPayloadFacts {
  const entries = masterTrackEntries(payload);
  let longestTrackSeconds: number | null = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const data = (entry as Record<string, unknown>).data;
    if (typeof data !== 'string') continue;
    const seconds = wavDurationSeconds(data);
    if (seconds !== null && (longestTrackSeconds === null || seconds > longestTrackSeconds)) {
      longestTrackSeconds = seconds;
    }
  }
  return { bytes: serializedBytes, tracks: entries.length, longestTrackSeconds };
}

/** Vollständige Prüfung eines Master-Bodys; `null` = durchlassen. */
export function inspectMasterPayload(
  payload: Record<string, unknown>,
  serializedBytes: number,
  limits: MasterPayloadLimits = MASTER_PAYLOAD_LIMITS,
): MasterPayloadViolation | null {
  return describeMasterPayloadViolation(masterRequestFacts(payload, serializedBytes), limits);
}
