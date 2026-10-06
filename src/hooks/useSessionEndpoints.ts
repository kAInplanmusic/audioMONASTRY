import { useEffect, useState } from 'react';
import { webRTCManager } from '../utils/WebRTCManager';
import {
  endpointSlots,
  parseSessionEndpoints,
  type EndpointSlots,
  type SessionEndpoint,
} from '../core/session/sessionEndpoints';

/**
 * Session-Ausgänge live: 4 UI-Plätze, Main Sound, Main Visual
 * (src/core/session/sessionEndpoints.ts). Reine Anzeige – kein Audio-Pfad.
 */
export function useSessionEndpoints(): { list: SessionEndpoint[]; slots: EndpointSlots } {
  const [list, setList] = useState<SessionEndpoint[]>([]);
  useEffect(() => webRTCManager.onSessionEndpoints((msg) => setList(parseSessionEndpoints(msg))), []);
  return { list, slots: endpointSlots(list) };
}
