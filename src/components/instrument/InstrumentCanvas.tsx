import React, { useEffect, useRef, useState } from 'react';
import { canvasDefForInstrument, hitZone, zoneNote } from '../../core/instrument/canvasDefs';
import type { CanvasDef } from '../../core/instrument/canvasDefs';
import { instrumentBackend } from '../../core/instrument/InstrumentBackend';

interface Props {
  instrumentName: string;
  onNote?: (midi: number, velocity: number) => void;
}

/**
 * InstrumentCanvas – spielbare Canvas-Darstellung (View 3).
 * Gitarre (Saiten/Bünde), Theremin (XY), Hang/Kalimba (Zonen), Drums (Pads).
 * Zeichnet die Zonen aus den Canvas-Definitionen und spielt über den
 * instrumentBackend (Control-Abstraktion).
 */
export const InstrumentCanvas: React.FC<Props> = ({ instrumentName, onNote }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [def] = useState<CanvasDef | undefined>(() => canvasDefForInstrument(instrumentName));
  const [lastNote, setLastNote] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !def) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, W, H);

      for (const z of def.zones) {
        const x = z.x * W;
        const y = z.y * H;
        const w = z.w * W;
        const h = z.h * H;
        ctx.fillStyle = def.kind === 'guitar' ? '#3b2f23' : def.kind === 'theremin' ? '#0b1c2c' : def.kind === 'drums' ? '#2a1215' : '#231a0b';
        ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        if (z.label) {
          ctx.fillStyle = '#9aa';
          ctx.font = `${Math.max(8, Math.min(12, h * 0.35))}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(z.label, x + w / 2, y + h / 2);
        }
      }
    };
    draw();
  }, [def]);

  if (!def) {
    return <div className="text-[10px] font-mono text-neutral-500 p-4">Keine Canvas für dieses Instrument – Keyboard/Pads nutzen.</div>;
  }

  const posFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={canvasRef}
        width={480}
        height={300}
        aria-label={`Instrument-Canvas ${def.kind}`}
        className="w-full rounded-lg border border-neutral-800 touch-none select-none cursor-crosshair"
        onPointerDown={(e) => {
          const { x, y } = posFromEvent(e);
          const zone = hitZone(def, x, y);
          if (!zone) return;
          const note = zoneNote(zone, x);
          const velocity = def.kind === 'theremin' ? Math.max(0.2, Math.min(1, 1 - y)) : 0.9;
          setLastNote(note);
          instrumentBackend.noteOn(note, velocity);
          onNote?.(note, velocity);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return;
          const { x, y } = posFromEvent(e);
          const zone = hitZone(def, x, y);
          if (!zone) return;
          const note = zoneNote(zone, x);
          if (note !== lastNote) {
            instrumentBackend.noteOff();
            const velocity = def.kind === 'theremin' ? Math.max(0.2, Math.min(1, 1 - y)) : 0.9;
            setLastNote(note);
            instrumentBackend.noteOn(note, velocity);
            onNote?.(note, velocity);
          }
        }}
        onPointerUp={() => {
          instrumentBackend.noteOff();
          setLastNote(null);
        }}
        onPointerLeave={() => {
          instrumentBackend.noteOff();
          setLastNote(null);
        }}
      />
      <div className="text-[9px] font-mono text-neutral-500">
        Canvas: {def.kind.toUpperCase()} · {def.zones.length} Zonen{lastNote !== null ? ` · Note ${lastNote}` : ''}
      </div>
    </div>
  );
};
