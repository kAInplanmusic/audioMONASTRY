// src/core/session/sessionScratchpad.ts
// ============================================================================
// P1-4: Session-Zwischenspeicher (Scratchpad) – IndexedDB-basiert
// ----------------------------------------------------------------------------
// Speichert Session-Snapshots (Patterns, BPM, Mixer, Plugin-States, Routing)
// ohne den Audio-Pfad zu blockieren. Nutzt den vorhandenen IndexedDB-Adapter
// (`largeGetJson`/`largeSetJson`) – keine neue Storage-Architektur.
//
// Erweiterung 2026-09-02:
//  - Mehrere Snapshots als Liste (für die Overlay-Sidebar)
//  - DnD-Items (Plugins/Tracks in den Scratchpad ziehen, aus dem Scratchpad
//    auf Module laden) mit eigenem MIME-Type
//  - `buildSessionSnapshot()` als zentrale, pure Snapshot-Quelle
// ============================================================================

import { largeGetJson, largeSetJson } from '../../utils/indexedDB';

const SCRATCHPAD_KEY = 'session-scratchpad';
const SCRATCHPAD_SNAPSHOTS_KEY = 'session-scratchpad-snapshots';
const SCRATCHPAD_ENTRIES_KEY = 'session-scratchpad-entries';

export const MONK_DRAG_MIME = 'application/x-monk-item';
export const MONK_SCRATCH_MIME = 'application/x-monk-scratchpad';

export interface SessionScratchpadItem {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  snapshot: {
    bpm: number;
    isPlaying: boolean;
    patterns: Record<string, boolean[]>;
    moduleStates: Record<string, string>;
    mixer: Record<string, { volume: number; pan: number }>;
    routing: Record<string, string[]>;
  };
}

/** Eintrag, der per DnD in den Scratchpad-Bereich gezogen wurde. */
export interface ScratchpadDragItem {
  type: 'plugin' | 'track' | 'module' | 'scratchpad';
  id: string;
  name: string;
  source?: string;
  state?: string;
}

export type ScratchpadEntry = ScratchpadDragItem & { addedAt: number };

export function createScratchpadId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session';
  return `scratch-${slug}-${Date.now().toString(36)}`;
}

export async function saveSessionScratchpad(item: SessionScratchpadItem): Promise<void> {
  await largeSetJson(SCRATCHPAD_KEY, item);
}

export async function loadSessionScratchpad(): Promise<SessionScratchpadItem | null> {
  return largeGetJson<SessionScratchpadItem>(SCRATCHPAD_KEY);
}

export async function clearSessionScratchpad(): Promise<void> {
  await largeSetJson(SCRATCHPAD_KEY, null);
}

// ---------------------------------------------------------------------------
// Mehrere Snapshots (Overlay-Sidebar)
// ---------------------------------------------------------------------------

export async function loadScratchpadSnapshots(): Promise<SessionScratchpadItem[]> {
  const items = await largeGetJson<SessionScratchpadItem[]>(SCRATCHPAD_SNAPSHOTS_KEY);
  return Array.isArray(items) ? items : [];
}

export async function saveScratchpadSnapshots(items: SessionScratchpadItem[]): Promise<void> {
  await largeSetJson(SCRATCHPAD_SNAPSHOTS_KEY, items.slice(0, 50));
}

export async function addScratchpadSnapshot(item: SessionScratchpadItem): Promise<SessionScratchpadItem[]> {
  const items = await loadScratchpadSnapshots();
  const next = [item, ...items.filter((i) => i.id !== item.id)].slice(0, 50);
  await saveScratchpadSnapshots(next);
  return next;
}

export async function removeScratchpadSnapshot(id: string): Promise<SessionScratchpadItem[]> {
  const items = await loadScratchpadSnapshots();
  const next = items.filter((i) => i.id !== id);
  await saveScratchpadSnapshots(next);
  return next;
}

// ---------------------------------------------------------------------------
// DnD-Einträge (Plugins/Tracks in den Scratchpad ziehen)
// ---------------------------------------------------------------------------

export async function loadScratchpadEntries(): Promise<ScratchpadEntry[]> {
  const items = await largeGetJson<ScratchpadEntry[]>(SCRATCHPAD_ENTRIES_KEY);
  return Array.isArray(items) ? items : [];
}

export async function saveScratchpadEntries(entries: ScratchpadEntry[]): Promise<void> {
  await largeSetJson(SCRATCHPAD_ENTRIES_KEY, entries.slice(0, 100));
}

export async function addScratchpadEntry(item: ScratchpadDragItem): Promise<ScratchpadEntry[]> {
  const entries = await loadScratchpadEntries();
  const entry: ScratchpadEntry = { ...item, addedAt: Date.now() };
  const next = [entry, ...entries.filter((e) => !(e.id === item.id && e.type === item.type))].slice(0, 100);
  await saveScratchpadEntries(next);
  return next;
}

export async function removeScratchpadEntry(id: string, type: string): Promise<ScratchpadEntry[]> {
  const entries = await loadScratchpadEntries();
  const next = entries.filter((e) => !(e.id === id && e.type === type));
  await saveScratchpadEntries(next);
  return next;
}

/** Schreibt ein DnD-Item in ein DragEvent (kein Wurf bei fehlendem dataTransfer). */
export function writeMonkDragItem(e: { dataTransfer: { setData: (mime: string, value: string) => void } | null }, item: ScratchpadDragItem): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(MONK_DRAG_MIME, JSON.stringify(item));
}

export function writeMonkScratchItem(e: { dataTransfer: { setData: (mime: string, value: string) => void } | null }, entry: ScratchpadEntry): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(MONK_SCRATCH_MIME, JSON.stringify(entry));
}

export function readMonkDragItem(e: { dataTransfer: { getData: (mime: string) => string } | null }, mime: string = MONK_DRAG_MIME): ScratchpadDragItem | null {
  if (!e.dataTransfer) return null;
  try {
    const raw = e.dataTransfer.getData(mime);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ScratchpadDragItem;
    return parsed && typeof parsed.id === 'string' && typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot-Builder
// ---------------------------------------------------------------------------

/**
 * Baut den Scratchpad-Snapshot aus dem aktuellen Session-Zustand.
 * Pure Funktion – alle Quellen werden als Parameter übergeben (testbar).
 */
export function buildSessionSnapshot(
  moduleStates: Record<string, string>,
  bpm: number,
  isPlaying: boolean,
  extra?: Partial<SessionScratchpadItem['snapshot']>,
): SessionScratchpadItem['snapshot'] {
  return {
    bpm: Number.isFinite(bpm) ? bpm : 128,
    isPlaying: !!isPlaying,
    patterns: extra?.patterns ?? {},
    moduleStates: { ...moduleStates },
    mixer: extra?.mixer ?? {},
    routing: extra?.routing ?? {},
  };
}

/** Erzeugt ein fertiges Scratchpad-Item (ID + Timestamps) fürs Speichern. */
export function createScratchpadSnapshot(
  name: string,
  moduleStates: Record<string, string>,
  bpm: number,
  isPlaying: boolean,
  extra?: Partial<SessionScratchpadItem['snapshot']>,
): SessionScratchpadItem {
  const now = Date.now();
  return {
    id: createScratchpadId(name),
    name: name.trim() || 'Session',
    createdAt: now,
    updatedAt: now,
    snapshot: buildSessionSnapshot(moduleStates, bpm, isPlaying, extra),
  };
}
