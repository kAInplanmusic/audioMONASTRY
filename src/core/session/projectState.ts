// ============================================================================
// audioMONASTRY · Projektweiter, synchronisierter Audio-Interaktions-State
// ----------------------------------------------------------------------------
// Zentrale, REINE Datentypen + LWW-Merge-Funktionen für die neue einheitliche
// Click-/Touch-Interaktion:
//   * Project Clipboard (gemeinsam, referenziert Audio-Assets statt zu kopieren)
//   * Track-Belegung (mixerMONK-Kanäle channel1..8)
//   * Spatial-Kanal-Belegung (spatialMONK 1..8)
//
// Bewusst OHNE React/WebRTC/Plattform-Abhängigkeiten, damit die Funktionen
// deterministisch testbar sind. Die Synchronisation über den bestehenden
// WebRTC-DataChannel/Socket-Relay-Kanal erfolgt in ProjectContext.
// ============================================================================

import type { AudioSample } from '../../data/samples';
import type { TrackType } from '../../types';

export type AudioContentKind =
  | 'sample'
  | 'music'
  | 'stem'
  | 'stream'
  | 'master-stream'
  | 'mixer-channel';

/**
 * Einheitliche Beschreibung eines Audioinhalts – unabhängig davon, ob er aus
 * der Library, dem Clipboard, einem Stem, einer Datei oder einem Live-Stream
 * stammt. `sample` verweist auf das bestehende Audio-Asset (keine Kopie).
 */
export interface AudioContentRef {
  id: string;
  name: string;
  kind: AudioContentKind;
  /** Herkunfts-Modul/-Bereich (library, clipboard, stem, mixer, masterplayer, …). */
  source: string;
  /** Referenz auf ein bestehendes Audio-Asset (wenn vorhanden). */
  sample?: AudioSample;
  /** Direkte Audio-URL (z. B. Musik-Track, Stem-Blob, Aufnahme). */
  url?: string;
  /** Synthese-Parameter für parameterbasierte Presets (kein URL nötig). */
  params?: AudioSample['parameters'];
  /** Live-Stream-Identität (master-stream/mixer-channel). */
  streamId?: string;
  /** Optionale Stem-Gruppe (z. B. Master-Player-Stems). */
  stems?: AudioContentRef[];
}

export interface ProjectClipboardEntry extends AudioContentRef {
  addedBy: string;
  addedAt: number;
  revision: number;
}

export interface TrackAssignment {
  track: TrackType;
  name: string;
  kind: AudioContentKind;
  url?: string;
  streamId?: string;
  assignedBy: string;
  assignedAt: number;
  revision: number;
}

export interface SpatialChannelAssignment {
  /** Spatial-Kanal 1..8 (entspricht track channel1..8). */
  channelId: number;
  name: string;
  kind: AudioContentKind;
  url?: string;
  streamId?: string;
  assignedBy: string;
  assignedAt: number;
  revision: number;
}

export type TrackAssignmentMap = Partial<Record<TrackType, TrackAssignment>>;
export type SpatialAssignmentMap = Partial<Record<number, SpatialChannelAssignment>>;

export const SPATIAL_CHANNEL_COUNT = 8;
export const SPATIAL_CHANNEL_IDS: readonly number[] = Object.freeze(
  Array.from({ length: SPATIAL_CHANNEL_COUNT }, (_, i) => i + 1),
);

export function spatialChannelTrack(channelId: number): TrackType {
  return `channel${Math.max(1, Math.min(SPATIAL_CHANNEL_COUNT, Math.trunc(channelId)))}` as TrackType;
}

/** LWW-Vergleich: neuere Revision gewinnt, bei Gleichstand entscheidet senderId. */
export function isNewerRevision(
  a: { revision: number; assignedBy?: string },
  b: { revision: number; assignedBy?: string },
): boolean {
  if (a.revision !== b.revision) return a.revision > b.revision;
  return (a.assignedBy ?? '') > (b.assignedBy ?? '');
}

/** Clipboard: Eintrag einfügen/ersetzen (idempotent, LWW). */
export function mergeClipboardAdd(
  list: ProjectClipboardEntry[],
  entry: ProjectClipboardEntry,
): ProjectClipboardEntry[] {
  const idx = list.findIndex((e) => e.id === entry.id);
  if (idx === -1) return [...list, entry];
  const existing = list[idx];
  if (!isNewerRevision(entry, existing)) return list;
  const next = [...list];
  next[idx] = entry;
  return next;
}

/** Clipboard: Eintrag entfernen (idempotent). */
export function mergeClipboardRemove(
  list: ProjectClipboardEntry[],
  id: string,
): ProjectClipboardEntry[] {
  return list.filter((e) => e.id !== id);
}

/**
 * Track-Claim einpflegen. Liefert `applied=false` + `conflict=true`, wenn ein
 * gleichzeitiger, gleichwertiger Claim eines anderen Nutzers vorliegt – das
 * Ziel wird dann NICHT still überschrieben.
 */
export function mergeTrackClaim(
  map: TrackAssignmentMap,
  claim: TrackAssignment,
): { map: TrackAssignmentMap; applied: boolean; conflict: boolean } {
  const existing = map[claim.track];
  if (!existing) return { map: { ...map, [claim.track]: claim }, applied: true, conflict: false };
  if (claim.revision > existing.revision) {
    return { map: { ...map, [claim.track]: claim }, applied: true, conflict: false };
  }
  if (claim.revision < existing.revision) return { map, applied: false, conflict: false };
  // Gleiche Revision: identischer Inhalt = idempotent; sonst paralleler Claim.
  const sameContent =
    existing.assignedBy === claim.assignedBy ||
    (existing.name === claim.name && existing.url === claim.url);
  return { map, applied: false, conflict: !sameContent };
}

export function mergeTrackRelease(
  map: TrackAssignmentMap,
  track: TrackType,
): TrackAssignmentMap {
  if (!map[track]) return map;
  const next = { ...map };
  delete next[track];
  return next;
}

/** Spatial-Claim einpflegen (gleiche Semantik wie Track-Claim). */
export function mergeSpatialClaim(
  map: SpatialAssignmentMap,
  claim: SpatialChannelAssignment,
): { map: SpatialAssignmentMap; applied: boolean; conflict: boolean } {
  const existing = map[claim.channelId];
  if (!existing) return { map: { ...map, [claim.channelId]: claim }, applied: true, conflict: false };
  if (claim.revision > existing.revision) {
    return { map: { ...map, [claim.channelId]: claim }, applied: true, conflict: false };
  }
  if (claim.revision < existing.revision) return { map, applied: false, conflict: false };
  const sameContent =
    existing.assignedBy === claim.assignedBy ||
    (existing.name === claim.name && existing.url === claim.url);
  return { map, applied: false, conflict: !sameContent };
}

export function mergeSpatialRelease(
  map: SpatialAssignmentMap,
  channelId: number,
): SpatialAssignmentMap {
  if (!map[channelId]) return map;
  const next = { ...map };
  delete next[channelId];
  return next;
}

export function clearSpatialAssignments(): SpatialAssignmentMap {
  return {};
}

/** Track frei = keine geteilte Belegung vorhanden. */
export function isTrackFree(map: TrackAssignmentMap, track: TrackType): boolean {
  return !map[track];
}

/** Spatial-Kanal frei = keine geteilte Belegung vorhanden. */
export function isSpatialChannelFree(map: SpatialAssignmentMap, channelId: number): boolean {
  return !map[channelId];
}

export function trackLabel(track: TrackType): string {
  return track.toUpperCase().replace('CHANNEL', 'CH ');
}
