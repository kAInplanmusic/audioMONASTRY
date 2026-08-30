import React from 'react';
import { instrumentBackend } from '../../core/instrument/InstrumentBackend';

const WHITE_KEYS = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const BLACK_KEYS = [1, 3, 6, 8, 10];        // C# D# F# G# A#

interface Props {
  /** Startnote (MIDI), z. B. 48 = C3. */
  baseNote?: number;
  octaves?: number;
  onNoteOn?: (midi: number, velocity: number) => void;
  onNoteOff?: (midi: number) => void;
}

/**
 * UniversalKeyboard – wiederverwendbare Klaviatur (Klick + Touch, Velocity
 * über vertikale Position). Spielt über den instrumentBackend (Control-
 * Abstraktion), kein direkter Audio-Zugriff in der UI.
 */
export const UniversalKeyboard: React.FC<Props> = ({
  baseNote = 48,
  octaves = 2,
  onNoteOn,
  onNoteOff,
}) => {
  const play = (midi: number, clientY: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const velocity = Math.max(0.2, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    instrumentBackend.noteOn(midi, velocity);
    onNoteOn?.(midi, velocity);
  };

  const stop = (midi: number) => {
    instrumentBackend.noteOff();
    onNoteOff?.(midi);
  };

  const keys: { midi: number; black: boolean }[] = [];
  for (let o = 0; o < octaves; o++) {
    const start = baseNote + o * 12;
    for (const k of WHITE_KEYS) keys.push({ midi: start + k, black: false });
    for (const k of BLACK_KEYS) keys.push({ midi: start + k, black: true });
  }

  return (
    <div className="relative w-full h-40 select-none touch-none" aria-label="Universalkeyboard">
      <div className="absolute inset-0 flex">
        {keys.filter((k) => !k.black).map((k) => (
          <button
            key={`w-${k.midi}`}
            type="button"
            aria-label={`Note ${k.midi}`}
            className="flex-1 bg-white border border-neutral-300 rounded-b-md active:bg-cyan-100"
            onPointerDown={(e) => play(k.midi, e.clientY, e.currentTarget)}
            onPointerUp={() => stop(k.midi)}
            onPointerLeave={() => stop(k.midi)}
          />
        ))}
      </div>
      <div className="absolute top-0 left-0 right-0 h-3/5 flex pointer-events-none">
        {keys.filter((k) => !k.black).map((_, i) => (
          <div key={`gap-${i}`} className="flex-1 relative">
            {(() => {
              // Schwarze Taste liegt rechts der weißen Taste (C# nach C, D# nach D …).
              const before = keys.filter((k) => !k.black)[i];
              const black = keys.find((k) => k.black && k.midi === before.midi + 1);
              if (!black) return null;
              return (
                <button
                  key={`b-${black.midi}`}
                  type="button"
                  aria-label={`Note ${black.midi}`}
                  className="absolute -right-[30%] top-0 w-[60%] h-full bg-neutral-900 border border-black rounded-b-sm active:bg-cyan-700 pointer-events-auto"
                  onPointerDown={(e) => play(black.midi, e.clientY, e.currentTarget)}
                  onPointerUp={() => stop(black.midi)}
                  onPointerLeave={() => stop(black.midi)}
                />
              );
            })()}
          </div>
        ))}
      </div>
    </div>
  );
};
