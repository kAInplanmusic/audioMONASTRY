// ============================================================================
// audioMONASTRY · ProjectContext
// ----------------------------------------------------------------------------
// Gemeinsamer Projekt-State für die einheitliche Audio-Interaktion:
//   * Project Clipboard (nicht pro User, referenziert Audio-Assets)
//   * Track-Belegung (mixerMONK channel1..8) mit LWW-Claim + Konflikterkennung
//   * Spatial-Kanal-Belegung (spatialMONK 1..8) mit LWW-Claim
//
// Synchronisation ausschließlich über die BESTEHENDE Kollaborations-Schicht
// (webRTCManager.sendToAllPeers / addDataChannelListener). Keine neue Architektur.
// ============================================================================

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { TrackType } from '../types';
import type { WebRTCMessage } from '../types/protocol';
import { webRTCManager } from '../utils/WebRTCManager';
import {
  clearSpatialAssignments,
  isSpatialChannelFree,
  isTrackFree,
  mergeClipboardAdd,
  mergeClipboardRemove,
  mergeSpatialClaim,
  mergeSpatialRelease,
  mergeTrackClaim,
  mergeTrackRelease,
  type AudioContentRef,
  type ProjectClipboardEntry,
  type SpatialAssignmentMap,
  type SpatialChannelAssignment,
  type TrackAssignment,
  type TrackAssignmentMap,
} from '../core/session/projectState';

export type ProjectActionResult = { ok: true } | { ok: false; reason: 'occupied' };

export interface SpatialTakeoverRequest {
  channelId: number;
  content: AudioContentRef;
  token: number;
}

export interface ProjectNotice {
  id: number;
  text: string;
  tone: 'info' | 'warn' | 'error';
}

interface ProjectContextType {
  clipboard: ProjectClipboardEntry[];
  addClipboardItem: (content: AudioContentRef) => void;
  removeClipboardItem: (id: string) => void;

  trackAssignments: TrackAssignmentMap;
  /** Freie/belegte mixerMONK-Tracks (geteilter Projektzustand). */
  isTrackFree: (track: TrackType) => boolean;
  assignTrack: (track: TrackType, content: AudioContentRef) => ProjectActionResult;
  releaseTrack: (track: TrackType) => void;

  spatialAssignments: SpatialAssignmentMap;
  isSpatialChannelFree: (channelId: number) => boolean;
  /** Claimt einen Spatial-Kanal im GETEILTEN Zustand (ohne lokales Audio-Routing). */
  assignSpatialChannel: (channelId: number, content: AudioContentRef) => ProjectActionResult;
  releaseSpatialChannel: (channelId: number) => void;
  resetSpatialAssignments: () => void;
  /**
   * Lokaler Auftrag an spatialMONK: Kanal nach erfolgreichem Claim tatsächlich
   * beschallen (Quelle anlegen, Audio routen). Wird vom Action-Menu benutzt.
   */
  requestSpatialTakeover: (channelId: number, content: AudioContentRef) => void;
  /** Aktiver lokaler Übernahme-Auftrag für spatialMONK. */
  spatialTakeoverRequest: SpatialTakeoverRequest | null;
  clearSpatialTakeoverRequest: () => void;

  notice: ProjectNotice | null;
  dismissNotice: () => void;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [clipboard, setClipboard] = useState<ProjectClipboardEntry[]>([]);
  const [trackAssignments, setTrackAssignments] = useState<TrackAssignmentMap>({});
  const [spatialAssignments, setSpatialAssignments] = useState<SpatialAssignmentMap>({});
  const [spatialTakeoverRequest, setSpatialTakeoverRequest] = useState<SpatialTakeoverRequest | null>(null);
  const [notice, setNotice] = useState<ProjectNotice | null>(null);

  // Ref-Spiegel: Aktionen/Callbacks sehen immer den aktuellsten Zustand
  // (wichtig für den Race-Check „zwischen Anzeige und Übernahme").
  const clipboardRef = useRef(clipboard);
  const trackRef = useRef(trackAssignments);
  const spatialRef = useRef(spatialAssignments);
  useEffect(() => { clipboardRef.current = clipboard; }, [clipboard]);
  useEffect(() => { trackRef.current = trackAssignments; }, [trackAssignments]);
  useEffect(() => { spatialRef.current = spatialAssignments; }, [spatialAssignments]);

