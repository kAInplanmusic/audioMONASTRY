import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Plus, Trash2, Camera, RotateCcw, Gauge, Volume2, Radio } from 'lucide-react';
import * as Tone from 'tone';
import { usePluginState } from '../hooks/usePluginState';
import { useProject } from '../context/ProjectContext';
import { useSamples } from '../context/SampleContext';
import { MoaAssistant } from './MoaAssistant';
import { audioEngine } from '../utils/audioEngine';
import { storageGetJson, storageSetJson } from '../utils/storage';
import { SpatialCluster, spatialAdapter } from '../audio/spatial/node';
import { SpatialSourceIcon } from './SpatialSourceIcon';
import { DEFAULT_SPATIAL_SCENE, SPATIAL_SCENE_PRESETS } from '../presets';
import { SPATIAL_SETUPS } from '../utils/spatialMath';
import type { SpatialQuality, SpatialSceneState, SpatialSource, TrackType } from '../types';
import { ALL_TRACKS } from '../types';
import { openAudioActionMenu } from './AudioActionMenuHost';
import { webRTCManager } from '../utils/WebRTCManager';
import {
  isStreamContent,
  masterStreamContent,
  mixerChannelContent,
  sampleToContent,
} from '../core/audio/audioContent';
import {
  spatialChannelTrack,
  SPATIAL_CHANNEL_IDS,
  type AudioContentRef,
} from '../core/session/projectState';

/**
 * spatialMONK – neue schlichte 2D-Scene-UI (WhitePaper Abschnitt 6)
 * =================================================================
 * Top-Down-Scene: Mitte = Listener, Quellen dragbar, Inspector rechts,
 * Qualität/CPU oben, Quick-Actions unten. Positionen laufen über den
 * neuen SpatialCluster (Worklet-Protokoll) UND – als Übergang – über die
 * bestehende audioEngine (Legacy-Audio-Pfad, Adapter-Rollout).
 */

const SNAPSHOT_KEY = 'spatialmonk-scene-snapshot';
const SOURCE_COLORS = ['#f43f5e', '#f97316', '#fbbf24', '#34d399', '#22d3ee', '#3b82f6', '#a855f7', '#ec4899'];

interface Metrics {
  cpuEstimate: number;
  activeSources: number;
  instances: number;
}

const cloneScene = (s: SpatialSceneState): SpatialSceneState => JSON.parse(JSON.stringify(s));

function azDistFromPointer(nx: number, ny: number): { az: number; dist: number } {
  const az = Math.atan2(nx, ny) * (180 / Math.PI);
  const dist = Math.max(0.2, Math.min(4, Math.hypot(nx, ny) * 2));
  return { az: Math.round(az), dist: Math.round(dist * 10) / 10 };
}

