// src/core/session/sessionScratchpad.ts
// ============================================================================
// P1-4: Session-Zwischenspeicher (Scratchpad) – IndexedDB-basiert
// ----------------------------------------------------------------------------
// Speichert Session-Snapshots (Patterns, BPM, Mixer, Plugin-States, Routing)
// ohne den Audio-Pfad zu blockieren. Nutzt den vorhandenen IndexedDB-Adapter
// (`largeGetJson`/`largeSetJson`) – keine neue Storage-Architektur.
// ============================================================================

import { largeGetJson, largeSetJson } from '../../utils/indexedDB';

const SCRATCHPAD_KEY = 'session-scratchpad';

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
