/**
 * audioMONASTRY · Relay-Payload für Plugin-State (COLLAB-P0-002)
 * =============================================================
 * Der Server relayed `plugin-state` aus dem Socket-Pfad an die Session
 * (`socket.to(session:…).emit('plugin-state', payload)`). Damit die Empfänger
 * die Nachricht akzeptieren, MUSS der Payload den Client-Vertrag erfüllen:
 *
 *   1. `type === 'PLUGIN_STATE_UPDATE'`
 *      → `WebRTCManager.dispatchDataMessage` verwirft alles ohne gültigen
 *        `type` (der Wert wird dort als Länge 1..128 geprüft).
 *   2. `senderId` gesetzt
 *      → `ModuleStateContext` verwirft Updates ohne `senderId`; derselbe Wert
 *        wird für den Lock-Schatten-Filter und die LWW-Dedupe benutzt.
 *   3. `timestamp` gesetzt (Zahl >= 0)
 *      → LWW-Ordnung + Stale-Erkennung.
 *
 * Diese Funktion existiert, weil genau diese drei Felder vorher fehlten: Zod
 * (`PluginStateSocketSchema`) strippt unbekannte Keys, und der Server spreadete
 * `{ ...parsed.data }` — übrig blieben nur `pluginId`/`state`/`eventId`/
 * `sequence`. Der Socket-Relay-Pfad war damit stumm, die State-Spiegelung hing
 * allein an offenen P2P-DataChannels (im SFU-Modus, der laut `sendToAllPeers`
 * ausschließlich über diesen Pfad läuft, komplett). Bewusst als reine Funktion,
 * damit der Vertrag testbar ist und nicht wieder still brechen kann.
 *
 * `type` wird vom Server gesetzt (nicht vom Client übernommen), `senderId`
 * autoritativ aus der Session-Zuordnung (`socket.data.sessionUserId`) — beides
 * ist damit nicht spoofbar. Der `timestamp` des Senders bleibt erhalten, wenn er
 * vorliegt, damit Relay- und DataChannel-Pfad dieselbe Nachricht gleich ordnen.
 */

/** Gültige Plugin-States im Client-Vertrag (LOCKED ist kein Modul-State). */
export const RELAY_PLUGIN_STATES = ['OFF', 'AUTO_AI', 'PRO'] as const;

export interface PluginStateRelayInput {
  pluginId: string;
  state: string;
  /** Autoritativ aus der Session (NICHT aus dem Client-Payload). */
  senderUserId: string;
  senderRole: string;
  /** Revision aus der autoritativen Session (Ordnung/Dedupe). */
  revision: number;
  eventId: string;
  sequence?: number;
  /** Unix-ms des Senders; fehlt er, wird `now` verwendet. */
  timestamp?: number;
  /** Injizierbar für Tests (Default: Date.now()). */
  now?: number;
}

export interface PluginStateRelayPayload {
  type: 'PLUGIN_STATE_UPDATE';
  pluginId: string;
  state: string;
  senderId: string;
  timestamp: number;
  eventId: string;
  sequence?: number;
  senderRole: string;
  revision: number;
}

export function buildPluginStateRelayPayload(
  input: PluginStateRelayInput,
): PluginStateRelayPayload {
  const timestamp =
    typeof input.timestamp === 'number' && Number.isFinite(input.timestamp) && input.timestamp >= 0
      ? input.timestamp
      : (input.now ?? Date.now());

  const payload: PluginStateRelayPayload = {
    type: 'PLUGIN_STATE_UPDATE',
    pluginId: input.pluginId,
    state: input.state,
    senderId: input.senderUserId,
    timestamp,
    eventId: input.eventId,
    senderRole: input.senderRole,
    revision: input.revision,
  };
  if (typeof input.sequence === 'number') payload.sequence = input.sequence;
  return payload;
}
