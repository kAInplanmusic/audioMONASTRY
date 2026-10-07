/**
 * audioMONASTRY · Capture – gemerkte Pattern-Vorschläge (IDEA-2026-10-07-A)
 * =========================================================================
 * „Als Pattern merken“ legt einen Capture-Takt im SERVER-seitigen
 * Studio-Speicher der Session ab (`src/utils/storage.ts` →
 * `studioStoreSync`). Der Schlüssel steht bewusst NICHT in `MEMORY_ONLY_KEYS`:
 * gemerkte Patterns überleben das Neuladen und sind für die Session sichtbar.
 * Nichts davon liegt auf dem Gerät (kein localStorage/IndexedDB).
 *
 * Liste mit höchstens `CAPTURE_PATTERN_LIMIT` Einträgen; die ältesten fliegen raus.
 */
import { storageGetJson, storageSetJson } from '../../utils/storage';
import { ALL_TRACKS } from '../../types';
import type { CaptureBar, CaptureNote } from './quantizeCapture';

export const CAPTURE_PATTERNS_KEY = 'audiomonastry_capture_patterns';
export const CAPTURE_PATTERN_LIMIT = 32;

export interface SavedCapturePattern {
  id: string;
  /** ISO-Zeitstempel. */
  createdAt: string;
  name: string;
  bpm: number;
  bar: CaptureBar;
  notes: CaptureNote[];
}

function isBar(v: unknown): v is CaptureBar {
  if (!v || typeof v !== 'object') return false;
  const rec = v as Record<string, unknown>;
  return ALL_TRACKS.every((t) => Array.isArray(rec[t]));
}

/** Gemerkte Patterns (älteste zuerst); defekte Einträge werden ignoriert. */
export function listCapturePatterns(): SavedCapturePattern[] {
  const raw = storageGetJson<unknown>(CAPTURE_PATTERNS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is SavedCapturePattern =>
    !!e && typeof e === 'object' && typeof (e as SavedCapturePattern).id === 'string' && isBar((e as SavedCapturePattern).bar));
}

/** Hängt ein Pattern an; liefert die gespeicherte Liste (max. 32, älteste raus). */
export function saveCapturePattern(entry: SavedCapturePattern): SavedCapturePattern[] {
  const next = [...listCapturePatterns(), entry].slice(-CAPTURE_PATTERN_LIMIT);
  storageSetJson(CAPTURE_PATTERNS_KEY, next);
  return next;
}
