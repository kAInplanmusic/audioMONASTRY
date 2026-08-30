import React, { useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';

type VizMode = 'OSCILLOSCOPE' | 'SPECTROGRAM' | 'LISSAJOUS';

// Einfache FFT (Radix-2) für das Spektrogramm (O(n·log n)).
function simpleFft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n === 1) return;
  const evenRe = new Float32Array(n / 2), evenIm = new Float32Array(n / 2);
  const oddRe = new Float32Array(n / 2), oddIm = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    evenRe[i] = re[2 * i]; evenIm[i] = im[2 * i];
    oddRe[i] = re[2 * i + 1]; oddIm[i] = im[2 * i + 1];
  }
  simpleFft(evenRe, evenIm); simpleFft(oddRe, oddIm);
  for (let k = 0; k < n / 2; k++) {
    const t = -2 * Math.PI * k / n;
    const cost = Math.cos(t), sint = Math.sin(t);
    const ur = evenRe[k] + cost * oddRe[k] - sint * oddIm[k];
    const ui = evenIm[k] + cost * oddIm[k] + sint * oddRe[k];
    re[k] = ur; im[k] = ui;
    re[k + n / 2] = evenRe[k] - cost * oddRe[k] + sint * oddIm[k];
    im[k + n / 2] = evenIm[k] - cost * oddIm[k] - sint * oddRe[k];
  }
}

function spectrum(arr: Float32Array): number[] {
  const n = arr.length;
  const re = arr.slice(0);
  const im = new Float32Array(n);
  simpleFft(re, im);
  const out: number[] = [];
  for (let i = 0; i < n / 2; i++) out.push(Math.sqrt(re[i] * re[i] + im[i] * im[i]));
  // Magnitude in dB
  return out.map(v => 20 * Math.log10(Math.max(v, 1e-8) / n * 4));
}

export const VisualizerTerminal: React.FC = React.memo(() => {
  const { state, lockStatus, updateState } = usePluginState('visualizer', 'PRO');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<VizMode>('OSCILLOSCOPE');
  // Farbzuordnung
  const palette = ['#0f766e', '#14b8a6', '#2dd4bf', '#67e8f9', '#22d3ee'];

  // MOA-Kommando: Visualizer-Modus umschalten.
  useEffect(() => {
    const onChange = (e: Event) => {
      const wanted = String((e as CustomEvent).detail ?? '').toUpperCase();
      if (wanted === 'OSCILLOSCOPE' || wanted === 'SPECTROGRAM' || wanted === 'LISSAJOUS') {
        setMode(wanted as VizMode);
      }
    };
    window.addEventListener('monk:visualizer-mode', onChange);
    return () => window.removeEventListener('monk:visualizer-mode', onChange);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    const draw = () => { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
      const buf = audioEngine.sharedWaveformBuffer;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (buf && buf.length > 0) {
        if (mode === 'OSCILLOSCOPE') {
          // Wellenform mit Füllgradient
          ctx.beginPath();
          ctx.strokeStyle = '#14b8a6';
          ctx.lineWidth = 2;
          for (let i = 0; i < buf.length; i++) {
            const x = (i / buf.length) * canvas.width;
            const y = (buf[i] * canvas.height / 2) + canvas.height / 2;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        } else if (mode === 'SPECTROGRAM') {
          const mags = spectrum(buf).slice(0, 128);
          const colW = canvas.width / mags.length;
          const norm = mags.reduce((a, b) => Math.max(a, b), 0) || 1;
          for (let i = 0; i < mags.length; i++) {
            const h = Math.max(0, Math.min(1, 0.5 - mags[i] / norm));
            const idx = Math.min(palette.length - 1, Math.floor(h * palette.length));
            ctx.fillStyle = palette[idx];
            ctx.fillRect(i * colW, 0, colW, canvas.height);
          }
          // kleine Überlagerung: Oszilloskop-Linie
          ctx.beginPath();
          ctx.strokeStyle = '#ffffff55';
          ctx.lineWidth = 1;
          for (let i = 0; i < buf.length; i++) {
            const x = (i / buf.length) * canvas.width;
            const y = (buf[i] * canvas.height / 2) + canvas.height / 2;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        } else {
          // LISSAJOUS: x = samples, y = samples verschoben um Phase
          const half = Math.floor(buf.length / 2);
          ctx.beginPath();
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 2;
          for (let i = 0; i < half; i++) {
            const a = buf[i];
            const b = buf[i + half];
            const x = ((a + 1) / 2) * canvas.width;
            const y = ((1 - b) / 2) * canvas.height; // invertierte Y-Achse
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      animationId = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animationId);
  }, [mode]);

  return (
    <div className={`p-6 bg-[#161616] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} text-neutral-300 font-mono shadow-2xl`}>
      <div className="mb-4 -mt-2">
        <MoaAssistant pluginId="visualizer" placeholder="MOA: z. B. 'Modus SPECTROGRAM'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-sm font-black uppercase tracking-widest text-neutral-400 flex items-center gap-2">
            <Activity className="w-4 h-4 text-teal-400" /> VISUALIZER
        </h3>
        <div className="flex items-center gap-2">
          <select
            value={mode}
            onChange={e => setMode(e.target.value as VizMode)}
            className="bg-black text-white text-xs p-1 rounded border border-neutral-700"
          >
            <option value="OSCILLOSCOPE">Oszilloskop</option>
            <option value="SPECTROGRAM">Spektrogramm</option>
            <option value="LISSAJOUS">Lissajous</option>
          </select>
          <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
          </select>
        </div>
      </div>
      <canvas ref={canvasRef} width={560} height={200} className="w-full bg-black rounded" />
    </div>
  );
});
