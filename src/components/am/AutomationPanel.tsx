import React, { useState } from 'react';
import { AutomationTimeline, AutomationLanePoint } from '../../core/audio/state/automationTimeline';
import { AutomationLaneEditor } from '../automation/AutomationLaneEditor';

export interface AutomationPanelProps {
  timeline?: AutomationTimeline;
  onTimelineChange?: () => void;
}

export const AutomationPanel: React.FC<AutomationPanelProps> = ({ timeline: timelineProp, onTimelineChange }) => {
  const timeline = timelineProp ?? new AutomationTimeline();
  const notify = onTimelineChange ?? (() => {});
  const [selectedLane, setSelectedLane] = useState<string | null>(null);
  const [transportSec, setTransportSec] = useState(0);

  const lanes = timeline.listLanes();

  const addLane = () => {
    const nodeId = prompt('Node ID');
    const paramId = prompt('Parameter ID');
    if (!nodeId || !paramId) return;
    const laneId = `${nodeId}::${paramId}`;
    if (timeline.hasLane(laneId)) {
      alert('Lane exists');
      return;
    }
    timeline.createLane(nodeId, paramId, { min: 0, max: 1 });
    notify();
  };

  const updateLanePoints = (laneId: string, newPoints: AutomationLanePoint[]) => {
    timeline.clearPoints(laneId);
    newPoints.forEach((p) => timeline.addPoint(laneId, p));
    notify();
  };

  const handlePlayhead = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    const newSec = (x / width) * 10;
    setTransportSec(newSec);
  };

  return (
    <div style={{ padding: '10px' }}>
      <h2>Automation Panel</h2>
      <button onClick={addLane}>Add Lane</button>
      <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: '10px' }}>
        {lanes.map((lane) => (
          <div key={lane.id} style={{ margin: '5px', border: '1px solid #444', padding: '5px' }}>
            <div>{lane.nodeId} :: {lane.parameterId}</div>
            <AutomationLaneEditor
              laneId={lane.id}
              points={lane.points.map((p)=> ({...p}))}
              min={lane.min}
              max={lane.max}
              defaultValue={lane.defaultValue}
              onPointsChange={(pts) => updateLanePoints(lane.id, pts)}
              transportSec={transportSec}
            />
          </div>
        ))}
      </div>
      <div
        style={{ position: 'relative', height: '20px', background: '#555', marginTop: '20px' }}
        onClick={handlePlayhead}
      >
        <div
          style={{ position: 'absolute', left: `${(transportSec / 10) * 100}%`, top: 0, width: '2px', height: '100%', background: '#ff0' }}
        />
      </div>
    </div>
  );
};
