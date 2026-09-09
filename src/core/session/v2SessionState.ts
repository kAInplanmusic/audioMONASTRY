/**
 * audioMONASTRY · V2 Session State (Phase 6 – Kollaboration/Session)
 * ==================================================================
 * JSON-fähiger, backend-unabhängiger Session-Zustand für den V2-Pfad.
 *
 * Enthält:
 *   - den vollständigen `AudioGraphState` (Gain/Pan/Patterns/BPM/Mastering)
 *   - den lokalen `MonitorRoutingPlan` (Cue/Main/Monitor)
 *   - aktive Plugin-IDs (pluginChannelMap-Audio-Einspeisung)
 *   - Transport-/SFU-Metadaten (Producer/Consumer/Graph-Revision)
 *
 * Export/Import/Merge sind rein und defensiv (keine React-/WebRTC-API).
 */
import type { AudioGraphState } from '../../utils/audioGraphSerialization';
import { emptyAudioGraphState } from '../../utils/audioGraphSerialization';
import {
  defaultMonitorPlan, MONITOR_USERS,
  type MonitorRoutingPlan, type MonitorSource,
} from '../audio/monitorRouting';
import type { TrackType } from '../../types';
import { ALL_TRACKS } from '../../types';

export const V2_SESSION_STATE_VERSION = 1;

export type V2TransportMode = 'local' | 'p2p' | 'sfu';

export interface V2SfuProducerInfo {
  producerId: string;
  kind: string;
  peerId: string;
  label?: string;
  createdAt: number;
}

export interface V2SessionTransportState {
  mode: V2TransportMode;
  connected: boolean;
  sessionId: string | null;
  /** SFU-/WebRTC-Producer, die den Master-/Cue-/Main-Pfad der Session tragen. */
  producers: V2SfuProducerInfo[];
  /** Vom Empfänger abonnierte Producer-IDs. */
  consumers: string[];
  /** Deterministische Revision des zuletzt gesendeten V2-GraphState. */
  graphRevision: string | null;
  updatedAt: number;
}

export interface V2SessionGraphState {
  version: typeof V2_SESSION_STATE_VERSION;
  sessionId: string;
  graph: AudioGraphState;
  monitor: MonitorRoutingPlan;
  activePlugins: string[];
  transport: V2SessionTransportState;
  updatedBy: string;
  updatedAt: number;
}

export interface ExportV2SessionStateInput {
  sessionId: string;
  graph: AudioGraphState;
  monitor?: MonitorRoutingPlan;
  activePlugins?: string[];
  transport?: Partial<V2SessionTransportState>;
  updatedBy?: string;
  updatedAt?: number;
}

const MONITOR_SOURCES: readonly MonitorSource[] = ['MAIN', 'MON', 'PLUGIN', 'MIX'];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createV2TransportState(): V2SessionTransportState {
  return {
    mode: 'local',
    connected: false,
    sessionId: null,
    producers: [],
    consumers: [],
    graphRevision: null,
    updatedAt: Date.now(),
  };
}

function sanitizeMonitor(raw: unknown): MonitorRoutingPlan {
  const fallback = defaultMonitorPlan('MON1');
  if (!raw || typeof raw !== 'object') return fallback;
  const plan = raw as Partial<MonitorRoutingPlan>;
  const source = MONITOR_SOURCES.includes(plan.source as MonitorSource) ? plan.source as MonitorSource : fallback.source;
  const mon = MONITOR_USERS.includes(plan.mon as MonitorRoutingPlan['mon']) ? plan.mon as MonitorRoutingPlan['mon'] : fallback.mon;
  const cueTracks = {} as Record<TrackType, number>;
  for (const track of ALL_TRACKS) {
    const value = (plan.cueTracks as Record<string, number> | undefined)?.[track];
    cueTracks[track] = typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(2, value))
      : fallback.cueTracks[track];
  }
  return {
    source,
    mon,
    soloTrack: (ALL_TRACKS as readonly string[]).includes(plan.soloTrack as string)
      ? plan.soloTrack as TrackType
      : null,
    mainMonitorGain: Number.isFinite(plan.mainMonitorGain) ? Math.max(0, Math.min(1, plan.mainMonitorGain as number)) : fallback.mainMonitorGain,
    cueGain: Number.isFinite(plan.cueGain) ? Math.max(0, Math.min(1, plan.cueGain as number)) : fallback.cueGain,
    cueTracks,
  };
}

