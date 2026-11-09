import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Tone from '../core/audio/compat/nativeAudioKit';
import { usePluginState } from '../hooks/usePluginState';
import { useProject } from '../context/ProjectContext';
import { useSamples } from '../context/SampleContext';
import { MoaAssistant } from './MoaAssistant';
import { audioEngine } from '../utils/audioEngine';
import { storageGetJson, storageSetJson } from '../utils/storage';
import { readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { SpatialCluster, spatialAdapter } from '../audio/spatial/node';
import { SpatialXYRoomController } from './spatial/SpatialXYRoomController';
import { SpatialClubSetup } from './spatial/SpatialClubSetup';
import { DEFAULT_SPATIAL_SCENE, SPATIAL_SCENE_PRESETS } from '../presets';
import { SPATIAL_SETUPS } from '../utils/spatialMath';
import type { SpatialQuality, SpatialSceneState, SpatialSource} from '../types';
import { ALL_TRACKS } from '../types';
import { openAudioActionMenu } from './AudioActionMenuHost';
import { webRTCManager } from '../utils/WebRTCManager';
import { AmBar, AmCard, AmKnob, AmSeg, AmToggle } from './am/amUi';
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
 * spatialMONK – Rack-Modul (Vorlage public/uidesign/uiübersichtapp.jpg, Zeile 12)
 * ==========================================================================
 * Eine Zeile: links Modus/Layout/Qualität, Mitte Raum von oben (Listener in
 * der Mitte, Quellen dragbar), rechts Objekt-Liste mit L/R · Höhe · Distanz ·
 * Gain und eine kleine 3D-Ansicht samt Übernahme-Leiste. Positionen laufen über den
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
  const { lockStatus } = usePluginState('spatial', 'PRO');
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
    const saved = readPluginSettings<SpatialSceneState>('spatial', { legacyKey: 'spatialmonk-scene' });
    return saved?.version === 'spatialMONK-v1' ? saved : cloneScene(DEFAULT_SPATIAL_SCENE);
  });
  const [selectedId, setSelectedId] = useState<number | null>(scene.sources[0]?.id ?? null);
  const [metrics, setMetrics] = useState<Metrics>({ cpuEstimate: 0, activeSources: 0, instances: 1 });
  const [status, setStatus] = useState('');
  const [listenerRot, setListenerRot] = useState(scene.global.listenerRot);
  const [routingEnabled, setRoutingEnabled] = useState(false);
  const [stemPick, setStemPick] = useState('');

  const clusterRef = useRef<SpatialCluster | null>(null);
  const lastSnapshotRef = useRef<SpatialSceneState>(cloneScene(scene));
  /** Master-Stream-Taps je Spatial-Quelle (from = Master-Bus, to = Worklet-Eingang). */
  const masterTapRef = useRef<Map<number, { from: AudioNode; to: AudioNode }>>(new Map());
  /** Monoton steigende Quell-IDs für Übernahmen (auch bei Stem-Batch). */
  const nextSourceIdRef = useRef(1);

  const sources = scene.sources;
  const global = scene.global;

  // Source-ID-Generator oberhalb vorhandener IDs halten (Stem-Batch, Presets).
  useEffect(() => {
    const maxId = sources.reduce((m, s) => Math.max(m, s.id), 0);
    nextSourceIdRef.current = Math.max(nextSourceIdRef.current, maxId + 1);
  }, [sources]);

  // Scene persistieren (Presets & State, WhitePaper Abschnitt 7).
  useEffect(() => {
    // Beständige Plugins: Szene an die Session (der nächste Halter startet damit).
    writePluginSettings('spatial', scene);
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

  /** XY-Meterposition -> Legacy-Position (Elevation bleibt fix 0). */
  const moveSourceXY = useCallback((id: number, point: { x: number; y: number }) => {
    if (lockedByOther) return;
    const az = Math.atan2(point.x, point.y) * 180 / Math.PI;
    const dist = Math.hypot(point.x, point.y);
    patchSource(id, { az, dist, el: 0 });
  }, [lockedByOther, patchSource]);

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
// eslint-disable-next-line react-hooks/exhaustive-deps -- bewusst beibehalten (Runde 3, Hook-Deps werden separat auditiert)
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
        // Keine Spatial-only-Datei in einen Mixer/DJ-Track hineinladen:
        // dedizierter Spatial-Injection-Bus wird separat implementiert.
        setStatus('Audio vorgemerkt: Spatial-only-Einspeisung noch nicht aktiv.');
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
   * Legacy ROUTING speiste Worklet-Audio zurück in GLOBAL_MASTER. Das kann
   * DJ-Stereo verfärben oder doppelte Summen erzeugen. Bis zum separaten
   * Spatial-Main-Graph bleibt diese alte Route absichtlich deaktiviert.
   */
  const applyRouting = useCallback((enabled: boolean) => {
    const cluster = clusterRef.current;
    if (cluster) cluster.disconnect();
    scene.sources.forEach((s) => {
      if (s.track) audioEngine.routeChannelToSpatialInput(s.track, null);
    });
    setRoutingEnabled(false);
    setStatus(enabled
      ? 'Spatial-Main-Routing gesperrt: eigener Output und verifiziertes Interface fehlen.'
      : 'Spatial-Routing deaktiviert; DJ/Stereo bleibt unverändert.');
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

  const cpuPct = Math.round(metrics.cpuEstimate * 100);

  return (
    <div className="am-rackrow am-spt" style={lockedByOther ? { opacity: 0.6, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="spatial" />

      {/* Links: Modus / Layout */}
      <AmCard title="Modus" style={{ width: 210 }} right={<span className="am-vb">{metrics.instances} INST</span>}>
        <label className="am-sptf">
          <span className="am-lbl">Layout</span>
          <select
            className="am-sel"
            value={global.layout ?? '10.0'}
            onChange={(e) => {
              const layout = e.target.value;
              applyGlobal({ layout });
              audioEngine.setSpatialSetup(layout);
            }}
            title="Ausgabe-Layout (2.0 / 2.2 / 4.0 / 4.1 / 4.2 …)"
          >
            {SPATIAL_SETUPS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <AmSeg<SpatialQuality>
          label="Qualität: IR-Länge/FFT-Block/Interpolation"
          value={global.quality}
          options={[['low', 'LOW'], ['medium', 'MED'], ['high', 'HIGH']]}
          onChange={(q) => applyGlobal({ quality: q })}
        />
        <div className="am-sptrow">
          <AmToggle on={routingEnabled} onClick={() => applyRouting(!routingEnabled)} disabled title="Spatial-Routing erst nach getrenntem Output und Interface-Verifikation. DJ bleibt Stereo.">
            {routingEnabled ? 'ROUTING ON' : 'ROUTING OFF'}
          </AmToggle>
          <AmToggle on={false} onClick={() => { void loadDefaultHrtf(); }} title="HRTF-Kernel + WASM-FFT laden">HRTF</AmToggle>
          <AmToggle on={false} onClick={() => { /* Bis zum sicheren Audio-Rewire deaktiviert (SP-P0-05). */ }} disabled title="SPLIT pausiert: Audio-Eingänge müssen beim Umzug erst neu verbunden werden">SPLIT</AmToggle>
        </div>
        <div className="am-sptrow am-sptkn">
          <AmKnob size="xs" value={listenerRot} min={-180} max={180} def={0} unit="int" label="Kopf" title="Kopf-Drehung (Grad)"
            onChange={(v) => { const r = Math.round(v); setListenerRot(r); applyGlobal({ listenerRot: r }); }} />
          <AmKnob size="xs" value={global.masterGain} min={0} max={1.5} def={1} unit="pct" label="Gain" title="Gesamt-Gain"
            onChange={(v) => applyGlobal({ masterGain: v })} />
          <select className="am-sel" defaultValue="" onChange={(e) => e.target.value && loadPreset(Number(e.target.value))} aria-label="Szenen-Preset">
            <option value="" disabled>Preset…</option>
            {SPATIAL_SCENE_PRESETS.map((p, i) => <option key={i} value={i}>{i === 0 ? 'Default' : 'Lead+Pad'}</option>)}
          </select>
        </div>
        <div className="am-sptrow">
          <button type="button" className="am-tg" onClick={snapshot} title="Snapshot speichern">SNAP</button>
          <button type="button" className="am-tg" onClick={undo} title="Snapshot wiederherstellen">UNDO</button>
          <button type="button" className="am-tg" onClick={exportScene} title="Scene-JSON in die Zwischenablage kopieren">JSON</button>
        </div>
        <div className="am-sptcpu" title={`CPU-Schätzung ${cpuPct}% · ${metrics.activeSources} Quellen`}>
          <span className="am-lbl">CPU {cpuPct}%</span>
          <i><b style={{ width: `${Math.min(100, cpuPct)}%`, background: metrics.cpuEstimate > 0.65 ? 'var(--hot)' : 'var(--c)' }} /></i>
        </div>
        {metrics.cpuEstimate > 0.65 && <span className="am-hint" style={{ color: 'var(--warn)' }}>CPU hoch — Qualität reduzieren; SPLIT bis zum sicheren Audio-Rewire deaktiviert.</span>}
      </AmCard>

      {/* Metermaßstäbliche 2D-Square-Ansicht, Bewegungen und Performance-Buttons. */}
      <AmCard title="Raum X/Y · Ohrhöhe" style={{ width: 430 }} right={<span className="am-vb">{sources.length} OBJ</span>}>
        <SpatialClubSetup disabled={lockedByOther}
          onLayoutChange={(layoutId) => {
            applyGlobal({ layout: layoutId });
            try { audioEngine.setSpatialSetup(layoutId); } catch { /* hardware gated */ }
          }}/>
        <SpatialXYRoomController
          sources={sources}
          selectedId={selectedId}
          disabled={lockedByOther}
          onSelect={setSelectedId}
          onPosition={moveSourceXY}
          outputLayoutId={global.layout ?? '10.0'}
          onOutputLayoutChange={(layoutId) => {
            applyGlobal({ layout: layoutId });
            try { audioEngine.setSpatialSetup(layoutId); } catch { /* hardware still gated */ }
          }}
        />
      </AmCard>

      {/* Rechts: reine 2D-Objekt-Liste mit XY-Koordinaten und Gain. */}
      <AmCard title="Objekte" style={{ flex: 1, minWidth: 360 }}
        right={(
          <span className="am-sptrow">
            <button type="button" className="am-tg" onClick={() => addSourceAt(0, 0.4)} disabled={lockedByOther} title="Neue Quelle vorne">+ QUELLE</button>
            <button type="button" className="am-tg" onClick={removeSelected} disabled={selectedId == null} title="Gewählte Quelle entfernen">ENTFERNEN</button>
          </span>
        )}>
        <div className="am-sptobj">
          <div className="am-sptoh am-lbl" style={{ gridTemplateColumns: 'minmax(90px, 1.1fr) minmax(145px, 1.4fr) 90px 28px' }}><span>Objekt</span><span>Position X/Y (m)</span><span>Gain</span><span /></div>
          {sources.length === 0 && <span className="am-hint">Keine Quelle. Mit + QUELLE ein neues Spatial-Objekt erstellen.</span>}
          {sources.map((s) => (
            <div key={s.id} className={`am-sptor ${selectedId === s.id ? 'am-on' : ''}`} style={{ gridTemplateColumns: 'minmax(90px, 1.1fr) minmax(145px, 1.4fr) 90px 28px' }} onClick={() => setSelectedId(s.id)}>
              <span className="am-sptnm">
                <i style={{ background: s.color ?? '#a78bfa' }} />
                {selectedId === s.id ? (
                  <input value={s.name} aria-label="Name der Quelle" onChange={(e) => patchSource(s.id, { name: e.target.value })} />
                ) : <b>{s.name}</b>}
              </span>
              <span className="am-hint am-mono" title="Exakte X/Y-Werte im Raum-Controller editierbar">
                X {(Math.sin(s.az * Math.PI / 180) * s.dist).toFixed(2)} m · Y {(Math.cos(s.az * Math.PI / 180) * s.dist).toFixed(2)} m
              </span>
              <span className="am-sptv">
                <AmBar label={`${s.name} Gain`} color={s.color ?? '#a78bfa'} value={s.gain / 1.5} disabled={lockedByOther}
                  onChange={(n) => patchSource(s.id, { gain: Math.round(n * 150) / 100 })} />
                <em>{s.gain.toFixed(2)}</em>
              </span>
              <AmToggle kind="m" on={s.muted} onClick={() => patchSource(s.id, { muted: !s.muted })} ariaLabel={`${s.name} stumm`} disabled={lockedByOther}>M</AmToggle>
            </div>
          ))}
        </div>
      </AmCard>

      {/* Quellen bleiben über den bisherigen Takeover-/Action-Menu-Pfad verfügbar. */}
      <AmCard title="Quellen übernehmen" style={{ width: 236 }}>
        <div className="am-hint">2D auf Ohrhöhe. Keine 3D- oder Höhenansicht.</div>
        <div className="am-sptrow am-spttk">
          <button type="button" className="am-tg am-on"
            onClick={(e) => openAudioActionMenu(masterStreamContent(), e.currentTarget)}
            title="Master-Player-Stream auf einen freien Spatial-Kanal übernehmen">MASTER</button>
          {ALL_TRACKS.map((t) => (
            <button type="button" key={t} className="am-tg"
              onClick={(e) => openAudioActionMenu(mixerChannelContent(t), e.currentTarget)}
              title={`mixerMONK ${t.toUpperCase().replace('CHANNEL', 'K')} auf freien Spatial-Kanal übernehmen`}
            >{t.replace('channel', 'K')}</button>
          ))}
        </div>
        <div className="am-sptrow">
          <select className="am-sel" value={stemPick} onChange={(e) => setStemPick(e.target.value)} aria-label="Stem wählen" title="Vorhandenen Stem wählen (aus stemMONK/Library)">
            <option value="">Stem…</option>
            {stemSamples.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button type="button" className="am-tg" disabled={!stemPick}
            onClick={(e) => {
              const stem = stemSamples.find((s) => s.id === stemPick);
              if (stem) openAudioActionMenu(sampleToContent(stem, 'stem'), e.currentTarget);
            }}
            title="Einzelnen Stem über das Action-Menu übernehmen">STEM</button>
          <button type="button" className="am-tg" onClick={takeAllStems} disabled={stemSamples.length === 0}
            title="Alle vorhandenen Stems auf je einen eigenen freien Spatial-Kanal legen">ALLE</button>
        </div>
        {status && <span className="am-hint am-mono">{status}</span>}
      </AmCard>
    </div>
  );
});
