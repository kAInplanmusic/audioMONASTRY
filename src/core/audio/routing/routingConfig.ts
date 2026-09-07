/**
 * audioMONASTRY · Reine Routing-Helfer
 * ====================================
 * Enthält nur deterministische, Tone-freie Funktionen aus dem routing.json-Pfad.
 * Anwenden auf die echte Audio-Engine bleibt in `audioEngine.ts`.
 */
import type { TrackType } from '../../../types';

/** F7: routing.json-Track-ID → interner Kanal. */
const ROUTING_TRACK_MAP: Record<string, TrackType> = {
  'track-kick': 'channel1',
  'track-hat': 'channel2',
  'track-clap': 'channel3',
  'track-bass': 'channel7',
};

export function routingTrackToChannel(id: string): TrackType | null {
  return ROUTING_TRACK_MAP[id] ?? null;
}

export interface RoutingConnectionInput {
  source: string;
  destination: string;
}

export interface RoutingConnectionCheck {
  validSource: boolean;
  validDest: boolean;
}

/** Validiert Connections gegen bekannte Track-/Bus-IDs (kein Engine-Zugriff). */
export function checkRoutingConnection(
  c: RoutingConnectionInput,
  trackIds: Set<string>,
  busIds: Set<string>,
): RoutingConnectionCheck {
  const validSource = trackIds.has(c.source) || busIds.has(c.source);
  const validDest = busIds.has(c.destination) || c.destination === 'destination';
  return { validSource, validDest };
}
