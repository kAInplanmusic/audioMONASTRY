/**
 * audioMONASTRY · V2 WebRTC/SFU-GraphState-Kopplung (Phase 6)
 * ==========================================================
 * Reine Helfer, um den SFU-/WebRTC-Transport-State mit dem V2-GraphState zu
 * koppeln: Producer/Consumer-Sets und eine deterministische Graph-Revision.
 *
 * Die Revision ist ein kanonischer JSON-Fingerprint des `AudioGraphState` –
 * dadurch können Peers erkennen, ob ihr lokaler Mix zum Master-Stream passt,
 * ohne die gesamten Float32-Daten über den SFU-Signaling-Kanal zu schicken.
 */
import type { AudioGraphState } from '../../utils/audioGraphSerialization';
import type { V2SessionTransportState, V2SfuProducerInfo } from './v2SessionState';
import { createV2TransportState } from './v2SessionState';

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}

/** Deterministische Graph-Revision für den Transport-/SFU-Abgleich. */
export function fingerprintV2GraphState(state: AudioGraphState): string {
  return canonicalStringify({
    bpm: state.bpm,
    swing: state.swing,
    gate: state.gate,
    scale: state.scale,
    masterVolumeDb: state.masterVolumeDb,
    spatialSetupId: state.spatialSetupId,
    channelGainsDb: state.channelGainsDb ?? {},
    channelPans: state.channelPans ?? {},
    patterns: state.patterns ?? {},
    synthNotes: state.synthNotes ?? [],
  });
}

/** Erzeugt einen Transport-State für die SFU-Kopplung. */
export function createSfuTransportState(
  sessionId: string | null = null,
  mode: V2SessionTransportState['mode'] = 'local',
  connected = false,
): V2SessionTransportState {
  return {
    ...createV2TransportState(),
    mode,
    connected,
    sessionId,
  };
}

/** Aktualisiert die Graph-Revision eines Transport-State. */
export function setV2GraphRevision(state: V2SessionTransportState, revision: string | null): V2SessionTransportState {
  return {
    ...state,
    graphRevision: revision,
    updatedAt: Date.now(),
  };
}

/** Producer hinzufügen (idempotent). */
export function addV2SfuProducer(
  state: V2SessionTransportState,
  producer: V2SfuProducerInfo,
): V2SessionTransportState {
  if (state.producers.some((p) => p.producerId === producer.producerId)) return state;
  return {
    ...state,
    producers: [...state.producers, { ...producer, createdAt: producer.createdAt ?? Date.now() }],
    updatedAt: Date.now(),
  };
}

/** Producer entfernen (idempotent). */
export function removeV2SfuProducer(
  state: V2SessionTransportState,
  producerId: string,
): V2SessionTransportState {
  return {
    ...state,
    producers: state.producers.filter((p) => p.producerId !== producerId),
    consumers: state.consumers.filter((c) => c !== producerId),
    updatedAt: Date.now(),
  };
}

/** Consumer registrieren (idempotent). */
export function addV2SfuConsumer(
  state: V2SessionTransportState,
  producerId: string,
): V2SessionTransportState {
  if (state.consumers.includes(producerId)) return state;
  return { ...state, consumers: [...state.consumers, producerId], updatedAt: Date.now() };
}

/**
 * Koppelt einen V2-GraphState an den Transport-State: Liefert einen neuen
 * Transport-State mit aktualisierter Graph-Revision zurück.
 */
export function syncSfuWithV2GraphState(
  transport: V2SessionTransportState,
  graph: AudioGraphState,
): V2SessionTransportState {
  return setV2GraphRevision(transport, fingerprintV2GraphState(graph));
}
