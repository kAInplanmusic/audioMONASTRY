/**
 * dropMONK – Pad Parameter Controls (Spec: drp.<cat>.N.pit/lvl/len)
 * ===============================================================
 * Sliders und Controls für Pitch, Level, Length pro Pad-Kategorie
 */

import React, { memo, useMemo } from 'react';
import type { PadCategory, PadParameters } from '../../context/DropContext';

interface PadParamControlsProps {
  category: PadCategory;
  padIndex: number;
  parameters?: PadParameters;
  onChange: (cat: PadCategory, idx: number, param: 'pitch' | 'level' | 'length', value: number) => void;
}

const formatValue = (param: 'pitch' | 'level' | 'length', value: number): string => {
  switch (param) {
    case 'pitch': return value === 0 ? '0' : (value > 0 ? `+${value.toFixed(2)}` : `${value.toFixed(2)}`);
    case 'level': return `${Math.round(value * 100)}%`;
    case 'length': return `${Math.round(value * 100)}%`;
    default: return '';
  }
};

export const PadParamControls = memo(function PadParamControls({
  category,
  padIndex,
  parameters,
  onChange,
}: PadParamControlsProps) {
  const pitch = parameters?.pitch ?? 0;
  const level = parameters?.level ?? 1;
  const length = parameters?.length ?? 1;

  const sliderConfig = useMemo(() => ({
    pitch: {
      min: -2,
      max: 2,
      step: 0.01,
      label: 'PITCH',
      unit: 'st',
    },
    level: {
      min: 0,
      max: 1,
      step: 0.01,
      label: 'LEVEL',
      unit: '',
    },
    length: {
      min: 0,
      max: 1,
      step: 0.01,
      label: 'LENGTH',
      unit: '',
    },
  }), []);

  return (
    <div className="am-pad-params space-y-1 px-2 py-1" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
      {(['pitch', 'level', 'length'] as const).map((param) => {
        const config = sliderConfig[param];
        const value = param === 'pitch' ? pitch : param === 'level' ? level : length;
        return (
          <div key={param} className="flex flex-col gap-0.5">
            <label className="text-[8px] text-neutral-500 uppercase tracking-wider">
              {config.label} <span className="text-neutral-400">{config.unit}</span>
            </label>
            <input
              type="range"
              min={config.min}
              max={config.max}
              step={config.step}
              value={value}
              onChange={(e) => onChange(category, padIndex, param, Number.parseFloat(e.target.value))}
              className="w-full accent-cyan-400"
            />
            <span className="text-[8px] text-neutral-400 text-right">{formatValue(param, value)}</span>
          </div>
        );
      })}
    </div>
  );
});