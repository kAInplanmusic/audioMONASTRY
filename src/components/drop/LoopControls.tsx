/**
 * dropMONK – Loop Controls (Spec: drp.loop.N.lvl)
 * ==================================================
 * Loop-Enable Toggle + Level-Slider pro Kanal
 */

import React, { memo } from 'react';
import type { LoopState } from '../../context/DropContext';

const CHANNELS = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5'];

interface LoopControlsProps {
  loopState: LoopState;
  onLevelChange: (channelId: string, level: number) => void;
  onToggleEnabled: (enabled: boolean) => void;
}

export const LoopControls = memo(function LoopControls({
  loopState,
  onLevelChange,
  onToggleEnabled,
}: LoopControlsProps) {
  return (
    <div className="am-loop-ctrls">
      <div className="am-a-inline">
        <label className="am-lbl">LOOP</label>
        <button
          type="button"
          className={`am-tog ${loopState.enabled ? 'am-on' : ''}`}
          onClick={() => onToggleEnabled(!loopState.enabled)}
          aria-pressed={loopState.enabled}
        >
          {loopState.enabled ? 'ON' : 'OFF'}
        </button>
      </div>
      {loopState.enabled ? (
        <div className="am-loop-levels">
          {CHANNELS.map((ch) => {
            const level = loopState.levels[ch] ?? 0;
            return (
              <div key={ch} className="am-loop-row">
                <span className="am-lbl">{ch}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={level}
                  onChange={(e) => onLevelChange(ch, Number.parseFloat(e.target.value))}
                  className="w-full accent-purple-400"
                  aria-label={`Loop Level ${ch}`}
                />
                <span className="am-mono text-[8px]">{Math.round(level * 100)}%</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});