export const SpatialScene = React.memo(function SpatialScene() {
  const { state, lockStatus, updateState } = usePluginState('spatial', 'PRO');
  const lockedByOther = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  const {
    spatialAssignments,
    assignSpatialChannel,
    releaseSpatialChannel,
    resetSpatialAssignments,
    spatialTakeoverRequest,
    clearSpatialTakeoverRequest,
  } = useProject();
  const { samples } = useSamples();
  const stemSamples = useMemo(() => samples.filter((s) => s.type === 'Stem' && s.url), [samples]);

  const [scene, setScene] = useState<SpatialSceneState>(() => {
    const saved = storageGetJson<SpatialSceneState>('spatialmonk-scene');
    return saved?.version === 'spatialMONK-v1' ? saved : cloneScene(DEFAULT_SPATIAL_SCENE);
  });
  const [selectedId, setSelectedId] = useState<number | null>(scene.sources[0]?.id ?? null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<Metrics>({ cpuEstimate: 0, activeSources: 0, instances: 1 });
  const [status, setStatus] = useState('');
  const [listenerRot, setListenerRot] = useState(scene.global.listenerRot);
  const [routingEnabled, setRoutingEnabled] = useState(false);
  const [stemPick, setStemPick] = useState('');

  const clusterRef = useRef<SpatialCluster | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lastDragRef = useRef(0);
  const lastSnapshotRef = useRef<SpatialSceneState>(cloneScene(scene));
  /** Master-Stream-Taps je Spatial-Quelle (from = Master-Bus, to = Worklet-Eingang). */
  const masterTapRef = useRef<Map<number, { from: AudioNode; to: AudioNode }>>(new Map());
  /** Monoton steigende Quell-IDs für Übernahmen (auch bei Stem-Batch). */
  const nextSourceIdRef = useRef(1);

  const sources = scene.sources;
  const global = scene.global;
  const selected = useMemo(() => sources.find((s) => s.id === selectedId) ?? null, [sources, selectedId]);

  // Source-ID-Generator oberhalb vorhandener IDs halten (Stem-Batch, Presets).
  useEffect(() => {
    const maxId = sources.reduce((m, s) => Math.max(m, s.id), 0);
    nextSourceIdRef.current = Math.max(nextSourceIdRef.current, maxId + 1);
  }, [sources]);

  // Scene persistieren (Presets & State, WhitePaper Abschnitt 7).
  useEffect(() => {
    storageSetJson('spatialmonk-scene', scene);
  }, [scene]);

  const syncLegacy = useCallback((s: SpatialSource) => {
    if (!s.track) return;
    try {
      const x = Math.max(-1, Math.min(1, s.az / 90));
      const y = Math.max(-1, Math.min(1, (1.2 - s.dist) / 0.6));
      audioEngine.setSpatialPosition(s.track, x, y);
    } catch { /* Audio noch nicht initialisiert */ }
  }, []);

  const syncCluster = useCallback((s: SpatialSource) => {
    clusterRef.current?.setSourcePos(s.id, { az: s.az, el: s.el, dist: s.dist, gain: s.gain, muted: s.muted }, 40);
  }, []);

  const addSourceToCluster = useCallback((cluster: SpatialCluster, s: SpatialSource) => {
    cluster.addSource(s);
  }, []);

  // Cluster initialisieren (eine Instanz für maxSources Quellen, Auto-Split bei 65% CPU).
  useEffect(() => {
    const ctx = (Tone.getContext().rawContext as unknown as AudioContext) ?? null;
    if (!ctx || !ctx.audioWorklet) return;
    let disposed = false;
    (async () => {
      try {
        const cluster = await SpatialCluster.create(ctx, { maxSources: 8, autoSplitCpuThreshold: 0.65, maxInstances: 4 });
        if (disposed) { cluster.dispose(); return; }
        clusterRef.current = cluster;
        spatialAdapter.attach(cluster);
        cluster.onMetrics = (m) => setMetrics({ cpuEstimate: m.cpuEstimate, activeSources: m.activeSources, instances: m.instances });
        cluster.setGlobal(global.quality, global.listenerRot, global.masterGain);
        scene.sources.forEach((s) => addSourceToCluster(cluster, s));
        cluster.requestMetrics();
      } catch (e) {
        console.warn('[spatialMONK] Worklet-Cluster nicht verfügbar – Legacy-Audio-Pfad aktiv:', (e as Error).message);
      }
    })();
    return () => {
      disposed = true;
      clusterRef.current?.dispose();
      clusterRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchSource = useCallback((id: number, patch: Partial<SpatialSource>) => {
    setScene((prev) => ({
      ...prev,
      sources: prev.sources.map((s) => {
        if (s.id !== id) return s;
        const next = { ...s, ...patch };
        syncCluster(next);
        syncLegacy(next);
        return next;
      }),
    }));
  }, [syncCluster, syncLegacy]);

  const moveFromPointer = useCallback((id: number, nx: number, ny: number) => {
    const now = performance.now();
    if (now - lastDragRef.current < 25) return; // ~40 Hz Throttle
    lastDragRef.current = now;
    const { az, dist } = azDistFromPointer(nx, ny);
    patchSource(id, { az, dist });
  }, [patchSource]);

  const addSourceAt = useCallback((nx: number, ny: number) => {
    if (lockedByOther) return;
    const { az, dist } = azDistFromPointer(nx, ny);
    const id = Math.max(0, ...sources.map((s) => s.id)) + 1;
    const source: SpatialSource = {
      id,
      name: `Quelle ${id}`,
      az,
      el: 0,
      dist,
      gain: 0.9,
      muted: false,
      color: SOURCE_COLORS[id % SOURCE_COLORS.length],
      track: `channel${((id - 1) % 8) + 1}` as SpatialSource['track'],
    };
    setScene((prev) => ({ ...prev, sources: [...prev.sources, source] }));
    clusterRef.current?.addSource(source);
    syncLegacy(source);
    if (routingEnabled && source.track) {
      const input = clusterRef.current?.sourceInput(source.id);
      if (input) audioEngine.routeChannelToSpatialInput(source.track, input);
    }
    setSelectedId(id);
  }, [lockedByOther, sources, syncLegacy, routingEnabled]);

  const removeSelected = useCallback(() => {
    if (selectedId == null) return;
    releaseSpatialSource(selectedId);
    clusterRef.current?.removeSource(selectedId);
    setScene((prev) => ({ ...prev, sources: prev.sources.filter((s) => s.id !== selectedId) }));
    setSelectedId(null);
  }, [selectedId, releaseSpatialSource]);

  /**
   * Trennt Audio-Routing/Taps einer Spatial-Quelle und gibt eine ggf.
   * vorhandene geteilte Kanal-Belegung frei.
   */
  function releaseSpatialSource(sourceId: number) {
    const source = scene.sources.find((s) => s.id === sourceId);
    if (source?.track) {
      try { audioEngine.routeChannelToSpatialInput(source.track, null); } catch { /* noop */ }
      const assigned = Object.entries(spatialAssignments).find(
        ([, a]) => a && spatialChannelTrack(a.channelId) === source.track,
      );
      if (assigned) releaseSpatialChannel(Number(assigned[0]));
    }
    const tap = masterTapRef.current.get(sourceId);
    if (tap) {
      try { tap.from.disconnect(tap.to); } catch { /* noop */ }
      masterTapRef.current.delete(sourceId);
    }
  }

  /**
   * Übernimmt einen Audioinhalt auf einen freien Spatial-Kanal (1..8).
   * 1) geteilter Claim (Race-safe), 2) lokale Quelle anlegen, 3) vorhandenes
   * Audio-Routing nutzen (mixer-Kanal → Worklet-Eingang bzw. Master-Tap).
   */
  const applySpatialTakeover = useCallback(
    (channelId: number, content: AudioContentRef): boolean => {
      if (lockedByOther) {
        setStatus('spatialMONK gesperrt');
        return false;
      }
      const track = spatialChannelTrack(channelId);
      if (scene.sources.some((s) => s.track === track)) {
        setStatus(`Spatial-Kanal ${channelId} ist lokal belegt`);
        return false;
      }
      const res = assignSpatialChannel(channelId, content);
      if (!res.ok) {
        setStatus(`Spatial-Kanal ${channelId} wurde inzwischen belegt`);
        return false;
      }

      const id = nextSourceIdRef.current++;
      const source: SpatialSource = {
        id,
        name: content.name,
        az: 0,
        el: 0,
        dist: 1.2,
        gain: 0.9,
        muted: false,
        color: SOURCE_COLORS[(channelId - 1) % SOURCE_COLORS.length],
        track,
      };
      setScene((prev) => ({ ...prev, sources: [...prev.sources, source] }));
      clusterRef.current?.addSource(source);
      syncLegacy(source);

      if (routingEnabled && source.track) {
        const input = clusterRef.current?.sourceInput(source.id);
        if (input) audioEngine.routeChannelToSpatialInput(source.track, input);
      }

      if (content.url) {
        void audioEngine.loadTrackSample(track, content.url).catch(() => { /* URL optional */ });
      } else if (isStreamContent(content) && content.kind === 'master-stream') {
        const input = clusterRef.current?.sourceInput(source.id);
        const master = audioEngine.getMasterBusInput();
        if (input && master) {
          try {
            master.connect(input);
            masterTapRef.current.set(source.id, { from: master, to: input });
          } catch { /* Tap nicht möglich */ }
        }
      }

      setSelectedId(id);
      setStatus(`Spatial-Kanal ${channelId} ← ${content.name}`);
      return true;
    },
    [lockedByOther, scene.sources, assignSpatialChannel, routingEnabled, syncLegacy],
  );

  // Action-Menu-Übernahmeauftrag konsumieren (Master-Stream, Mixer-Kanal,
  // Samples/Stems über das einheitliche Menü).
  useEffect(() => {
    if (!spatialTakeoverRequest) return;
    applySpatialTakeover(spatialTakeoverRequest.channelId, spatialTakeoverRequest.content);
    clearSpatialTakeoverRequest();
  }, [spatialTakeoverRequest, applySpatialTakeover, clearSpatialTakeoverRequest]);

  /** Übernimmt alle vorhandenen Stems auf je einen eigenen freien Spatial-Kanal. */
  const takeAllStems = useCallback(() => {
    if (stemSamples.length === 0) {
      setStatus('Keine Stems vorhanden');
      return;
    }
    const claimed = new Set<number>();
    let placed = 0;
    for (const stem of stemSamples) {
      const free = SPATIAL_CHANNEL_IDS.find(
        (n) => !claimed.has(n) && !spatialAssignments[n] && !scene.sources.some((s) => s.track === spatialChannelTrack(n)),
      );
      if (!free) {
        setStatus(`Nur ${placed}/${stemSamples.length} Stems platziert – keine freien Kanäle mehr`);
        return;
      }
      if (applySpatialTakeover(free, sampleToContent(stem, 'stem'))) {
        claimed.add(free);
        placed++;
      }
    }
    setStatus(`${placed} Stem(s) auf freie Spatial-Kanäle übernommen`);
  }, [stemSamples, spatialAssignments, scene.sources, applySpatialTakeover]);

  const applyGlobal = useCallback((patch: Partial<SpatialSceneState['global']>) => {
    setScene((prev) => {
      const nextGlobal = { ...prev.global, ...patch };
      clusterRef.current?.setGlobal(nextGlobal.quality, nextGlobal.listenerRot, nextGlobal.masterGain);
      return { ...prev, global: nextGlobal };
    });
  }, []);

  /**
   * Folgeschritt 1: echtes Audio-Graph-Routing der Spuren auf die
   * spatial-processor-Worklet-Eingänge (opt-in, Legacy-Pfad bleibt Standard).
   */
  const applyRouting = useCallback((enabled: boolean) => {
    const cluster = clusterRef.current;
    if (!cluster) return;
    const master = audioEngine.getMasterBusInput();
    if (enabled) {
      if (master) cluster.connect(master);
      scene.sources.forEach((s) => {
        if (!s.track) return;
        const input = cluster.sourceInput(s.id);
        if (input) audioEngine.routeChannelToSpatialInput(s.track, input);
      });
      setStatus('Worklet-Routing aktiv');
    } else {
      cluster.disconnect();
      scene.sources.forEach((s) => {
        if (s.track) audioEngine.routeChannelToSpatialInput(s.track, null);
      });
      setStatus('Worklet-Routing deaktiviert (Legacy-Pfad)');
    }
    setRoutingEnabled(enabled);
  }, [scene.sources]);

  /** Folgeschritt 2: HRTF-Kernel + WASM-partitioned-FFT-Konvolver laden. */
  const loadDefaultHrtf = useCallback(async () => {
    const cluster = clusterRef.current;
    if (!cluster) return;
    await cluster.loadHrtf('/hrtf/default.json');
    const wasmOk = await cluster.loadHrtfWasm('/hrtf/hrtf_conv.wasm');
    setStatus(wasmOk ? 'WASM-FFT-HRTF aktiv (high)' : 'WASM nicht verfügbar – JS-FIR-Kernel aktiv');
  }, []);

  const snapshot = useCallback(() => {
    lastSnapshotRef.current = cloneScene(scene);
    storageSetJson(SNAPSHOT_KEY, scene);
    setStatus('Snapshot gespeichert');
  }, [scene]);

  const undo = useCallback(() => {
    const saved = lastSnapshotRef.current ?? storageGetJson<SpatialSceneState>(SNAPSHOT_KEY);
    if (!saved?.sources) return;
    masterTapRef.current.forEach((tap) => { try { tap.from.disconnect(tap.to); } catch { /* noop */ } });
    masterTapRef.current.clear();
    resetSpatialAssignments();
    setScene(cloneScene(saved));
    setSelectedId(null);
    setStatus('Snapshot wiederhergestellt');
  }, [resetSpatialAssignments]);

  const exportScene = useCallback(() => {
    const json = JSON.stringify(scene, null, 2);
    void navigator.clipboard?.writeText(json).then(() => setStatus('Scene-JSON in Zwischenablage'));
  }, [scene]);

  const loadPreset = useCallback((idx: number) => {
    const preset = SPATIAL_SCENE_PRESETS[idx];
    if (!preset) return;
    const next = cloneScene(preset);
    clusterRef.current?.reset();
    masterTapRef.current.forEach((tap) => { try { tap.from.disconnect(tap.to); } catch { /* noop */ } });
    masterTapRef.current.clear();
    resetSpatialAssignments();
    setScene(next);
    setListenerRot(next.global.listenerRot);
    next.sources.forEach((s) => { clusterRef.current?.addSource(s); syncLegacy(s); });
    setSelectedId(next.sources[0]?.id ?? null);
    setStatus(`Preset geladen: ${idx + 1}`);
  }, [syncLegacy, resetSpatialAssignments]);

  const posStyle = (s: SpatialSource) => {
    const r = Math.min(0.9, s.dist / 2);
    const rad = (s.az * Math.PI) / 180;
    return {
      left: `${50 + Math.sin(rad) * r * 50}%`,
      top: `${50 - Math.cos(rad) * r * 50}%`,
    };
  };

  const handleStagePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (lockedByOther) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    if (Math.hypot(nx, ny) > 1) return;
    setSelectedId(null);
    addSourceAt(nx, ny);
  };

  return (
    <div className={`w-full h-full flex flex-col bg-[#0a0a0a] rounded-xl border ${lockedByOther ? 'border-red-500 opacity-60 grayscale' : 'border-neutral-800'} overflow-hidden text-neutral-300 font-sans shadow-2xl relative`}>
      <div className="px-4 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="spatial" placeholder="MOA: z. B. 'Quelle links vorne platzieren'" />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-linear-to-r from-lime-900/20 to-[#0a0a0a] border-b border-lime-900/30 gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-lime-500/20 flex items-center justify-center border border-lime-500/50 shadow-[0_0_15px_rgba(132,204,22,0.3)]">
            <Box className="w-5 h-5 text-lime-400" />
          </div>
          <div>
            <h2 className="text-lg font-black tracking-widest text-neutral-100 uppercase leading-none">spatialMONK</h2>
            <p className="text-[9px] font-mono text-lime-400/80 tracking-widest mt-0.5">2D SCENE · WORKLET · {metrics.instances} INSTANZ</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={global.layout ?? '10.0'}
            onChange={(e) => {
              const layout = e.target.value;
              applyGlobal({ layout } as any);
              audioEngine.setSpatialSetup(layout);
            }}
            className="bg-black text-white text-xs p-1 rounded border border-neutral-700"
            title="Ausgabe-Layout (2.0 / 2.2 / 4.0 / 4.1 / 4.2 …)"
          >
            {SPATIAL_SETUPS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <select
            value={global.quality}
            onChange={(e) => applyGlobal({ quality: e.target.value as SpatialQuality })}
            className="bg-black text-white text-xs p-1 rounded border border-neutral-700"
            title="Qualität: IR-Länge/FFT-Block/Interpolation"
          >
            <option value="low">LOW</option>
            <option value="medium">MEDIUM</option>
            <option value="high">HIGH</option>
          </select>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-mono text-neutral-500">HEAD</span>
            <input type="range" min={-180} max={180} value={listenerRot}
              onChange={(e) => { const v = Number(e.target.value); setListenerRot(v); applyGlobal({ listenerRot: v }); }}
              className="w-20 accent-lime-500" />
          </div>
          <div className="flex items-center gap-1.5">
            <Volume2 className="w-3 h-3 text-neutral-500" />
            <input type="range" min={0} max={1.5} step={0.01} value={global.masterGain}
              onChange={(e) => applyGlobal({ masterGain: Number(e.target.value) })}
              className="w-20 accent-lime-500" />
          </div>
          <button type="button" onClick={() => clusterRef.current?.splitNow()}
            className="px-2 py-1 rounded border border-lime-500/40 bg-lime-500/10 text-lime-300 text-[9px] font-bold tracking-widest hover:bg-lime-500/20 cursor-pointer">
            SPLIT
          </button>
          <button type="button" onClick={() => applyRouting(!routingEnabled)}
            className={`px-2 py-1 rounded border text-[9px] font-bold tracking-widest cursor-pointer ${routingEnabled ? 'bg-lime-500/20 border-lime-400 text-lime-200' : 'border-neutral-700 text-neutral-400 hover:text-lime-300 hover:border-lime-500/40'}`}>
            {routingEnabled ? 'WORKLET ROUTING ON' : 'WORKLET ROUTING OFF'}
          </button>
          <button type="button" onClick={loadDefaultHrtf}
            className="px-2 py-1 rounded border border-neutral-700 text-neutral-400 text-[9px] font-bold tracking-widest hover:text-lime-300 hover:border-lime-500/40 cursor-pointer">
            HRTF
          </button>
          <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
          </select>
        </div>
      </div>

      {/* Hauptbereich */}
      <div className="flex-1 flex overflow-hidden">
        {/* Scene Canvas */}
        <div className="flex-1 flex items-center justify-center p-4 relative">
          <div
            ref={stageRef}
            onDoubleClick={handleStagePointer}
            className="relative w-full max-w-[520px] aspect-square rounded-full bg-[radial-gradient(circle_at_50%_50%,#101418_0%,#0a0c0e_70%,#060708_100%)] border border-neutral-800 shadow-[0_0_60px_rgba(0,0,0,0.6),inset_0_0_60px_rgba(0,0,0,0.55)] select-none touch-none"
            title="Doppelklick = Quelle hinzufügen"
          >
            {/* Distanz-Ringe */}
            {[0.33, 0.66, 1].map((r) => (
              <div key={r} className="absolute rounded-full border border-neutral-800/60 pointer-events-none"
                style={{ left: `${50 - r * 50}%`, top: `${50 - r * 50}%`, width: `${r * 100}%`, height: `${r * 100}%` }} />
            ))}
            <span className="absolute top-1.5 left-1/2 -translate-x-1/2 text-[8px] font-mono tracking-[0.35em] text-neutral-600 pointer-events-none">VORNE</span>
            <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[8px] font-mono tracking-[0.35em] text-neutral-600 pointer-events-none">HINTEN</span>
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[8px] font-mono tracking-[0.25em] text-neutral-600 pointer-events-none">LINKS</span>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono tracking-[0.25em] text-neutral-600 pointer-events-none">RECHTS</span>

            {/* Listener Mitte + Orientierung */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
              <div className="w-6 h-6 rounded-full bg-neutral-800 border border-neutral-600 flex items-center justify-center">
                <div className="w-1 h-3 rounded-full bg-lime-400 origin-top"
                  style={{ transform: `rotate(${listenerRot}deg) translateY(2px)` }} />
              </div>
            </div>

            {sources.map((s) => (
              <div key={s.id} className="absolute" style={posStyle(s)}>
                <SpatialSourceIcon
                  source={s}
                  selected={selectedId === s.id}
                  onSelect={setSelectedId}
                  onDragMove={moveFromPointer}
                  onDoubleClick={(id) => setRenamingId(id)}
                />
                {renamingId === s.id && (
                  <input
                    autoFocus
                    defaultValue={s.name}
                    onBlur={(e) => { patchSource(s.id, { name: e.target.value || s.name }); setRenamingId(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    className="absolute -top-6 left-1/2 -translate-x-1/2 w-24 bg-black border border-lime-500/50 rounded px-1 py-0.5 text-[9px] text-white z-10"
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Inspector */}
        <div className="w-64 short-landscape:w-52 shrink-0 border-l border-neutral-800 bg-[#0c0c0e] p-3 flex flex-col gap-3 overflow-y-auto">
          <h3 className="text-[10px] font-mono tracking-[0.25em] text-lime-500 uppercase">Inspector</h3>
          {selected ? (
            <>
              <div>
                <span className="text-[9px] font-mono text-neutral-500">NAME</span>
                <input value={selected.name} onChange={(e) => patchSource(selected.id, { name: e.target.value })}
                  className="w-full bg-black border border-neutral-800 rounded px-2 py-1 text-xs text-white mt-0.5" />
              </div>
              <div>
                <span className="text-[9px] font-mono text-neutral-500">AZIMUT · {Math.round(selected.az)}°</span>
                <input type="range" min={-180} max={180} value={selected.az}
                  onChange={(e) => patchSource(selected.id, { az: Number(e.target.value) })}
                  className="w-full accent-lime-500" />
              </div>
              <div>
                <span className="text-[9px] font-mono text-neutral-500">DISTANZ · {selected.dist.toFixed(1)}</span>
                <input type="range" min={0} max={4} step={0.1} value={selected.dist}
                  onChange={(e) => patchSource(selected.id, { dist: Number(e.target.value) })}
                  className="w-full accent-lime-500" />
              </div>
              <div>
                <span className="text-[9px] font-mono text-neutral-500">GAIN · {selected.gain.toFixed(2)}</span>
                <input type="range" min={0} max={1.5} step={0.01} value={selected.gain}
                  onChange={(e) => patchSource(selected.id, { gain: Number(e.target.value) })}
                  className="w-full accent-lime-500" />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => patchSource(selected.id, { muted: !selected.muted })}
                  className={`flex-1 py-1.5 rounded border text-[9px] font-bold tracking-widest cursor-pointer ${selected.muted ? 'bg-red-500/20 border-red-500/50 text-red-300' : 'border-neutral-700 text-neutral-400 hover:text-lime-300'}`}>
                  {selected.muted ? 'MUTED' : 'MUTE'}
                </button>
                <button type="button" onClick={removeSelected}
                  className="flex-1 py-1.5 rounded border border-red-500/40 text-red-400 text-[9px] font-bold tracking-widest hover:bg-red-500/10 cursor-pointer">
                  ENTFERNEN
                </button>
              </div>
              <p className="text-[9px] font-mono text-neutral-600 leading-relaxed">
                Pfeiltasten ±1°, Shift ±5°, Ctrl ±15°. Doppelklick auf Quelle = Umbenennen.
              </p>
            </>
          ) : (
            <p className="text-[10px] font-mono text-neutral-600">Keine Quelle gewählt. Doppelklick in die Scene = neue Quelle.</p>
          )}

          {/* Diagnose-Overlay */}
          <div className="mt-auto pt-2 border-t border-neutral-800">
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-neutral-500 mb-1">
              <Gauge className="w-3 h-3" /> CPU SCHÄTZUNG
            </div>
            <div className="h-2 rounded bg-black border border-neutral-800 overflow-hidden">
              <div className={`h-full ${metrics.cpuEstimate > 0.65 ? 'bg-red-500' : 'bg-lime-500'}`} style={{ width: `${Math.min(100, metrics.cpuEstimate * 100)}%` }} />
            </div>
            <div className="text-[9px] font-mono text-neutral-500 mt-1">
              {Math.round(metrics.cpuEstimate * 100)}% · {metrics.activeSources} QUELLEN · {metrics.instances} INSTANZ
            </div>
            {metrics.cpuEstimate > 0.65 && (
              <div className="text-[9px] font-mono text-amber-400 mt-1">CPU hoch — Qualität umstellen oder Quellen splitten.</div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Bar / Quick Actions */}
      <div className="px-4 py-2 border-t border-neutral-800 bg-black/20 flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => stageRef.current && (() => { const r = stageRef.current.getBoundingClientRect(); addSourceAt(0, 0.4); })()}
          className="flex items-center gap-1 px-2 py-1 rounded border border-neutral-700 text-neutral-400 text-[9px] font-bold tracking-widest hover:text-lime-300 hover:border-lime-500/40 cursor-pointer">
          <Plus className="w-3 h-3" /> QUELLE
        </button>
        <button type="button" onClick={removeSelected} disabled={selectedId == null}
          className="flex items-center gap-1 px-2 py-1 rounded border border-neutral-700 text-neutral-400 text-[9px] font-bold tracking-widest hover:text-red-300 disabled:opacity-40 cursor-pointer">
          <Trash2 className="w-3 h-3" /> ENTFERNEN
        </button>
        <button type="button" onClick={snapshot}
          className="flex items-center gap-1 px-2 py-1 rounded border border-neutral-700 text-neutral-400 text-[9px] font-bold tracking-widest hover:text-lime-300 cursor-pointer">
          <Camera className="w-3 h-3" /> SNAPSHOT
        </button>
        <button type="button" onClick={undo}
          className="flex items-center gap-1 px-2 py-1 rounded border border-neutral-700 text-neutral-400 text-[9px] font-bold tracking-widest hover:text-lime-300 cursor-pointer">
          <RotateCcw className="w-3 h-3" /> UNDO
        </button>
        <select defaultValue="" onChange={(e) => e.target.value && loadPreset(Number(e.target.value))}
          className="bg-black text-neutral-400 text-[9px] p-1 rounded border border-neutral-700">
          <option value="" disabled>Preset…</option>
          {SPATIAL_SCENE_PRESETS.map((p, i) => <option key={i} value={i}>{i === 0 ? 'Default' : 'Lead+Pad'}</option>)}
        </select>
        <button type="button" onClick={exportScene}
          className="px-2 py-1 rounded border border-neutral-700 text-neutral-400 text-[9px] font-bold tracking-widest hover:text-lime-300 cursor-pointer">
          JSON KOPIEREN
        </button>
      </div>

      {/* Setup-Referenzen: 12.2 / 18.2 / 24.2 (Bilder aus public/) */}
      <div className="px-4 py-2 border-t border-neutral-800 bg-black/20 flex items-center gap-2 overflow-x-auto">
        <span className="text-[8px] font-mono tracking-widest text-neutral-500">SETUPS</span>
        {[
          { src: '/12-2-setup.png', label: '12.2' },
          { src: '/18-2-setup.png', label: '18.2' },
          { src: '/24-2-setup.png', label: '24.2' },
        ].map((s) => (
          <img key={s.src} src={s.src} alt={s.label} title={`${s.label} Setup (Referenz)`}
            className="h-12 rounded border border-neutral-800 hover:border-lime-500/60 transition-colors cursor-zoom-in object-cover" />
        ))}
        <span className="text-[8px] font-mono text-neutral-600">Referenzbilder · Kanalrechnung in docs/SPATIAL_BRIDGE_SPEC.md</span>
      </div>

      {/* Takeover-Leiste: vorhandene Live-Streams + Stems über das einheitliche
          Action-Menu auf freie Spatial-Kanäle übernehmen (kein 3D, kein neues
          Engine-Feature – nutzt routeChannelToSpatialInput + Master-Bus-Tap). */}
      <div className="px-4 py-2 border-t border-neutral-800 bg-black/20 flex items-center gap-1.5 flex-wrap">
        <Radio className="w-3 h-3 text-lime-400" />
        <span className="text-[8px] font-mono tracking-[0.2em] text-lime-500">ÜBERNEHMEN</span>
        <button type="button"
          onClick={(e) => openAudioActionMenu(masterStreamContent(), e.currentTarget)}
          className="px-2 py-1 rounded border border-lime-500/40 bg-lime-500/10 text-lime-300 text-[9px] font-bold tracking-widest hover:bg-lime-500/20 cursor-pointer"
          title="Master-Player-Stream auf einen freien Spatial-Kanal übernehmen"
        >
          MASTER
        </button>
        {ALL_TRACKS.map((t) => (
          <button type="button"
            key={t}
            onClick={(e) => openAudioActionMenu(mixerChannelContent(t), e.currentTarget)}
            className="px-1.5 py-1 rounded border border-neutral-700 text-neutral-400 text-[9px] font-bold tracking-widest hover:text-lime-300 hover:border-lime-500/40 cursor-pointer"
            title={`MixerMONK ${t.toUpperCase().replace('CHANNEL', 'K')} auf freien Spatial-Kanal übernehmen`}
          >
            {t.replace('channel', 'K')}
          </button>
        ))}
        <select
          value={stemPick}
          onChange={(e) => setStemPick(e.target.value)}
          className="bg-black text-neutral-400 text-[9px] p-1 rounded border border-neutral-700 max-w-[140px]"
          title="Vorhandenen Stem wählen (aus stemMONK/Library)"
        >
          <option value="">Stem…</option>
          {stemSamples.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button type="button"
          disabled={!stemPick}
          onClick={(e) => {
            const stem = stemSamples.find((s) => s.id === stemPick);
            if (stem) openAudioActionMenu(sampleToContent(stem, 'stem'), e.currentTarget);
          }}
          className="px-2 py-1 rounded border border-neutral-700 text-neutral-400 text-[9px] font-bold tracking-widest hover:text-lime-300 disabled:opacity-40 cursor-pointer"
          title="Einzelnen Stem über das Action-Menu übernehmen"
        >
          STEM
        </button>
        <button type="button"
          onClick={takeAllStems}
          disabled={stemSamples.length === 0}
          className="px-2 py-1 rounded border border-lime-500/40 text-lime-300 text-[9px] font-bold tracking-widest hover:bg-lime-500/10 disabled:opacity-40 cursor-pointer"
          title="Alle vorhandenen Stems auf je einen eigenen freien Spatial-Kanal legen"
        >
          ALLE STEMS
        </button>
        {status && <span className="text-[9px] font-mono text-lime-400">{status}</span>}
      </div>
    </div>
  );
});
