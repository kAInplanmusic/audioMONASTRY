import React, { useRef, useEffect } from 'react';
import { MidiDeviceType } from '../../config/midiDevices';

/**
 * SkinEngine – parametrischer Canvas-MIDI-Hardware-Renderer
 * ---------------------------------------------------------
 * Zeichnet das "Frontpanel" des erkannten MIDI-Geräts generisch aus Canvas-
 * Primitiven (Grid-Pads, Fader, Encoder, LEDs) und animiert sie in Echtzeit
 * über die gemappten Samples / CC-Werte.
 *
 * Skalierungsansatz: ein generischer Skin pro Gerätetyp statt statischer Bilder,
 * dadurch Plug-and-Play für alle registrierten Geräte.
 */

export interface SkinState {
  pads?: Record<number, boolean>;        // aktiv leuchtende Pads
  padColors?: Record<number, string>;    // Pad-Farben
  encoders?: number[];                   // Encoder-Positionen 0..1
  faders?: number[];                     // Fader-Positionen 0..1
  label?: string;                        // Geräte-Name
}

interface SkinEngineProps {
  type: MidiDeviceType;
  state?: SkinState;
  cols?: number;   // Spalten (Grid)
  rows?: number;   // Zeilen (Grid)
}

export const SkinEngine: React.FC<SkinEngineProps> = ({
  type,
  state,
  cols = 8,
  rows = 5,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Hintergrund / Panel
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1c1c22');
    grad.addColorStop(1, '#0d0d12');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#333';
    ctx.strokeRect(1, 1, W - 2, H - 2);

    // Abschnitt: Encoder-Reihe (oben)
    const eCount = cols;
    const enc = state?.encoders ?? [];
    ctx.font = '10px monospace';
    for (let i = 0; i < eCount; i++) {
      const ex = 20 + i * ((W - 40) / eCount);
      const ey = 34;
      const val = enc[i] ?? 0.5;
      ctx.beginPath();
      ctx.arc(ex, ey, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#2a2a33';
      ctx.fill();
      ctx.strokeStyle = '#555';
      ctx.stroke();
      // Marker
      const angle = -Math.PI * 0.75 + val * Math.PI * 1.5;
      const mx = ex + Math.cos(angle) * 5;
      const my = ey + Math.sin(angle) * 5;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(mx, my);
      ctx.strokeStyle = '#9f7aea';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Pads (Grid)
    const pad = state?.pads ?? {};
    const padColor = state?.padColors ?? {};
    const padW = (W - 60) / cols;
    const padH = (H - 120) / rows;
    for (let r = 0; r < rows; r++) {
      for (let cIdx = 0; cIdx < cols; cIdx++) {
        const idx = r * cols + cIdx;
        const px = 20 + cIdx * (padW + 4);
        const py = 52 + r * (padH + 4);
        const on = !!pad[idx];
        ctx.fillStyle = on ? (padColor[idx] || '#9f7aea') : '#14141a';
        ctx.fillRect(px, py, padW, padH);
        ctx.strokeStyle = on ? '#c4b5fd' : '#333';
        ctx.strokeRect(px, py, padW, padH);
      }
    }

    // Fader-Reihe (unten) – Skizze als schmale Slider
    const fCount = cols;
    const fader = state?.faders ?? [];
    for (let i = 0; i < fCount; i++) {
      const fx = 26 + i * ((W - 52) / fCount);
      const fyBase = H - 26;
      const fval = fader[i] ?? 0.5;
      ctx.fillStyle = '#24242b';
      ctx.fillRect(fx, fyBase - 34, 6, 30);
      ctx.fillStyle = '#9f7aea';
      ctx.fillRect(fx, fyBase - 8 - fval * 24, 6, 8);
    }

    // Label
    ctx.fillStyle = '#888';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(state?.label || type, W / 2, H - 6);
    ctx.textAlign = 'left';
  }, [type, state, cols, rows]);

  return (
    <canvas
      ref={canvasRef}
      width={560}
      height={300}
      className="w-full h-auto rounded-lg border border-neutral-700"
    />
  );
};
