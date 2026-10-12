/**
 * audioMONASTRY · Gespiegelter Capture-Vorschlag (IDEA-2026-10-07-A-F1)
 * =====================================================================
 * Der Pattern-Vorschlag eines Captures ist Session-Zustand: alle Nutzer sehen
 * dasselbe Fenster (Takt, Raster, Drum-Zeilen, Status). Bedienen dürfen nur
 * Capture-Halter und Sequencer-Halter (Taktwahl/Verwerfen); übernehmen darf
 * nur der Sequencer-Halter (drumsampler-Lock). Die Regeln prüft der Server
 * (`routeCaptureRelay`); hier liegt nur der Client-Spiegel.
 *
 * Kleiner externer Store (useSyncExternalStore), ohne Plattform-APIs. Der
 * Versand wird von außen gesetzt (`setCaptureMirrorSender`, siehe
 * `src/utils/captureRelayBridge.ts`); ohne Sender wirkt alles nur lokal.
 */
import { useSyncExternalStore } from 'react';
import type { CaptureRelayMessage, CaptureSuggestionState, CaptureSuggestionStatus } from './captureRelay';

type Sender = (msg: CaptureRelayMessage) => void;

let current: CaptureSuggestionState | null = null;
let sender: Sender | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function set(next: CaptureSuggestionState | null): void {
  current = next;
  emit();
}

/** Versandweg setzen (null = nur lokal). */
export function setCaptureMirrorSender(fn: Sender | null): void {
  sender = fn;
}

export function getCaptureSuggestion(): CaptureSuggestionState | null {
  return current;
}

export function subscribeCaptureSuggestion(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Capture-Halter: neuen Vorschlag für alle spiegeln. */
export function publishCaptureSuggestion(s: CaptureSuggestionState): void {
  set(s);
  sender?.({ kind: 'suggestion', suggestion: s });
}

/** Taktwahl / Verwerfen / Übernommen – lokal sofort, dann an alle. */
export function updateCaptureView(id: string, barIndex: number, status: CaptureSuggestionStatus, changedBy?: string): void {
  if (!current || current.id !== id) return;
  set({ ...current, barIndex, status, ...(changedBy ? { changedBy } : {}) });
  sender?.({ kind: 'view', id, barIndex, status, ...(changedBy ? { changedBy } : {}) });
}

/** Vom Server/anderen Geräten (bereits geprüft). */
export function applyRemoteCaptureMessage(msg: CaptureRelayMessage): void {
  if (msg.kind === 'suggestion') {
    set(msg.suggestion);
  } else if (msg.kind === 'view') {
    if (!current || current.id !== msg.id) return;
    set({ ...current, barIndex: msg.barIndex, status: msg.status, ...(msg.changedBy ? { changedBy: msg.changedBy } : {}) });
  }
}

export function useCaptureSuggestion(): CaptureSuggestionState | null {
  return useSyncExternalStore(subscribeCaptureSuggestion, getCaptureSuggestion, getCaptureSuggestion);
}

export function resetCaptureMirrorForTests(): void {
  current = null;
  sender = null;
  emit();
}