/** Erzeugt einen vollständigen V2-Session-State (defensive Kopien). */
export function exportV2SessionState(input: ExportV2SessionStateInput): V2SessionGraphState {
  const now = input.updatedAt ?? Date.now();
  const transport: V2SessionTransportState = {
    ...createV2TransportState(),
    ...(input.transport ?? {}),
    producers: clone(input.transport?.producers ?? []),
    consumers: clone(input.transport?.consumers ?? []),
    updatedAt: input.transport?.updatedAt ?? now,
  };
  return {
    version: V2_SESSION_STATE_VERSION,
    sessionId: input.sessionId || 'main-studio',
    graph: clone(input.graph ?? emptyAudioGraphState()),
    monitor: sanitizeMonitor(input.monitor ?? defaultMonitorPlan('MON1')),
    activePlugins: clone([...(input.activePlugins ?? [])].filter((id): id is string => typeof id === 'string')),
    transport,
    updatedBy: input.updatedBy ?? 'localUser',
    updatedAt: now,
  };
}

/** Defensive Validierung eines unbekannten Objekts als V2-Session-State. */
export function isV2SessionState(value: unknown): value is V2SessionGraphState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<V2SessionGraphState>;
  return s.version === V2_SESSION_STATE_VERSION
    && typeof s.sessionId === 'string'
    && !!s.graph && typeof s.graph === 'object'
    && !!s.monitor && typeof s.monitor === 'object'
    && Array.isArray(s.activePlugins)
    && !!s.transport && typeof s.transport === 'object'
    && typeof s.updatedBy === 'string'
    && typeof s.updatedAt === 'number';
}

export type V2SessionParseResult =
  | { ok: true; state: V2SessionGraphState }
  | { ok: false; errors: string[] };

/** Parst und normalisiert einen V2-Session-State. */
export function parseV2SessionState(raw: unknown): V2SessionParseResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['V2-Session-State fehlt'] };
  const s = raw as Partial<V2SessionGraphState>;
  if (s.version !== V2_SESSION_STATE_VERSION) errors.push(`Version ${String(s.version)} wird nicht unterstützt`);
  if (typeof s.sessionId !== 'string' || !s.sessionId) errors.push('sessionId fehlt');
  if (!s.graph || typeof s.graph !== 'object') errors.push('graph fehlt');
  if (errors.length > 0) return { ok: false, errors };

  const graph = clone(s.graph as AudioGraphState);
  const monitor = sanitizeMonitor(s.monitor);
  const activePlugins = Array.isArray(s.activePlugins)
    ? clone(s.activePlugins.filter((id): id is string => typeof id === 'string'))
    : [];
  const transport = s.transport && typeof s.transport === 'object'
    ? {
        ...createV2TransportState(),
        ...(s.transport as Partial<V2SessionTransportState>),
        producers: clone((s.transport as Partial<V2SessionTransportState>).producers ?? []),
        consumers: clone((s.transport as Partial<V2SessionTransportState>).consumers ?? []),
        updatedAt: (s.transport as Partial<V2SessionTransportState>).updatedAt ?? Date.now(),
      }
    : createV2TransportState();

  return {
    ok: true,
    state: {
      version: V2_SESSION_STATE_VERSION,
      sessionId: s.sessionId,
      graph,
      monitor,
      activePlugins,
      transport,
      updatedBy: typeof s.updatedBy === 'string' ? s.updatedBy : 'unknown',
      updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt as number : Date.now(),
    },
  };
}

/** LWW-Merge zweier V2-Session-Zustände (Wanduhr + Absender-Tie-Break). */
export function mergeV2SessionStates(a: V2SessionGraphState, b: V2SessionGraphState): V2SessionGraphState {
  if (a.sessionId !== b.sessionId) return a.updatedAt >= b.updatedAt ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.updatedBy >= b.updatedBy ? a : b;
}
