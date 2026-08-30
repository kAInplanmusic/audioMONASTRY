import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { random } from '../utils/random';
import { Box, Play, Pause, Ruler, RotateCw } from 'lucide-react';
import { DropTarget } from './DropTarget';
import { AudioSample } from '../data/samples';
import { useSamples } from '../context/SampleContext';
import { usePluginState } from '../hooks/usePluginState';
import {
  generateCircularPath,
  generateLissajousPath,
  generatePingPongPath,
} from '../utils/spatialAutomation';
import { audioEngine } from '../utils/audioEngine';
import { storageGet, storageSet } from '../utils/storage';
import { MoaAssistant } from './MoaAssistant';
import { TrackType } from '../types';
import { RoomPlannerPanel } from './RoomPlannerPanel';
import { calculateChannelPan, calculateHRTF, type SpatialSetup } from '../utils/spatialMath';

type MotionPreset = 'CIRCLE' | 'LISS' | 'EIGHT' | 'PINGPONG' | 'CHAOS';

interface SpatialNode {
  id: string;
  label: string;
  track: TrackType;
  x: number; // -1 links … +1 rechts
  y: number; // -1 hinten … +1 vorne
  color: string;
  active: boolean;
}

const DEFAULT_NODES: SpatialNode[] = [
  { id: 'kick',  label: 'KICK',  track: 'channel1', x: 0,     y: 0.15, color: '#f43f5e', active: true },
  { id: 'hat',   label: 'HAT',   track: 'channel2', x: 0.55,  y: 0.05, color: '#10b981', active: true },
  { id: 'clap',  label: 'CLAP',  track: 'channel3', x: -0.5,  y: 0.1,  color: '#f59e0b', active: true },
  { id: 'perc',  label: 'PERC',  track: 'channel4', x: -0.72, y: 0.45, color: '#8b5cf6', active: true },
  { id: 'snare', label: 'SNARE', track: 'channel5', x: -0.25, y: 0.55, color: '#3b82f6', active: true },
  { id: 'bass',  label: 'BASS',  track: 'channel7', x: 0.1,   y: -0.05, color: '#22d3ee', active: true },
  { id: 'lead',  label: 'LEAD',  track: 'channel8', x: 0.35,  y: 0.6,  color: '#f97316', active: true },
];

const MOTION_PRESETS: { id: MotionPreset; label: string }[] = [
  { id: 'CIRCLE', label: 'Kreis' },
  { id: 'EIGHT', label: 'Acht' },
  { id: 'LISS', label: 'Lissajous' },
  { id: 'PINGPONG', label: 'Ping-Pong' },
  { id: 'CHAOS', label: 'Chaos' },
];

const SCENE_PRESETS: { id: string; label: string; apply: (n: SpatialNode) => { x: number; y: number } }[] = [
  {
    id: 'RESET', label: 'Reset',
    apply: (n) => DEFAULT_NODES.find((d) => d.id === n.id) ?? n,
  },
  {
    id: 'WIDE', label: 'Breit',
    apply: (n) => {
      const idx = DEFAULT_NODES.findIndex((d) => d.id === n.id);
      const side = idx % 2 === 0 ? -1 : 1;
      return { x: side * (0.5 + 0.12 * idx), y: 0.15 * (idx % 3) - 0.15 };
    },
  },
  {
    id: 'CLUB', label: 'Club',
    apply: () => ({ x: (random() - 0.5) * 0.5, y: 0.3 + random() * 0.6 }),
  },
  {
    id: 'FACE', label: 'In-Your-Face',
    apply: () => ({ x: (random() - 0.5) * 0.3, y: 0.75 + random() * 0.2 }),
  },
  {
    id: 'BACK', label: 'Rückwand',
    apply: () => ({ x: (random() - 0.5) * 1.2, y: -0.6 - random() * 0.35 }),
  },
  {
    id: 'RING', label: 'Ring',
    apply: (n) => {
      const idx = DEFAULT_NODES.findIndex((d) => d.id === n.id);
      const a = (idx / Math.max(1, DEFAULT_NODES.length)) * 2 * Math.PI;
      return { x: Math.sin(a) * 0.75, y: Math.cos(a) * 0.75 };
    },
  },
];