  const pushNotice = useCallback((text: string, tone: ProjectNotice['tone'] = 'info') => {
    setNotice({ id: Date.now() + Math.random(), text, tone });
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const claimRevision = useCallback(() => Date.now(), []);

  /**
   * Diskrete Projekt-State-Meldungen sofort senden (kein sendData-Coalescing,
   * das bei mehreren Clipboard-Einträgen/Track-Claims Meldungen verschlucken würde).
   */
  const broadcast = useCallback((msg: WebRTCMessage) => webRTCManager.sendToAllPeers(msg), []);

  // ---------------------------------------------------------------- Clipboard
  const addClipboardItem = useCallback((content: AudioContentRef) => {
    const entry: ProjectClipboardEntry = {
      ...content,
      addedBy: webRTCManager.userId,
      addedAt: Date.now(),
      revision: Date.now(),
    };
    setClipboard((prev) => mergeClipboardAdd(prev, entry));
    broadcast({
      type: 'PROJECT_CLIPBOARD_UPDATE',
      action: 'ADD',
      entry,
      senderId: webRTCManager.userId,
      timestamp: entry.revision,
    } as WebRTCMessage);
  }, [broadcast]);

  const removeClipboardItem = useCallback((id: string) => {
    setClipboard((prev) => mergeClipboardRemove(prev, id));
    broadcast({
      type: 'PROJECT_CLIPBOARD_UPDATE',
      action: 'REMOVE',
      id,
      senderId: webRTCManager.userId,
      timestamp: Date.now(),
    } as WebRTCMessage);
  }, [broadcast]);

  // -------------------------------------------------------------------- Tracks
  const assignTrack = useCallback(
    (track: TrackType, content: AudioContentRef): ProjectActionResult => {
      // Race-Guard: unmittelbar vor der Übernahme den GETEILTEN Zustand prüfen.
      if (trackRef.current[track]) return { ok: false, reason: 'occupied' };
      const claim: TrackAssignment = {
        track,
        name: content.name,
        kind: content.kind,
        url: content.url,
        streamId: content.streamId,
        assignedBy: webRTCManager.userId,
        assignedAt: Date.now(),
        revision: claimRevision(),
      };
      setTrackAssignments((prev) => mergeTrackClaim(prev, claim).map);
      broadcast({
        type: 'TRACK_ASSIGNMENT_UPDATE',
        action: 'CLAIM',
        claim,
        senderId: webRTCManager.userId,
        timestamp: claim.revision,
      } as WebRTCMessage);
      return { ok: true };
    },
    [claimRevision, broadcast],
  );

  const releaseTrack = useCallback((track: TrackType) => {
    setTrackAssignments((prev) => mergeTrackRelease(prev, track));
    broadcast({
      type: 'TRACK_ASSIGNMENT_UPDATE',
      action: 'RELEASE',
      track,
      senderId: webRTCManager.userId,
      timestamp: Date.now(),
    } as WebRTCMessage);
  }, [broadcast]);

  // ------------------------------------------------------------------ Spatial
  const assignSpatialChannel = useCallback(
    (channelId: number, content: AudioContentRef): ProjectActionResult => {
      if (spatialRef.current[channelId]) return { ok: false, reason: 'occupied' };
      const claim: SpatialChannelAssignment = {
        channelId,
        name: content.name,
        kind: content.kind,
        url: content.url,
        streamId: content.streamId,
        assignedBy: webRTCManager.userId,
        assignedAt: Date.now(),
        revision: claimRevision(),
      };
      setSpatialAssignments((prev) => mergeSpatialClaim(prev, claim).map);
      broadcast({
        type: 'SPATIAL_ASSIGNMENT_UPDATE',
        action: 'CLAIM',
        claim,
        senderId: webRTCManager.userId,
        timestamp: claim.revision,
      } as WebRTCMessage);
      return { ok: true };
    },
    [claimRevision, broadcast],
  );

  const releaseSpatialChannel = useCallback((channelId: number) => {
    setSpatialAssignments((prev) => mergeSpatialRelease(prev, channelId));
    broadcast({
      type: 'SPATIAL_ASSIGNMENT_UPDATE',
      action: 'RELEASE',
      channelId,
      senderId: webRTCManager.userId,
      timestamp: Date.now(),
    } as WebRTCMessage);
  }, [broadcast]);

  const resetSpatialAssignments = useCallback(() => {
    setSpatialAssignments(clearSpatialAssignments());
    broadcast({
      type: 'SPATIAL_ASSIGNMENT_UPDATE',
      action: 'RESET',
      senderId: webRTCManager.userId,
      timestamp: Date.now(),
    } as WebRTCMessage);
  }, [broadcast]);

  const clearSpatialTakeoverRequest = useCallback(() => setSpatialTakeoverRequest(null), []);

  const requestSpatialTakeover = useCallback((channelId: number, content: AudioContentRef) => {
    setSpatialTakeoverRequest({ channelId, content, token: Date.now() });
  }, []);

  // --------------------------------------------- Eingehende Peer-Nachrichten
  useEffect(() => {
    return webRTCManager.addDataChannelListener((msg: any) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'PROJECT_CLIPBOARD_UPDATE') {
        if (msg.action === 'ADD' && msg.entry) {
          setClipboard((prev) => mergeClipboardAdd(prev, msg.entry as ProjectClipboardEntry));
        } else if (msg.action === 'REMOVE' && typeof msg.id === 'string') {
          setClipboard((prev) => mergeClipboardRemove(prev, msg.id));
        }
        return;
      }

      if (msg.type === 'TRACK_ASSIGNMENT_UPDATE') {
        if (msg.action === 'CLAIM' && msg.claim?.track) {
          const claim = msg.claim as TrackAssignment;
          setTrackAssignments((prev) => {
            const res = mergeTrackClaim(prev, claim);
            if (res.conflict) {
              pushNotice(
                `Track ${claim.track.toUpperCase().replace('CHANNEL', 'CH ')} wurde parallel von ${claim.assignedBy} belegt – nicht überschrieben.`,
                'warn',
              );
            }
            return res.map;
          });
        } else if (msg.action === 'RELEASE' && msg.track) {
          setTrackAssignments((prev) => mergeTrackRelease(prev, msg.track as TrackType));
        }
        return;
      }

      if (msg.type === 'SPATIAL_ASSIGNMENT_UPDATE') {
        if (msg.action === 'CLAIM' && typeof msg.claim?.channelId === 'number') {
          const claim = msg.claim as SpatialChannelAssignment;
          setSpatialAssignments((prev) => {
            const res = mergeSpatialClaim(prev, claim);
            if (res.conflict) {
              pushNotice(
                `Spatial-Kanal ${claim.channelId} wurde parallel von ${claim.assignedBy} belegt – nicht überschrieben.`,
                'warn',
              );
            }
            return res.map;
          });
        } else if (msg.action === 'RELEASE' && typeof msg.channelId === 'number') {
          setSpatialAssignments((prev) => mergeSpatialRelease(prev, msg.channelId));
        } else if (msg.action === 'RESET') {
          setSpatialAssignments(clearSpatialAssignments());
        }
        return;
      }
    });
  }, [pushNotice]);

