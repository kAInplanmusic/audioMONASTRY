/**
 * audioMONASTRY · Engine-Kanal-Pattern als Session-State (IDEA-2026-10-07-A-F2)
 * ============================================================================
 * Das Kanal-Pattern wohnt in der LOKALEN Engine (`SequencerState`, kein
 * Session-State). Übernimmt der Sequencer-Halter einen Capture-Takt, landen
 * die Kanal-Steps nur in SEINER Engine - hält er nicht zugleich mixerMONK,
 * erreichen sie Main nie. Dieses Modul macht den Stand sichtbar und holbar:
 *
 *  - Senden: das Gerät mit dem drumsampler-Lock schreibt seinen Engine-Stand
 *    in den Store (`publishLocalPatterns`); der Versand geht über denselben
 *    Capture-Relay-Socket ('pattern', baseRevision = letzte bekannte
 *    Server-Version). Der SERVER vergibt die Revisionsnummer (optimistische
 *    Nebenläufigkeit); das eigene Echo über 'room' setzt sie hier zurück.
 *  - Spiegel: 'pattern'-Nachrichten (Echo, Fremdsendungen, Antworten auf
 *    pattern-request) landen in `applyRemotePattern` und stehen allen Geräten
 *    als Lese-Store zur Verfügung.
 *  - Holen: ein Gerät, das den drumsampler-Lock neu hält (oder der neue
 *    Capture-Halter), kennt den Session-Stand noch nicht - es fordert ihn an
 *    ('pattern-request', Antwort geht nur an den Anfragenden), BEVOR es einen
 *    eigenen Stand sendet, sonst überschreibt es den der anderen still.
 *
 * Rein plattformfrei (useSyncExternalStore); der Versand wird von außen
 * gesetzt (`setPatternMirrorSender`). Nichts im Audio-Thread.
 */
import { useSyncExternalStore } from 'react';
import type { CapturePatternStateMessage, CapturePatternRequestMessage, SessionPatterns } from './captureRelay';

type Sender = (msg: CapturePatternStateMessage | CapturePatternRequestMessage) => void;

let current: CapturePatternStateMessage | null = null;
let sender: Sender | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function set(next: CapturePatternStateMessage | null): void {
  current = next;
  emit();
}

/** Versandweg setzen (null = nur lokal). */
export function setPatternMirrorSender(fn: Sender | null): void {
  sender = fn;
}

/** Aktueller gespiegelter Stand (null = noch keiner gesehen). */
export function getSessionPattern(): CapturePatternStateMessage | null {
  return current;
}

export function subscribeSessionPattern(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * Sequencer-Halter: den LOKALEN Engine-Stand veröffentlichen. Als
 * `baseRevision` geht die letzte bekannte Server-Version mit (Echo der
 * eigenen Sendung, Stand eines anderen Halters oder Antwort auf
 * pattern-request); bei einem veralteten Stand lehnt der Server ab und
 * spiegelt den aktuellen zurück. Ohne Versandweg bleibt es beim lokalen
 * Store (Einzelgerät ohne Session).
 */
export function publishLocalPatterns(patterns: SessionPatterns): void {
  const msg: CapturePatternStateMessage = { kind: 'pattern', revision: 0, baseRevision: current?.revision ?? 0, patterns };
  set(msg);
  sender?.(msg);
}

/**
 * Vom Server gespiegelter Stand (Echo der eigenen Sendung, Stand eines
 * anderen Sequencer-Halters oder Antwort auf pattern-request). Die hier
 * ankommende Server-Version ist die Basis der NÄCHSTEN eigenen Sendung.
 */
export function applyRemotePattern(msg: CapturePatternStateMessage): void {
  set(msg);
}

/**
 * Gerät ohne Kenntnis des Session-Stands (neuer Sequencer- oder Capture-
 * Halter): den Server-Stand anfordern. false = kein Versandweg gesetzt
 * (Einzelgerät ohne Session - nichts zu holen).
 */
export function requestSessionPattern(): boolean {
  if (!sender) return false;
  sender({ kind: 'pattern-request' });
  return true;
}

/** React-Hook für Anzeigen (z. B. Hinweis „Kanal-Pattern · gespiegelt"). */
export function useSessionPattern(): CapturePatternStateMessage | null {
  return useSyncExternalStore(subscribeSessionPattern, getSessionPattern, getSessionPattern);
}

export function resetPatternMirrorForTests(): void {
  current = null;
  sender = null;
  emit();
}
