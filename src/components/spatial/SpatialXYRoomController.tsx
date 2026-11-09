import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SpatialSource } from '../../types';
import type { SpatialVec2 } from '../../core/spatial/v2/model';
import {
  calculateSquarePerimeterSpeakers,
  proposeSquareCalibration,
  type SquareSpeakerCount,
} from '../../core/spatial/v2/squareRoom';
import {
  SPATIAL_MOTION_OPTIONS,
  parseSpatialMotionText,
  positionAtSpatialTime,
  type SpatialMotionKind,
  type SpatialMotionPlan,
} from '../../core/spatial/v2/motion';
import { storageGetJson, storageSetJson } from '../../utils/storage';

/**
 * Square two-axis XY room controller: all speakers are at ear level.
 * Existing audioEngine/legacy position bridge remains responsible for
 * playback; this component does NOT claim calibrated hardware output.
 */
const PREF_KEY = 'spatialmonk-v2-xy-room-ui';
const DEFAULT_BUTTONS: SpatialMotionKind[] = [
  'orbit-clockwise', 'front-to-back', 'left-right-left-right', 'square-perimeter',
];
interface Preferences {
  sideM: number;
  satellites: SquareSpeakerCount;
  subs: 0 | 1 | 2;
  durationSec: number;
  radiusFraction: number;
  loop: boolean;
  buttonActions: SpatialMotionKind[];
  prompt: string;
  speakerOverrides: Record<string, SpatialVec2>;
}
const DEFAULT_PREFS: Preferences = {
  sideM: 4, satellites: 16, subs: 0,
  durationSec: 4, radiusFraction: 0.8, loop: false,
  buttonActions: [...DEFAULT_BUTTONS], prompt: '', speakerOverrides: {},
};
function restorePreferences(): Preferences {
  const saved = storageGetJson<Partial<Preferences>>(PREF_KEY);
  if (!saved) return { ...DEFAULT_PREFS, buttonActions: [...DEFAULT_BUTTONS] };
  return {
    sideM: typeof saved.sideM === 'number' && Number.isFinite(saved.sideM)
      ? Math.min(60, Math.max(1, saved.sideM)) : 4,
    satellites: ([12, 16, 18, 24].includes(saved.satellites ?? -1)
      ? saved.satellites : 16) as SquareSpeakerCount,
    subs: ([0, 1, 2].includes(saved.subs ?? -1) ? saved.subs : 0) as 0 | 1 | 2,
    durationSec: typeof saved.durationSec === 'number' && Number.isFinite(saved.durationSec)
      ? Math.min(300, Math.max(0.1, saved.durationSec)) : 4,
    radiusFraction: typeof saved.radiusFraction === 'number' && Number.isFinite(saved.radiusFraction)
      ? Math.min(1, Math.max(0, saved.radiusFraction)) : 0.8,
    loop: saved.loop === true,
    buttonActions: DEFAULT_BUTTONS.map((defaultKind, i) => {
      const candidate = saved.buttonActions?.[i];
      return SPATIAL_MOTION_OPTIONS.some((option) => option.value === candidate)
        ? candidate as SpatialMotionKind : defaultKind;
    }),
    prompt: typeof saved.prompt === 'string' ? saved.prompt.slice(0, 500) : '',
    speakerOverrides: saved.speakerOverrides && typeof saved.speakerOverrides === 'object' && !Array.isArray(saved.speakerOverrides)
      ? Object.fromEntries(Object.entries(saved.speakerOverrides).filter(([, point]) => point &&
          typeof point.x === 'number' && Number.isFinite(point.x) &&
          typeof point.y === 'number' && Number.isFinite(point.y)))
      : {},
  };
}

const toMetres = (source: SpatialSource): SpatialVec2 => {
  const radians = source.az * Math.PI / 180;
  return { x: Math.sin(radians) * source.dist, y: Math.cos(radians) * source.dist };
};
const coordinate = (n: number, sideM: number): number =>
  Math.min(sideM / 2, Math.max(-sideM / 2, Number.isFinite(n) ? n : 0));

interface Props {
  sources: readonly SpatialSource[];
  selectedId: number | null;
  disabled: boolean;
  onSelect: (id: number) => void;
  onPosition: (id: number, positionM: SpatialVec2) => void;
}

