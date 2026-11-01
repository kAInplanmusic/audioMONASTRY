/**
 * dropMONK – Quantization Control (Spec: drp.q)
 * ==============================================
 * Dropdown für Quantization-Level: instant, 1/4, 1/2, 1bar, 2bar, 4bar
 */

import React, { memo } from 'react';
import type { QuantizationLevel } from '../../context/DropContext';

interface QuantizationProps {
  value: QuantizationLevel;
  onChange: (level: QuantizationLevel) => void;
}

const QUANTIZATION_LABELS: Record<QuantizationLevel, string> = {
  instant: 'Sofort',
  '1/4': '1/4 Takt',
  '1/2': '1/2 Takt',
  '1bar': '1 Takt',
  '2bar': '2 Takte',
  '4bar': '4 Takte',
};

const QUANTIZATION_SYMBOLS: Record<QuantizationLevel, string> = {
  instant: 'i',
  '1/4': '¼',
  '1/2': '½',
  '1bar': '1',
  '2bar': '2',
  '4bar': '4',
};

export const QuantizationControl = memo(function QuantizationControl({
  value,
  onChange,
}: QuantizationProps) {
  return (
    <div className="am-quantization flex items-center gap-2">
      <label className="text-[9px] text-neutral-400 uppercase tracking-wider">QUANT</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as QuantizationLevel)}
        className="bg-neutral-800 border border-neutral-700 rounded px-2 py-0.5 text-xs text-neutral-200 focus:outline-none focus:ring-2 focus:ring-cyan-400"
      >
        {(['instant', '1/4', '1/2', '1bar', '2bar', '4bar'] as QuantizationLevel[]).map((level) => (
          <option key={level} value={level}>
            {QUANTIZATION_SYMBOLS[level]} {QUANTIZATION_LABELS[level]}
          </option>
        ))}
      </select>
    </div>
  );
});