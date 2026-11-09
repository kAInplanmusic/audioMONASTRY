import React, { useEffect, useRef, useState } from 'react';
import {
  SPATIAL_MOTION_PRESETS,
  interpretSpatialMotionText,
  motionPointAt,
  type MotionXY,
  type SpatialMotionId,
} from '../core/spatial/v2/motionPatterns';
import { storageGetJson, storageSetJson } from '../utils/storage';

const KEY = 'spatialmonk-xy-motion-buttons-v1';
const DEFAULTS: SpatialMotionId[] = [
  'circle-clockwise', 'left-right', 'front-back', 'figure-eight',
];
const VALID = new Set<SpatialMotionId>(SPATIAL_MOTION_PRESETS.map((p) => p.id));

function loadAssignments(): SpatialMotionId[] {
  try {
    const saved = storageGetJson<unknown>(KEY);
    if (!Array.isArray(saved) || saved.length !== 4 ||
      !saved.every((id) => VALID.has(id as SpatialMotionId))) return [...DEFAULTS];
    return [...saved] as SpatialMotionId[];
  } catch { return [...DEFAULTS]; }
}

export interface SpatialMotionControlsProps {
  selectedId: number | null;
  disabled: boolean;
  /** Preview only, normalized XY: -1..1. Does not alter mixerMONK stereo. */
  onPreview: (sourceId: number, point: MotionXY | null) => void;
  /** A single explicit action commits the preview position to scene metadata. */
  onCommit: (sourceId: number, point: MotionXY) => void;
  onPatternChange: (id: SpatialMotionId) => void;
}

/**
 * XY-only motion programming panel. This is a VISUAL/scene preview; a real
 * output requires an independently validated Spatial-Main and audio-clock
 * automation scheduling. A UI RAF timer is never a sample-accurate DSP clock.
 */
export const SpatialMotionControls = React.memo(function SpatialMotionControls({
  selectedId, disabled, onPreview, onCommit, onPatternChange,
}: SpatialMotionControlsProps) {
  const [assignments, setAssignments] = useState<SpatialMotionId[]>(loadAssignments);
  const [active, setActive] = useState<SpatialMotionId>('circle-clockwise');
  const [duration, setDuration] = useState(6);
  const [radius, setRadius] = useState(0.82);
  const [running, setRunning] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [hint, setHint] = useState('');
  const lastPoint = useRef<MotionXY | null>(null);

  useEffect(() => {
    try { storageSetJson(KEY, assignments); } catch { /* private mode */ }
  }, [assignments]);

  useEffect(() => {
    onPatternChange(active);
  }, [active, onPatternChange]);

  useEffect(() => {
    if (!running || selectedId == null || disabled) return;
    let frameId = 0;
    let lastReport = -Infinity;
    const startAt = performance.now();
    const frame = (now: number) => {
      // Visual preview capped at 25Hz; render/worklet automation is NOT here.
      if (now - lastReport >= 40) {
        const phase = (now - startAt) / (Math.max(0.25, duration) * 1000);
        const point = motionPointAt(active, phase, radius);
        lastPoint.current = point;
        onPreview(selectedId, point);
        lastReport = now;
      }
      frameId = window.requestAnimationFrame(frame);
    };
    frameId = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(frameId);
      onPreview(selectedId, null);
    };
  }, [running, selectedId, disabled, duration, radius, active, onPreview]);

  const start = (id: SpatialMotionId) => {
    if (selectedId == null || disabled) return;
    setActive(id);
    setHint('XY-Vorschau aktiv – noch keine Live-Spatial-Audioautomatik');
    setRunning(true);
  };

  const useDescription = () => {
    const parsed = interpretSpatialMotionText(prompt);
    if (parsed == null) {
      setHint('Text nicht eindeutig: Kreis, links rechts, vorne hinten, Diagonal, Quadrat oder Acht beschreiben.');
      return;
    }
    setHint('Text als Preset erkannt: ' + (SPATIAL_MOTION_PRESETS.find((p) => p.id === parsed)?.label ?? parsed));
    start(parsed);
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="am-lbl">Bewegungen · XY auf Ohrhöhe · Vorschau</div>
      {assignments.map((id, index) => (
        <div key={index} style={{ display: 'flex', gap: 6 }}>
          <button type="button" className={'am-tg ' + (running && active === id ? 'am-on' : '')}
            disabled={selectedId == null || disabled}
            onClick={() => start(id)}
            title={'FX ' + (index + 1) + ' starten (Vorschau)'}>
            FX {index + 1}
          </button>
          <select className="am-sel" style={{ flex: 1, minWidth: 0 }}
            value={id} aria-label={'Bewegungstaste ' + (index + 1) + ' belegen'}
            disabled={disabled}
            onChange={(e) => setAssignments((previous) => previous.map((value, i) =>
              i === index ? e.target.value as SpatialMotionId : value))}>
            {SPATIAL_MOTION_PRESETS.map((p) => <option value={p.id} key={p.id}>{p.label}</option>)}
          </select>
        </div>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label className="am-lbl">
          Dauer / Zyklus (s)
          <input className="am-sel" style={{ width: '100%' }} type="number" min={0.25} max={60} step={0.25}
            value={duration} disabled={disabled}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setDuration(Math.min(60, Math.max(0.25, n))); }} />
        </label>
        <label className="am-lbl">
          Bewegungsweite (%)
          <input className="am-sel" style={{ width: '100%' }} type="number" min={0} max={100} step={5}
            value={Math.round(radius * 100)} disabled={disabled}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setRadius(Math.min(1, Math.max(0, n / 100))); }} />
        </label>
      </div>
      <div className="am-sptrow">
        <button className="am-tg" type="button" onClick={() => setRunning(false)} disabled={!running}>STOP</button>
        <button className="am-tg" type="button"
          title="Letzte Vorschau-Koordinate als neue Objektposition speichern"
          onClick={() => {
            if (selectedId == null || !lastPoint.current || disabled) return;
            onCommit(selectedId, lastPoint.current);
            setHint('XY-Position gespeichert – Stereo-Mix bleibt unverändert');
          }}
          disabled={selectedId == null || !lastPoint.current || disabled}>
          POSITION
        </button>
      </div>
      <label className="am-lbl" htmlFor="spatial-motion-prompt">Spatial-Effekt in Worten</label>
      <textarea id="spatial-motion-prompt" rows={3} maxLength={500} value={prompt}
        className="am-sel" style={{ width: '100%', minHeight: 65, resize: 'vertical' }}
        placeholder="z. B. Links rechts links rechts, einmal im Kreis oder von vorne nach hinten"
        onChange={(e) => setPrompt(e.target.value)} disabled={disabled}/>
      <button type="button" className="am-tg" disabled={!prompt.trim() || selectedId == null || disabled}
        onClick={useDescription}>TEXT → BEWEGUNGSVORSCHAU</button>
      <span className="am-hint">{hint || 'Freie Buttons sind lokal speicherbar; Text wird sicher in bekannte XY-Muster übersetzt. Keine 3D-/Höhenbewegung.'}</span>
    </div>
  );
});