export const SpatialXYRoomController = React.memo(function SpatialXYRoomController({
  sources, selectedId, disabled, onSelect, onPosition,
}: Props) {
  const [prefs, setPrefs] = useState(restorePreferences);
  const [selectedMotion, setSelectedMotion] = useState<SpatialMotionKind>('orbit-clockwise');
  const [editingSpeakerId, setEditingSpeakerId] = useState('sat-01');
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState('XY-Draufsicht. Output/Kalibrierung nur als Simulation.');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const lastMoveMs = useRef(0);
  const runningRef = useRef<{ request: number; startMs: number; sourceId: number } | null>(null);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;

  useEffect(() => { storageSetJson(PREF_KEY, prefs); }, [prefs]);
  const speakers = useMemo(() => calculateSquarePerimeterSpeakers(
    prefs.sideM, prefs.satellites, prefs.subs,
  ).map((speaker) => {
    const requested = prefs.speakerOverrides[speaker.id];
    if (!requested) return speaker;
    const half = prefs.sideM / 2;
    // Clamp saved/manual coordinates when a smaller room is selected.
    return { ...speaker, positionM: {
      x: Math.min(half, Math.max(-half, requested.x)),
      y: Math.min(half, Math.max(-half, requested.y)),
    } };
  }), [prefs.sideM, prefs.satellites, prefs.subs, prefs.speakerOverrides]);
  const editingSpeaker = speakers.find((speaker) => speaker.id === editingSpeakerId) ?? speakers[0];
  const setSpeakerCoordinate = (axis: 'x' | 'y', value: number) => {
    if (disabled || !editingSpeaker || !Number.isFinite(value)) return;
    const half = prefs.sideM / 2;
    const next = Math.min(half, Math.max(-half, value));
    setPrefs((old) => ({ ...old, speakerOverrides: {
      ...old.speakerOverrides,
      [editingSpeaker.id]: { ...editingSpeaker.positionM, [axis]: next },
    } }));
  };
  const calibration = useMemo(
    () => proposeSquareCalibration(speakers),
    [speakers],
  );
  const selected = sources.find((s) => s.id === selectedId);
  const selectedXY = selected ? toMetres(selected) : null;
  const toScreen = useCallback((point: SpatialVec2) => ({
    x: 30 + (0.5 + point.x / prefs.sideM) * 340,
    y: 30 + (0.5 - point.y / prefs.sideM) * 340,
  }), [prefs.sideM]);

  const fromPointer = (clientX: number, clientY: number): SpatialVec2 | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const local = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    // The actual room boundary spans viewBox 30..370, not the entire SVG.
    return {
      x: coordinate(((local.x - 30) / 340 - 0.5) * prefs.sideM, prefs.sideM),
      y: coordinate((0.5 - (local.y - 30) / 340) * prefs.sideM, prefs.sideM),
    };
  };

  const stop = useCallback(() => {
    const current = runningRef.current;
    if (current) cancelAnimationFrame(current.request);
    runningRef.current = null;
    setPlaying(false);
  }, []);

  const launch = useCallback((kind: SpatialMotionKind, durationSec = prefs.durationSec, loop = prefs.loop) => {
    stop();
    if (disabled || selectedId === null) {
      setMessage('Zuerst eine entsperrte Audioquelle auswählen.');
      return;
    }
    const plan: SpatialMotionPlan = {
      kind, sideM: prefs.sideM, durationSec, loop, radiusFraction: prefs.radiusFraction,
    };
    const id = selectedId;
    const startMs = performance.now();
    lastMoveMs.current = -Infinity;
    const tick = (now: number) => {
      if (!runningRef.current || runningRef.current.sourceId !== id) return;
      const elapsed = Math.max(0, (now - startMs) / 1000);
      if (now - lastMoveMs.current >= 32 || (!loop && elapsed >= durationSec)) {
        const p = positionAtSpatialTime(plan, elapsed);
        onPositionRef.current(id, p);
        lastMoveMs.current = now;
      }
      if (!loop && elapsed >= durationSec) {
        runningRef.current = null;
        setPlaying(false);
        return;
      }
      if (runningRef.current) runningRef.current.request = requestAnimationFrame(tick);
    };
    runningRef.current = { request: 0, startMs, sourceId: id };
    onPositionRef.current(id, positionAtSpatialTime(plan, 0));
    runningRef.current.request = requestAnimationFrame(tick);
    setSelectedMotion(kind);
    setPlaying(true);
    setMessage(SPATIAL_MOTION_OPTIONS.find((option) => option.value === kind)?.label ?? kind);
  }, [disabled, prefs.durationSec, prefs.loop, prefs.sideM, prefs.radiusFraction, selectedId, stop]);

  useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);
  useEffect(() => () => {
    if (runningRef.current) cancelAnimationFrame(runningRef.current.request);
  }, []);
  useEffect(() => { stop(); }, [selectedId, stop]);

  const onApplyText = () => {
    const parsed = parseSpatialMotionText(prefs.prompt);
    if (parsed.ok === false) {
      setMessage(parsed.reason);
      return;
    }
    setPrefs((old) => ({ ...old, durationSec: parsed.durationSec, loop: parsed.loop }));
    launch(parsed.kind, parsed.durationSec, parsed.loop);
  };

  const previewPlan = useMemo<SpatialMotionPlan>(() => ({
    kind: selectedMotion, sideM: prefs.sideM,
    durationSec: prefs.durationSec, loop: false, radiusFraction: prefs.radiusFraction,
  }), [selectedMotion, prefs.sideM, prefs.durationSec, prefs.radiusFraction]);
  const previewPoints = useMemo(() => Array.from({ length: 65 }, (_, i) => {
    const p = positionAtSpatialTime(previewPlan, i / 64 * previewPlan.durationSec);
    const s = toScreen(p);
    return s.x.toFixed(2) + ',' + s.y.toFixed(2);
  }).join(' '), [previewPlan, toScreen]);

  const moveSelectedMetres = (axis: 'x' | 'y', value: number) => {
    if (!selectedXY || selectedId === null || disabled || !Number.isFinite(value)) return;
    onPosition(selectedId, {
      x: axis === 'x' ? coordinate(value, prefs.sideM) : coordinate(selectedXY.x, prefs.sideM),
      y: axis === 'y' ? coordinate(value, prefs.sideM) : coordinate(selectedXY.y, prefs.sideM),
    });
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 9, minWidth: 250, maxWidth: 420 }}
      aria-label="spatialMONK zweidimensionaler quadratischer Raum">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 7 }}>
        <label className="am-lbl">Quadrat-Seite (m)
          <input className="am-sel" type="number" min="1" max="60" step="0.1" style={{ width: 75, display: 'block' }}
            value={prefs.sideM} disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1 && n <= 60) setPrefs((p) => ({ ...p, sideM: n }));
            }} />
        </label>
        <label className="am-lbl">Satelliten
          <select className="am-sel" style={{ display: 'block' }} disabled={disabled}
            value={prefs.satellites}
            onChange={(e) => setPrefs((p) => ({ ...p, satellites: Number(e.target.value) as SquareSpeakerCount }))}>
            {[12, 16, 18, 24].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label className="am-lbl">Subwoofer
          <select className="am-sel" style={{ display: 'block' }} disabled={disabled}
            value={prefs.subs}
            onChange={(e) => setPrefs((p) => ({ ...p, subs: Number(e.target.value) as 0 | 1 | 2 }))}>
            {[0, 1, 2].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
      </div>
      <svg ref={svgRef} viewBox="0 0 400 400" role="img"
        aria-label={`Quadratischer Raum ${prefs.sideM} mal ${prefs.sideM} Meter, ${prefs.satellites} Satelliten`}
        style={{ width: '100%', aspectRatio: '1 / 1', touchAction: 'none', borderRadius: 8, background: '#121b26', border: '1px solid #475569' }}
        onPointerMove={(e) => {
          if (dragRef.current === null || disabled) return;
          if (performance.now() - lastMoveMs.current < 25) return;
          const point = fromPointer(e.clientX, e.clientY);
          if (point) onPosition(dragRef.current, point);
          lastMoveMs.current = performance.now();
        }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}>
        <rect x="30" y="30" width="340" height="340" fill="none" stroke="#6d829c" strokeWidth="2"/>
        {[1, 2, 3].map((i) => (
          <React.Fragment key={i}>
            <line x1={30 + i * 85} y1="30" x2={30 + i * 85} y2="370" stroke="#415168" strokeDasharray="3 5"/>
            <line x1="30" y1={30 + i * 85} x2="370" y2={30 + i * 85} stroke="#415168" strokeDasharray="3 5"/>
          </React.Fragment>
        ))}
        <text x="200" y="19" fontSize="11" fill="#d6e3f1" textAnchor="middle">VORNE / +Y</text>
        <text x="200" y="392" fontSize="11" fill="#d6e3f1" textAnchor="middle">HINTEN / −Y</text>
        <text x="15" y="202" fontSize="10" fill="#d6e3f1" textAnchor="middle">−X</text>
        <text x="385" y="202" fontSize="10" fill="#d6e3f1" textAnchor="middle">+X</text>
        <polyline points={previewPoints} fill="none" stroke="#facc15" strokeOpacity="0.7" strokeDasharray="5 4" strokeWidth="1.5" pointerEvents="none"/>
        {speakers.map((sp) => {
          const p = toScreen(sp.positionM);
          return <g key={sp.id}>
            <circle cx={p.x} cy={p.y} r={sp.role === 'subwoofer' ? 7 : 5}
              fill={sp.role === 'subwoofer' ? '#e879f9' : '#5aaee8'} stroke="#08131e" strokeWidth="1"/>
            <title>{sp.id}: X {sp.positionM.x.toFixed(3)} m, Y {sp.positionM.y.toFixed(3)} m, simuliert</title>
          </g>;
        })}
        <circle cx="200" cy="200" r="9" fill="#22c55e" fillOpacity="0.15" stroke="#4ade80"/>
        <circle cx="200" cy="200" r="2.5" fill="#4ade80"/>
        {sources.map((source) => {
          const p = toScreen(toMetres(source));
          return <g key={source.id}
            style={{ cursor: disabled ? 'default' : 'grab', opacity: source.muted ? 0.35 : 1 }}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect(source.id);
              if (!disabled) {
                stop();
                dragRef.current = source.id;
                svgRef.current?.setPointerCapture(e.pointerId);
              }
            }}>
            <circle cx={p.x} cy={p.y} r={selectedId === source.id ? 10 : 8}
              fill={source.color ?? '#fb923c'} stroke={selectedId === source.id ? '#fff' : '#111827'}
              strokeWidth={selectedId === source.id ? 2 : 1}/>
            <text x={p.x} y={p.y - 14} textAnchor="middle" fontSize="11" fill="#fff" stroke="#0f172a" strokeWidth="2" paintOrder="stroke">
              {source.name.slice(0, 13)}
            </text>
            <title>{source.name}: X {toMetres(source).x.toFixed(3)} m / Y {toMetres(source).y.toFixed(3)} m</title>
          </g>;
        })}
      </svg>
      <div style={{ display: 'grid', gap: 6, border: '1px solid #475569', borderRadius: 6, padding: 7 }}>
        <div className="am-lbl">Lautsprecherpositionen · X/Y in Metern (Simulation, nicht kalibriert)</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'end' }}>
          <label className="am-lbl">Lautsprecher
            <select className="am-sel" value={editingSpeaker.id}
              aria-label="Lautsprecher zum Positionieren" disabled={disabled}
              onChange={(event) => setEditingSpeakerId(event.target.value)}>
              {speakers.map((speaker) => <option value={speaker.id} key={speaker.id}>{speaker.id}</option>)}
            </select>
          </label>
          {(['x', 'y'] as const).map((axis) => (
            <label className="am-lbl" key={axis}>{axis.toUpperCase()} (m)
              <input className="am-sel" aria-label={'Lautsprecher ' + axis.toUpperCase() + ' in Metern'}
                style={{ width: 75, display: 'block' }} type="number" step="0.01"
                min={-prefs.sideM / 2} max={prefs.sideM / 2}
                disabled={disabled}
                value={Number(editingSpeaker.positionM[axis].toFixed(3))}
                onChange={(event) => setSpeakerCoordinate(axis, Number(event.target.value))} />
            </label>
          ))}
          <button type="button" className="am-tg" disabled={disabled}
            onClick={() => setPrefs((old) => {
              const overrides = { ...old.speakerOverrides };
              delete overrides[editingSpeaker.id];
              return { ...old, speakerOverrides: overrides };
            })}>STANDARD</button>
        </div>
        <div className="am-hint">Jede LS-Koordinate ist einzeln korrigierbar. Änderungen verändern ausschließlich die Raumvorschau – noch kein Hardware-Ausgang.</div>
      </div>
      <div className="am-hint">
        <b>Ohrhöhe · X/Y only.</b> Abstand = { (4 * prefs.sideM / prefs.satellites).toFixed(3) } m entlang der Wand.
        Referenz-Delay bis {Math.max(0, ...calibration.map((c) => c.relativeDelayMs)).toFixed(2)} ms (noch nicht angewandt).
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="am-lbl">{selected ? selected.name : 'Quelle auswählen'}</span>
        {selectedXY && (
          <>
            <label className="am-lbl">X (m)
              <input aria-label="X-Koordinate in Metern" className="am-sel" type="number" step="0.01"
                min={-prefs.sideM / 2} max={prefs.sideM / 2} disabled={disabled}
                style={{ width: 76, display: 'block' }} value={Number(selectedXY.x.toFixed(2))}
                onChange={(e) => moveSelectedMetres('x', Number(e.target.value))}/>
            </label>
            <label className="am-lbl">Y (m)
              <input aria-label="Y-Koordinate in Metern" className="am-sel" type="number" step="0.01"
                min={-prefs.sideM / 2} max={prefs.sideM / 2} disabled={disabled}
                style={{ width: 76, display: 'block' }} value={Number(selectedXY.y.toFixed(2))}
                onChange={(e) => moveSelectedMetres('y', Number(e.target.value))}/>
            </label>
          </>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        <label className="am-lbl">Dauer (s)
          <input className="am-sel" type="number" step="0.5" min="0.1" max="300"
            style={{ width: 75, display: 'block' }} disabled={disabled}
            value={prefs.durationSec}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0.1 && n <= 300) setPrefs((p) => ({ ...p, durationSec: n }));
            }}/>
        </label>
        <label className="am-lbl">Radius (%)
          <input className="am-sel" type="number" step="5" min="0" max="100"
            style={{ width: 75, display: 'block' }} disabled={disabled}
            value={Math.round(prefs.radiusFraction * 100)}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0 && n <= 100) setPrefs((p) => ({ ...p, radiusFraction: n / 100 }));
            }}/>
        </label>
        <label className="am-lbl" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" disabled={disabled} checked={prefs.loop}
            onChange={(e) => setPrefs((p) => ({ ...p, loop: e.target.checked }))}/>
          LOOP
        </label>
        <button className="am-tg" type="button" disabled={!playing} onClick={stop}>STOP</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
        {prefs.buttonActions.map((action, index) => (
          <div key={index} style={{ display: 'flex', gap: 4, minWidth: 0 }}>
            <button type="button" className="am-tg" title={'Aktion ' + (index + 1) + ' starten'}
              disabled={disabled || selectedId === null} onClick={() => launch(action)}>
              {'A' + (index + 1)}
            </button>
            <select className="am-sel" style={{ minWidth: 0, flex: 1 }} disabled={disabled}
              aria-label={'Bewegung Aktion ' + (index + 1)} value={action}
              onChange={(e) => {
                const kind = e.target.value as SpatialMotionKind;
                setSelectedMotion(kind);
                setPrefs((p) => ({
                  ...p, buttonActions: p.buttonActions.map((a, i) => i === index ? kind : a),
                }));
              }}>
              {SPATIAL_MOTION_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </div>
        ))}
      </div>
      <label className="am-lbl">Spatial-Effekt beschreiben (2D / X–Y)
        <textarea className="am-sel" rows={2} maxLength={500}
          style={{ width: '100%', resize: 'vertical', display: 'block' }}
          placeholder="z. B. Kreis linksherum, 6 Sekunden, Loop"
          disabled={disabled} value={prefs.prompt}
          onChange={(e) => setPrefs((p) => ({ ...p, prompt: e.target.value }))}/>
      </label>
      <button type="button" className="am-tg am-on" disabled={disabled || selectedId === null}
        onClick={onApplyText}>TEXT → BEWEGUNG</button>
      <div className="am-hint" role="status">{message}</div>
      <div className="am-hint">Text wird aktuell lokal per Regeln erkannt (keine KI-Generierung). 2D-Positionsautomation ist eine V1-Vorschau; der getrennte V2-Speaker-Renderer bleibt bis zu echten Hardwaretests abgeschaltet.</div>
    </section>
  );
});
