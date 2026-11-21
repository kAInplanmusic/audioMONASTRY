/**
 * R19: Visueller 12-Band-EQ (Pro-Q-Style)
 * Canvas-basierte Frequenzkurve mit drag-and-drop Punkten
 */
import React, { useRef, useEffect, useCallback } from 'react';

interface BandPoint {
  freq: number;
  gain: number;
  q: number;
  type?: string;
}

interface VisualEqProps {
  bands: BandPoint[];
  onBandChange: (index: number, field: 'gain' | 'q' | 'freq', value: number) => void;
  /** Optional: spectrum data from waveform-peak telemetry */
  spectrum?: number[];
}

// Frequency mapping: log scale from 20Hz to 20kHz
const FREQ_MIN = 20;
const FREQ_MAX = 20000;

export const VisualEq: React.FC<VisualEqProps> = ({ bands, onBandChange, spectrum }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ index: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Convert frequency to x position (log scale)
  const freqToX = useCallback((freq: number) => {
    const logMin = Math.log10(FREQ_MIN);
    const logMax = Math.log10(FREQ_MAX);
    const logFreq = Math.log10(Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq)));
    return (logFreq - logMin) / (logMax - logMin);
  }, []);

  // Convert gain to y position (-12dB to +12dB mapped to 0-1)
  const gainToY = useCallback((gain: number) => {
    return (gain + 12) / 24;
  }, []);

  // Convert y position to gain
  const yToGain = useCallback((y: number) => {
    return y * 24 - 12;
  }, []);

  // Draw the EQ curve
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.fillStyle = '#0a0a0e';
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = 'rgba(249, 250, 251, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const y = (i / 8) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Draw frequency labels
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const freqLabels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    freqLabels.forEach(freq => {
      const x = freqToX(freq) * width;
      const label = freq >= 1000 ? `${(freq / 1000).toFixed(freq >= 10000 ? 0 : 1)}k` : `${freq}`;
      ctx.fillText(label, x, height - 4);
    });

    // Draw gain labels
    ctx.textAlign = 'right';
    ctx.font = '8px sans-serif';
    [-12, -6, 0, 6, 12].forEach(gain => {
      const y = gainToY(gain) * height;
      ctx.fillText(`${gain > 0 ? '+' : ''}${gain}`, width - 4, y + 4);
    });

    // Draw curve
    if (bands.length > 0) {
      // Create gradient for stroke
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, '#0ea5e9');
      gradient.addColorStop(0.5, '#d946ef');
      gradient.addColorStop(1, '#ec4899');

      ctx.beginPath();
      bands.forEach((band, i) => {
        const x = freqToX(band.freq) * width;
        const y = gainToY(band.gain) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Draw band points
    bands.forEach((band) => {
      const x = freqToX(band.freq) * width;
      const y = gainToY(band.gain) * height;

      // Band node
      ctx.fillStyle = '#050508';
      ctx.strokeStyle = '#a855f7';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(168, 85, 247, 0.8)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Frequency label
      ctx.fillStyle = 'rgba(249, 250, 251, 0.5)';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      const label = band.freq >= 1000 ? `${(band.freq / 1000).toFixed(1)}k` : `${Math.round(band.freq)}`;
      ctx.fillText(label, x, height - 18);

      // Gain label
      ctx.font = '10px sans-serif';
      const gainLabel = band.gain > 0 ? `+${band.gain.toFixed(1)}` : `${band.gain.toFixed(1)}`;
      ctx.fillText(`${gainLabel}dB`, x, y - 12);
    });

    // Reset shadow
    ctx.shadowBlur = 0;

    // Draw spectrum if provided (R19 bonus)
    if (spectrum && spectrum.length > 0) {
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      spectrum.forEach((mag, i) => {
        const x = (i / (spectrum.length - 1)) * width;
        const y = height - (mag * height);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }, [bands, spectrum, freqToX, gainToY]);

  // Handle mouse events for drag-and-drop
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Find closest band
    let closestIdx = 0;
    let minDist = Infinity;
    bands.forEach((band, i) => {
      const bandX = freqToX(band.freq);
      const bandY = gainToY(band.gain);
      const dist = Math.sqrt(Math.pow(x - bandX, 2) + Math.pow(y - bandY, 2));
      if (dist < minDist && dist < 0.05) { // 5% tolerance
        minDist = dist;
        closestIdx = i;
      }
    });

    dragRef.current = { index: closestIdx };
  }, [freqToX, gainToY, bands]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;

    const gain = yToGain(y);
    const bandIdx = dragRef.current.index;

    onBandChange(bandIdx, 'gain', gain);
  }, [onBandChange, yToGain]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div ref={containerRef} className="relative" style={{ cursor: 'pointer' }}>
      <canvas
        ref={canvasRef}
        width={400}
        height={200}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ width: '100%', height: '100%', cursor: 'pointer' }}
      />
      <div className="absolute inset-0 pointer-events-none" />
    </div>
  );
};