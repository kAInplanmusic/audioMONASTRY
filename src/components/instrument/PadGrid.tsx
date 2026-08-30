import React from 'react';
import { instrumentBackend } from '../../core/instrument/InstrumentBackend';

interface Props {
  /** Raster: 4×4, 8×2 oder 16 (4×4). */
  rows?: number;
  cols?: number;
  /** Basis-MIDI-Note (chromatisch aufsteigend). */
  baseNote?: number;
  onPad?: (midi: number, velocity: number) => void;
}

/**
 * Universal-Touchpad-Array – konfigurierbares Pad-Raster als Spielfläche.
 * Noten-Trigger (chromatisch) über die Control-Abstraktion (instrumentBackend).
 */
export const PadGrid: React.FC<Props> = ({ rows = 4, cols = 4, baseNote = 48, onPad }) => {
  const pads: { midi: number; idx: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pads.push({ midi: baseNote + r * cols + c, idx: r * cols + c });
    }
  }

  return (
    <div
      className="grid gap-2 w-full select-none touch-none"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      aria-label="Touchpad-Array"
    >
      {pads.map((p) => (
        <button
          key={p.idx}
          type="button"
          aria-label={`Pad ${p.midi}`}
          className="aspect-square rounded-lg bg-neutral-800 border border-neutral-700 hover:border-cyan-500/60 active:bg-cyan-500/30 active:border-cyan-400 text-[9px] font-mono text-neutral-400"
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const velocity = Math.max(0.2, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
            instrumentBackend.noteOn(p.midi, velocity);
            onPad?.(p.midi, velocity);
          }}
          onPointerUp={() => instrumentBackend.noteOff()}
          onPointerLeave={() => instrumentBackend.noteOff()}
        >
          {p.midi}
        </button>
      ))}
    </div>
  );
};
