import React, { useState } from 'react';
import { midiClockStart, midiClockStop, patternStepMessage, type DigitaktPatternStep } from '../../core/midi/digitakt2';

interface Props {
  /** Erster MIDI-Output (Digitakt). */
  output?: { send: (data: number[], timestamp?: number) => void } | null;
}

/**
 * Digitakt-PatternEditor – 8 Tracks × 16 Steps.
 * Klick setzt/löscht einen Step-Trig und sendet die Note sofort an den Digitakt
 * (Live-Recording-Verhalten), damit das Pattern hörbar aufgebaut wird.
 */
export const DigitaktPatternEditor: React.FC<Props> = ({ output }) => {
  const [grid, setGrid] = useState<boolean[][]>(() => Array.from({ length: 8 }, () => Array(16).fill(false)));

  const toggle = (track: number, step: number) => {
    const next = grid.map((row, t) => (t === track ? row.slice() : row));
    next[track][step] = !next[track][step];
    setGrid(next);
    const ev: DigitaktPatternStep = { track, step, on: next[track][step], note: 60, velocity: 100 };
    output?.send(patternStepMessage(ev));
  };

  const sendGrid = (on: boolean) => {
    const steps: DigitaktPatternStep[] = [];
    grid.forEach((row, track) => row.forEach((active, step) => { if (active) steps.push({ track, step, on }); }));
    for (const ev of steps) output?.send(patternStepMessage(ev));
  };

  return (
    <div className="mt-2 border-t border-neutral-800 pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono text-neutral-500 uppercase">Digitakt Pattern (8×16)</span>
        <div className="flex gap-1">
          <button type="button" onClick={() => sendGrid(true)} className="px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-300 text-[8px] cursor-pointer">▶ All ON</button>
          <button type="button" onClick={() => sendGrid(false)} className="px-1.5 py-0.5 rounded border border-neutral-700 text-neutral-400 text-[8px] cursor-pointer">All OFF</button>
          <button type="button" onClick={() => output?.send(midiClockStart())} className="px-1.5 py-0.5 rounded border border-cyan-500/40 text-cyan-300 text-[8px] cursor-pointer">CLK START</button>
          <button type="button" onClick={() => output?.send(midiClockStop())} className="px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 text-[8px] cursor-pointer">CLK STOP</button>
        </div>
      </div>
      <div className="mt-1 overflow-x-auto">
        <div className="min-w-max">
          {grid.map((row, t) => (
            <div key={t} className="flex items-center gap-1 mb-0.5">
              <span className="w-4 text-[8px] font-mono text-neutral-600">T{t + 1}</span>
              {row.map((active, s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggle(t, s)}
                  className={`w-3.5 h-3.5 rounded-[2px] border cursor-pointer transition-colors ${
                    active ? 'bg-lime-500/80 border-lime-300' : s % 4 === 0 ? 'bg-neutral-700 border-neutral-600' : 'bg-neutral-800 border-neutral-700'
                  }`}
                  aria-label={`Track ${t + 1} Step ${s + 1}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
