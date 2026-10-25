import React, { useState, useRef, MouseEvent } from 'react';
import { AutomationLanePoint, sortAutomationPoints } from '../../core/audio/state/automationTimeline';

export interface AutomationLaneEditorProps {
  laneId: string;
  points: AutomationLanePoint[];
  min: number;
  max: number;
  defaultValue: number;
  onPointsChange: (pts: AutomationLanePoint[]) => void;
  transportSec: number;
  onParameterChange?: (timeSec: number, value: number) => void;
}

export const AutomationLaneEditor: React.FC<AutomationLaneEditorProps> = ({
  laneId: _laneId,
  points,
  min,
  max,
  defaultValue,
  onPointsChange,
  transportSec,
  onParameterChange: _onParameterChange,
}) => {
  const [pts, setPts] = useState<AutomationLanePoint[]>(points.slice());
  const [lastPoints, setLastPoints] = useState(points);
  if (points !== lastPoints) {
    setLastPoints(points);
    setPts(points.slice());
  }
  const containerRef = useRef<HTMLDivElement>(null);

  const addPoint = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const width = rect.width;
    const timeSec = (x / width) * 10; // 10‑s span for demo
    const point: AutomationLanePoint = { timeSec, value: defaultValue, curve: 'linear' };
    const newPoints = sortAutomationPoints([...pts, point]);
    setPts(newPoints);
    onPointsChange(newPoints);
  };

  const updatePoint = (idx: number, newPoint: AutomationLanePoint) => {
    const updated = pts.map((p, i) => (i === idx ? newPoint : p));
    const sorted = sortAutomationPoints(updated);
    setPts(sorted);
    onPointsChange(sorted);
  };

  const deletePoint = (idx: number) => {
    const filtered = pts.filter((_, i) => i !== idx);
    setPts(filtered);
    onPointsChange(filtered);
  };

  const handleDrag = (idx: number) => (e: MouseEvent) => {
    e.stopPropagation();
    const startX = e.clientX;
    const onMove = (move: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = move.clientX - startX;
      const width = rect.width;
      const newTime = ((rect.left + startX + dx) - rect.left) / width * 10;
      const p = pts[idx];
      updatePoint(idx, { ...p, timeSec: newTime });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove as any);
      window.removeEventListener('mouseup', onUp as any);
    };
    window.addEventListener('mousemove', onMove as any);
    window.addEventListener('mouseup', onUp as any);
  };

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', height: '80px', border: '1px solid #666', background: '#222', margin: '4px 0' }}
      onClick={addPoint}
    >
      {pts.map((p, i) => {
        const leftPct = (p.timeSec / 10) * 100;
        const color = p.value < min ? '#f55' : p.value > max ? '#55f' : '#5f5';
        return (
          <div key={i} style={{ position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: '50%',
                transform: 'translate(-50%,-50%)',
                width: '10px',
                height: '10px',
                background: color,
                borderRadius: '5px',
                cursor: 'pointer',
              }}
              onClick={() => deletePoint(i)}
            />
            <div
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: '20%',
                width: '2px',
                height: '40%',
                background: '#888',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: '0',
                width: '10px',
                height: '100%',
                cursor: 'ew-resize',
                background: 'transparent',
              }}
              onMouseDown={handleDrag(i)}
            />
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: 0, right: 0, top: '90%', fontSize: '0.8rem', color: '#ccc' }}>
        {transportSec.toFixed(2)}s
      </div>
    </div>
  );
};