function buildMotionPath(preset: MotionPreset, steps = 128): { x: number; y: number }[] {
  switch (preset) {
    case 'CIRCLE': return generateCircularPath(0.7, steps);
    case 'EIGHT': return generateLissajousPath(1, 2, steps);
    case 'LISS': return generateLissajousPath(3, 2, steps);
    case 'PINGPONG': return generatePingPongPath(0.85, steps);
    case 'CHAOS': return Array.from({ length: steps }, () => ({ x: random() * 2 - 1, y: random() * 2 - 1 }));
  }
}

function SpatialStage({ nodes, setup, selectedId, motionPath, lfoActive, onSelect, onMove }: {
  nodes: SpatialNode[];
  setup: SpatialSetup;
  selectedId: string | null;
  motionPath: { x: number; y: number }[];
  lfoActive: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<string | null>(null);

  const posStyle = (x: number, y: number) => ({
    left: `${50 + x * 50}%`,
    top: `${50 - y * 50}%`,
  });

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const id = dragRef.current;
    if (!id || !boxRef.current) return;
    const rect = boxRef.current.getBoundingClientRect();
    const nx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    const ny = -(e.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    const r = Math.hypot(nx, ny) || 1;
    onMove(id, r > 1 ? nx / r : nx, r > 1 ? ny / r : ny);
  };

  const speakers = useMemo(() => {
    const n = Math.max(2, setup.numChannels);
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * 2 * Math.PI;
      return { x: Math.sin(a), y: Math.cos(a) };
    });
  }, [setup.numChannels]);

  // Aktive Lautsprecher (Gewichte > 0.05) für den ausgewählten Node.
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const activeSpeakerIdx = useMemo(() => {
    if (!selected) return new Set<number>();
    const pan = calculateChannelPan(selected.x, selected.y, setup.id);
    const set = new Set<number>();
    pan.channels.forEach((w, i) => { if (w > 0.05) set.add(i); });
    return set;
  }, [selected, setup.id]);

  return (
    <div
      ref={boxRef}
      onPointerMove={handlePointerMove}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerLeave={() => { dragRef.current = null; }}
      className="relative w-full aspect-square rounded-full bg-[radial-gradient(circle_at_50%_50%,#101418_0%,#0a0c0e_70%,#060708_100%)] border border-neutral-800 shadow-[0_0_60px_rgba(0,0,0,0.6),inset_0_0_60px_rgba(0,0,0,0.55)] select-none touch-none"
    >
      {/* Lautsprecher-Ring */}
      {speakers.map((s, i) => (
        <div
          key={i}
          className={`absolute w-2 h-2 rounded-full border -translate-x-1/2 -translate-y-1/2 pointer-events-none transition-colors ${
            activeSpeakerIdx.has(i)
              ? 'bg-lime-300 border-lime-200 shadow-[0_0_10px_rgba(163,230,53,0.9)] scale-125'
              : 'bg-neutral-700 border-neutral-600'
          }`}
          style={posStyle(s.x, s.y)}
        />
      ))}

      {/* LFO-Pfad-Vorschau */}
      {lfoActive && motionPath.length > 1 && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline
            points={motionPath.map((p) => `${50 + p.x * 50},${50 - p.y * 50}`).join(' ')}
            fill="none"
            stroke="rgba(163,230,53,0.4)"
            strokeWidth="0.5"
            strokeDasharray="1.5 1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}

      {/* Richtungs-Labels */}
      <span className="absolute top-1.5 left-1/2 -translate-x-1/2 text-[8px] font-mono tracking-[0.35em] text-neutral-600 pointer-events-none">VORNE</span>
      <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[8px] font-mono tracking-[0.35em] text-neutral-600 pointer-events-none">HINTEN</span>
      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[8px] font-mono tracking-[0.25em] text-neutral-600 pointer-events-none">LINKS</span>
      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono tracking-[0.25em] text-neutral-600 pointer-events-none">RECHTS</span>

      {/* Mitte */}
      <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 rounded-full bg-neutral-600 -translate-x-1/2 -translate-y-1/2 pointer-events-none" />

      {/* Nodes (dragbar) */}
      {nodes.map((n) => (
        <div
          key={n.id}
          role="button"
          tabIndex={0}
          aria-label={`${n.label} positionieren`}
          onClick={() => onSelect(n.id)}
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
            dragRef.current = n.id;
            onSelect(n.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') onMove(n.id, Math.max(-1, n.x - 0.05), n.y);
            if (e.key === 'ArrowRight') onMove(n.id, Math.min(1, n.x + 0.05), n.y);
            if (e.key === 'ArrowUp') onMove(n.id, n.x, Math.min(1, n.y + 0.05));
            if (e.key === 'ArrowDown') onMove(n.id, n.x, Math.max(-1, n.y - 0.05));
          }}
          className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 cursor-grab active:cursor-grabbing transition-transform hover:scale-110 ${
            n.active ? '' : 'opacity-25 grayscale'
          } ${selectedId === n.id ? 'ring-2 ring-white/40 scale-110' : ''}`}
          style={{
            ...posStyle(n.x, n.y),
            width: 22,
            height: 22,
            backgroundColor: n.color,
            borderColor: selectedId === n.id ? '#fff' : 'rgba(255,255,255,0.35)',
            boxShadow: `0 0 14px ${n.color}66`,
          }}
        >
          <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 text-[8px] font-mono font-bold tracking-wider text-neutral-300 whitespace-nowrap pointer-events-none">
            {n.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SpatialPluginTerminal() {
  const { lockStatus } = usePluginState('spatial', 'PRO');
  const { pendingSample, setPendingSample } = useSamples();
  const lockedByOther = lockStatus.active && lockStatus.lockedBy !== 'localUser';

  const [nodes, setNodes] = useState<SpatialNode[]>(DEFAULT_NODES);
  const [setupId, setSetupId] = useState('10.0');
  const [spatialMode, setSpatialModeState] = useState<'ON_TOP' | 'SEPARATION'>('ON_TOP');
  const [selectedId, setSelectedId] = useState<string | null>('kick');
  const [showRoomPlan, setShowRoomPlan] = useState(false);
  const [lfoActive, setLfoActive] = useState(false);
  const [motionPath, setMotionPath] = useState<MotionPreset>('CIRCLE');
  const [speed, setSpeed] = useState(5); // 1..10
  const frameRef = useRef(0);

  const setup = useMemo(() => {
    const list = audioEngine.getSpatialSetups();
    return list.find((s) => s.id === setupId) ?? list[0];
  }, [setupId]);

  const pathPoints = useMemo(() => buildMotionPath(motionPath), [motionPath]);

  // Initial: Engine-Setup + Positionen anwenden.
  useEffect(() => {
    const savedSetup = storageGet('spatial-setup-id');
    if (savedSetup && audioEngine.getSpatialSetups().some((s) => s.id === savedSetup)) {
      audioEngine.setSpatialSetup(savedSetup);
      setSetupId(audioEngine.getSpatialSetupId());
    }
    const savedMode = storageGet('spatial-mode');
    if (savedMode === 'ON_TOP' || savedMode === 'SEPARATION') {
      audioEngine.setSpatialMode(savedMode);
      setSpatialModeState(savedMode);
    }
    DEFAULT_NODES.forEach((n) => audioEngine.setSpatialPosition(n.track, n.x, n.y));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPosition = useCallback((node: SpatialNode, x: number, y: number) => {
    if (node.active) audioEngine.setSpatialPosition(node.track, x, y);
  }, []);

  const moveNode = useCallback((id: string, x: number, y: number) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, x, y } : n)));
    const node = nodes.find((n) => n.id === id);
    if (node) applyPosition(node, x, y);
  }, [nodes, applyPosition]);

  const toggleActive = (id: string) => {
    setNodes((prev) => prev.map((n) => {
      if (n.id !== id) return n;
      const active = !n.active;
      if (active) audioEngine.setSpatialPosition(n.track, n.x, n.y);
      return { ...n, active };
    }));
  };

  // LFO: aktive Nodes wandern phasenversetzt über den gewählten Pfad.
  useEffect(() => {
    if (!lfoActive) return;
    const path = pathPoints;
    const intervalMs = Math.max(20, 140 - speed * 12);
    const id = setInterval(() => {
      frameRef.current = (frameRef.current + 1) % path.length;
      const frame = frameRef.current;
      setNodes((prev) => {
        const active = prev.filter((n) => n.active);
        return prev.map((n, i) => {
          if (!n.active) return n;
          const spreadIdx = active.length > 1
            ? (frame + Math.floor(i * path.length / active.length)) % path.length
            : frame;
          const p = path[spreadIdx];
          audioEngine.setSpatialPosition(n.track, p.x, p.y);
          return { ...n, x: p.x, y: p.y };
        });
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [lfoActive, pathPoints, speed]);

  const changeSetup = (id: string) => {
    audioEngine.setSpatialSetup(id);
    setSetupId(id);
    storageSet('spatial-setup-id', id);
  };

  const changeMode = (mode: 'ON_TOP' | 'SEPARATION') => {
    audioEngine.setSpatialMode(mode);
    setSpatialModeState(mode);
    storageSet('spatial-mode', mode);
  };

  const applyScene = (sceneId: string) => {
    const scene = SCENE_PRESETS.find((s) => s.id === sceneId);
    if (!scene) return;
    setNodes((prev) => prev.map((n) => {
      const p = scene.apply(n);
      const nx = Math.max(-1, Math.min(1, p.x));
      const ny = Math.max(-1, Math.min(1, p.y));
      if (n.active) audioEngine.setSpatialPosition(n.track, nx, ny);
      return { ...n, x: nx, y: ny };
    }));
  };

  const handleSampleDrop = (sample: AudioSample) => {
    if (lockedByOther) return;
    const idx = nodes.length + 1;
    const node: SpatialNode = {
      id: `sample-${Date.now()}`,
      label: sample.name.toUpperCase().substring(0, 6),
      track: `channel${Math.min(8, (idx % 8) + 1)}` as TrackType,
      x: (random() - 0.5) * 0.6,
      y: 0.2 + random() * 0.6,
      color: '#f59e0b',
      active: true,
    };
    setNodes((prev) => [...prev, node]);
    audioEngine.setSpatialPosition(node.track, node.x, node.y);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const readout = useMemo(() => {
    if (!selected) return null;
    const hrtf = calculateHRTF(selected.x, selected.y);
    const pan = calculateChannelPan(selected.x, selected.y, setup.id);
    const top = pan.channels
      .map((w, i) => ({ i, w }))
      .filter((c) => c.w > 0.02)
      .sort((a, b) => b.w - a.w)
      .slice(0, 3);
    return { hrtf, top };
  }, [selected, setup.id]);

  return (
    <div className={`w-full h-full flex flex-col bg-[#0a0a0a] rounded-xl border ${lockedByOther ? 'border-red-500 opacity-60 grayscale' : 'border-neutral-800'} overflow-hidden text-neutral-300 font-sans shadow-2xl relative`}>
      <div className="px-4 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="spatial" placeholder="MOA: z. B. 'Setup 5.1, Modus SEPARATION'" />
      </div>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-linear-to-r from-lime-900/20 to-[#0a0a0a] border-b border-lime-900/30 gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-lime-500/20 flex items-center justify-center border border-lime-500/50 shadow-[0_0_15px_rgba(132,204,22,0.3)]">
            <Box className="w-5 h-5 text-lime-400" />
          </div>
          <div>
            <h2 className="text-lg font-black tracking-widest text-neutral-100 uppercase leading-none">Spatial Studio</h2>
            <p className="text-[9px] font-mono text-lime-400/80 tracking-widest mt-0.5">360° POSITIONIERUNG · LIVE</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={setupId}
            onChange={(e) => changeSetup(e.target.value)}
            disabled={lockedByOther}
            title="Lautsprecher-Konfiguration"
            className="bg-black border border-neutral-800 rounded px-2 py-1.5 text-[10px] font-mono text-lime-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-lime-400/60 cursor-pointer"
          >
            {audioEngine.getSpatialSetups().map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>

          <div className="flex items-center gap-1 bg-black p-1 rounded border border-neutral-800">
            <button type="button"
              onClick={() => changeMode('ON_TOP')}
              disabled={lockedByOther}
              className={`px-2.5 py-1 text-[9px] font-bold rounded cursor-pointer transition-colors ${spatialMode === 'ON_TOP' ? 'bg-lime-600 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}
            >
              ON TOP
            </button>
            <button type="button"
              onClick={() => changeMode('SEPARATION')}
              disabled={lockedByOther}
              className={`px-2.5 py-1 text-[9px] font-bold rounded cursor-pointer transition-colors ${spatialMode === 'SEPARATION' ? 'bg-lime-600 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}
            >
              SEPARATION
            </button>
          </div>

          <button type="button"
            onClick={() => setShowRoomPlan(true)}
            className="px-3 py-1.5 rounded text-[9px] font-bold tracking-widest flex items-center gap-1.5 bg-lime-900/30 border border-lime-600/50 text-lime-300 hover:bg-lime-800/40 cursor-pointer"
          >
            <Ruler className="w-3.5 h-3.5" /> RAUMPLAN
          </button>
        </div>
      </div>

      {/* Hauptbereich */}
      <div className="flex-1 flex gap-4 short-landscape:gap-2 p-4 short-landscape:p-2 overflow-hidden min-h-0">
        {/* Linke Spalte */}
        <aside className="w-[210px] short-landscape:w-[180px] shrink-0 flex flex-col gap-3 overflow-y-auto pr-1">
          {/* Stems */}
          <div className="bg-[#111] rounded-xl border border-neutral-800 p-3">
            <h3 className="text-[10px] font-bold tracking-widest text-neutral-500 mb-2">STEMS ({nodes.filter((n) => n.active).length}/{nodes.length})</h3>
            <div className="flex flex-col gap-1.5">
              {nodes.map((n) => (
                <div
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  className={`flex items-center gap-2 p-1.5 rounded cursor-pointer border ${selectedId === n.id ? 'bg-white/5 border-neutral-600' : 'bg-black/40 border-transparent hover:border-neutral-700'}`}
                  onClick={() => setSelectedId(n.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(n.id); } }}
                >
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); toggleActive(n.id); }}
                    title={n.active ? 'Stem deaktivieren' : 'Stem aktivieren'}
                    className={`w-3.5 h-3.5 rounded-full border border-white/30 shrink-0 cursor-pointer ${n.active ? '' : 'bg-neutral-800'}`}
                    style={n.active ? { backgroundColor: n.color } : undefined}
                  />
                  <span className={`text-[10px] font-mono font-bold flex-1 truncate ${n.active ? 'text-neutral-200' : 'text-neutral-600 line-through'}`}>{n.label}</span>
                  <span className="text-[8px] font-mono text-neutral-600">{n.x.toFixed(1)},{n.y.toFixed(1)}</span>
                </div>
              ))}
            </div>
            <p className="text-[8px] font-mono text-neutral-600 mt-2 leading-relaxed">Sample aus der Library auf die Bühne ziehen, um eine neue Spur hinzuzufügen.</p>
          </div>

          {/* Automation */}
          <div className="bg-[#111] rounded-xl border border-neutral-800 p-3">
            <h3 className="text-[10px] font-bold tracking-widest text-neutral-500 mb-2">AUTOMATION</h3>
            <div className="flex flex-col gap-1.5">
              {MOTION_PRESETS.map((m) => (
                <button type="button"
                  key={m.id}
                  onClick={() => setMotionPath(m.id)}
                  disabled={lockedByOther}
                  className={`px-2 py-1.5 rounded text-[9px] font-bold tracking-widest text-left cursor-pointer transition-colors ${motionPath === m.id ? 'bg-lime-500/15 text-lime-300 border border-lime-500/40' : 'bg-black/40 text-neutral-500 border border-transparent hover:text-neutral-300'}`}
                >
                  {motionPath === m.id ? '● ' : '○ '}{m.label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button type="button"
                onClick={() => setLfoActive((v) => !v)}
                disabled={lockedByOther}
                className={`flex-1 px-2 py-1.5 rounded text-[9px] font-bold tracking-widest flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${lfoActive ? 'bg-lime-500/20 text-lime-300 border border-lime-500/50' : 'bg-[#222] text-neutral-400 border border-neutral-700 hover:bg-[#333]'}`}
              >
                {lfoActive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                {lfoActive ? 'LFO STOP' : 'LFO START'}
              </button>
            </div>
            <label className="mt-2 flex flex-col gap-1">
              <span className="flex justify-between text-[8px] font-mono text-neutral-500 uppercase tracking-widest">
                Speed <span className="text-lime-300">{speed}/10</span>
              </span>
              <input type="range" min={1} max={10} step={1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full h-1 accent-lime-400 cursor-pointer" />
            </label>
          </div>

          {/* Readout */}
          {readout && selected && (
            <div className="bg-[#111] rounded-xl border border-neutral-800 p-3">
              <h3 className="text-[10px] font-bold tracking-widest text-neutral-500 mb-2">POSITION · {selected.label}</h3>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[9px] font-mono">
                <span className="text-neutral-500">Azimut</span>
                <span className="text-lime-300 text-right">{readout.hrtf.azimuth.toFixed(0)}°</span>
                <span className="text-neutral-500">ILD</span>
                <span className="text-lime-300 text-right">{readout.hrtf.ildDb.toFixed(1)} dB</span>
                <span className="text-neutral-500">ITD</span>
                <span className="text-lime-300 text-right">{readout.hrtf.itdSamples} Samples</span>
              </div>
              <div className="mt-2 flex gap-1">
                {readout.top.map((c) => (
                  <div key={c.i} className="flex-1 rounded bg-black/50 border border-neutral-800 px-1.5 py-1 text-center">
                    <div className="text-[8px] text-neutral-500">CH {c.i + 1}</div>
                    <div className="text-[10px] font-bold text-lime-300">{Math.round(c.w * 100)}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Bühne */}
        <main className="flex-1 min-w-0 flex flex-col gap-3">
          <DropTarget
            label="Sample hierher ziehen"
            onDrop={handleSampleDrop}
            className="flex-1 min-h-0 flex items-center justify-center p-3 border-lime-900/40 hover:border-lime-500/60"
          >
            <div className="w-full h-full max-w-[420px] max-h-[420px] short-landscape:max-w-[260px] short-landscape:max-h-[260px] mx-auto">
              <SpatialStage
                nodes={nodes}
                setup={setup}
                selectedId={selectedId}
                motionPath={pathPoints}
                lfoActive={lfoActive}
                onSelect={setSelectedId}
                onMove={moveNode}
              />
            </div>
          </DropTarget>

          {/* Szenen */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <RotateCw className="w-3 h-3 text-neutral-600" />
            {SCENE_PRESETS.map((s) => (
              <button type="button"
                key={s.id}
                onClick={() => applyScene(s.id)}
                disabled={lockedByOther}
                className="px-2.5 py-1 rounded-full border border-neutral-800 bg-black/40 text-[9px] font-bold tracking-widest text-neutral-400 hover:text-lime-300 hover:border-lime-500/50 cursor-pointer transition-colors disabled:opacity-40"
              >
                {s.label}
              </button>
            ))}
            {pendingSample && (
              <button type="button"
                onClick={() => {
                  handleSampleDrop(pendingSample);
                  setPendingSample(null);
                }}
                className="px-3 py-1 rounded-full border border-fuchsia-500/60 bg-fuchsia-500/10 text-fuchsia-200 text-[9px] font-bold tracking-widest hover:bg-fuchsia-500/20 cursor-pointer animate-pulse"
              >
                + {pendingSample.name.slice(0, 14)} einsetzen
              </button>
            )}
          </div>
        </main>
      </div>

      {showRoomPlan && <RoomPlannerPanel onClose={() => setShowRoomPlan(false)} />}
    </div>
  );
}