  const isTrackFreeCb = useCallback(
    (track: TrackType) => isTrackFree(trackRef.current, track),
    [],
  );

  const isSpatialChannelFreeCb = useCallback(
    (channelId: number) => isSpatialChannelFree(spatialRef.current, channelId),
    [],
  );

  const value = useMemo<ProjectContextType>(
    () => ({
      clipboard,
      addClipboardItem,
      removeClipboardItem,
      trackAssignments,
      isTrackFree: isTrackFreeCb,
      assignTrack,
      releaseTrack,
      spatialAssignments,
      isSpatialChannelFree: isSpatialChannelFreeCb,
      assignSpatialChannel,
      releaseSpatialChannel,
      resetSpatialAssignments,
      requestSpatialTakeover,
      spatialTakeoverRequest,
      clearSpatialTakeoverRequest,
      notice,
      dismissNotice,
    }),
    [
      clipboard,
      addClipboardItem,
      removeClipboardItem,
      trackAssignments,
      isTrackFreeCb,
      assignTrack,
      releaseTrack,
      spatialAssignments,
      isSpatialChannelFreeCb,
      assignSpatialChannel,
      releaseSpatialChannel,
      resetSpatialAssignments,
      requestSpatialTakeover,
      spatialTakeoverRequest,
      clearSpatialTakeoverRequest,
      notice,
      dismissNotice,
    ],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export const useProject = () => {
  const context = useContext(ProjectContext);
  if (!context) throw new Error('useProject must be used within a ProjectProvider');
  return context;
};
