import React, { useState, useEffect, useRef } from 'react';
import { Activity, Cpu, Gauge, Network, Waves } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { performanceMonitor, PerformanceSnapshot } from '../utils/PerformanceMonitor';
import { audioEngine } from '../utils/audioEngine';
import { webRTCManager } from '../utils/WebRTCManager';
import { MoaAssistant } from './MoaAssistant';
import { telemetry } from '../utils/telemetry';

type SignalMode = 'OSCILLOSCOPE' | 'SPECTROGRAM';

/** Radix-2-FFT (Kopie aus ehem. visualMONK, jetzt in perfMONK integriert). */
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
  return out.map((v) => 20 * Math.log10(Math.max(v, 1e-8) / n * 4));
}

/**
 * R1 – Performance-Monitoring-Terminal (Plugin-Slot 19, perfMONK)
 * ================================================================
 * Echtzeit-CPU-/UI-Metriken, Latenz-Budgets und (seit Integration von
 * visMONK) Signal-Monitor: Oszilloskop + Spektrogramm.
 */
export const PerformanceMonitorTerminal = React.memo(function PerformanceMonitorTerminal() {
  const { state, updateState } = usePluginState('performance', 'PRO');
  const [perf, setPerf] = useState<PerformanceSnapshot>(() => performanceMonitor.snapshot());
  const [net, setNet] = useState({ rttMs: 0, dropouts: 0 });
  const [signalMode, setSignalMode] = useState<SignalMode>('OSCILLOSCOPE');
  const signalCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    performanceMonitor.setAudioStateProvider(() => audioEngine.getAudioHealth());
    performanceMonitor.start();
    const timer = setInterval(() => {
      setPerf(performanceMonitor.snapshot());
      // P2-1: End-to-End-Latenz live anzeigen (lokal = Audio, Netz = WebRTC).
      setNet({
        rttMs: Math.round(webRTCManager.lastRttMs * 10) / 10,
        dropouts: audioEngine.dropoutCount,
      });
    }, 1000);
    return () => { clearInterval(timer); performanceMonitor.stop(); };
  }, []);

  // Signal-Monitor (ehem. visualMONK): Oszilloskop/Spektrogramm auf dem
  // Shared-Waveform-Buffer der AudioEngine.
  useEffect(() => {
    const onChange = (e: Event) => {
      const wanted = String((e as CustomEvent).detail ?? '').toUpperCase();
      if (wanted === 'OSCILLOSCOPE' || wanted === 'SPECTROGRAM') setSignalMode(wanted as SignalMode);
    };
    window.addEventListener('monk:visualizer-mode', onChange);
    return () => window.removeEventListener('monk:visualizer-mode', onChange);
  }, []);

  useEffect(() => {
    const canvas = signalCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let animationId = 0;
    const palette = ['#0f766e', '#14b8a6', '#2dd4bf', '#67e8f9', '#22d3ee'];
    const draw = () => {
      const buf = audioEngine.sharedWaveformBuffer;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (buf && buf.length > 0) {
        if (signalMode === 'OSCILLOSCOPE') {
          ctx.beginPath();
          ctx.strokeStyle = '#14b8a6';
          ctx.lineWidth = 2;
          for (let i = 0; i < buf.length; i++) {
            const x = (i / buf.length) * canvas.width;
            const y = (buf[i] * canvas.height / 2) + canvas.height / 2;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        } else {
          const mags = spectrum(buf).slice(0, 128);
          const colW = canvas.width / mags.length;
          const norm = mags.reduce((a, b) => Math.max(a, b), 0) || 1;
          for (let i = 0; i < mags.length; i++) {
            const h = Math.max(0, Math.min(1, 0.5 - mags[i] / norm));
            const idx = Math.min(palette.length - 1, Math.floor(h * palette.length));
            ctx.fillStyle = palette[idx];
            ctx.fillRect(i * colW, 0, colW, canvas.height);
          }
        }
      }
      animationId = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animationId);
  }, [signalMode]);

  const budgets = telemetry.snapshot().budgets;

  return (
    <div className="w-full h-full flex flex-col bg-[#111] rounded-xl border border-neutral-800 overflow-hidden text-neutral-300 font-sans">
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="performance" placeholder="MOA: z. B. 'Monitoring reset'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-teal-900/20 to-[#111] border-b border-teal-900/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-teal-500/20 flex items-center justify-center border border-teal-500/50">
            <Gauge className="w-5 h-5 text-teal-400" />
          </div>
          <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase flex items-center gap-2">
            Performance <span className="text-[10px] font-mono text-teal-400 border border-teal-500/30 px-2 py-0.5 rounded-sm">SLOT 17</span>
          </h2>
        </div>
        <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
          <option value="OFF">OFF</option>
          <option value="AUTO_AI">AI</option>
          <option value="PRO">ACTIVE</option>
        </select>
      </div>

      <div className="flex-1 p-6 grid grid-cols-12 gap-6 overflow-y-auto">
        <div className="col-span-4 space-y-4">
          <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-4">
            <h3 className="text-xs font-bold tracking-widest text-neutral-500 flex items-center gap-2 mb-3">
              <Cpu className="w-4 h-4" /> MAIN THREAD
            </h3>
            <div className="space-y-2 text-[11px] font-mono">
              <div className="flex justify-between"><span className="text-neutral-500">UI FPS</span><span className="text-emerald-400">{perf.fps}</span></div>
              <div className="flex justify-between"><span className="text-neutral-500">FRAME JITTER</span><span className="text-emerald-400">{perf.jitterMs} ms</span></div>
              <div className="flex justify-between"><span className="text-neutral-500">DROPPED FRAMES</span><span className="text-emerald-400">{perf.droppedFrames}</span></div>
            </div>
          </div>
        </div>

        <div className="col-span-4 space-y-4">
          <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-4">
            <h3 className="text-xs font-bold tracking-widest text-neutral-500 flex items-center gap-2 mb-3">
              <Activity className="w-4 h-4" /> AUDIO HEALTH
            </h3>
            <div className="space-y-2 text-[11px] font-mono">
              <div className="flex justify-between"><span className="text-neutral-500">STATE</span><span className="text-teal-400">{perf.audioState.toUpperCase()}</span></div>
              <div className="flex justify-between"><span className="text-neutral-500">SAMPLE RATE</span><span className="text-teal-400">{perf.audioSampleRate} Hz</span></div>
              <div className="flex justify-between"><span className="text-neutral-500">BASE LATENCY</span><span className="text-teal-400">{perf.audioBaseLatencyMs} ms</span></div>
            </div>
          </div>
        </div>

        <div className="col-span-4 space-y-4">
          <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-4">
            <h3 className="text-xs font-bold tracking-widest text-neutral-500 flex items-center gap-2 mb-3">
              <Network className="w-4 h-4" /> LATENCY BUDGETS
            </h3>
            <div className="space-y-2 text-[11px] font-mono">
              {/* P2-1: End-to-End-Latenz-Ziele: lokal < 15 ms, Netz < 50 ms. */}
              <div className="flex justify-between">
                <span className="text-neutral-500 uppercase">LOCAL (Audio)</span>
                <span className={perf.audioBaseLatencyMs < 15 ? 'text-emerald-400' : 'text-amber-400'}>
                  {perf.audioBaseLatencyMs} / 15 ms
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500 uppercase">NET (RTT)</span>
                <span className={net.rttMs > 0 && net.rttMs < 50 ? 'text-emerald-400' : 'text-amber-400'}>
                  {net.rttMs} / 50 ms
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500 uppercase">DROPOUTS</span>
                <span className={net.dropouts === 0 ? 'text-emerald-400' : 'text-amber-400'}>{net.dropouts}</span>
              </div>
              {budgets.map((b) => (
                <div key={b.pipeline} className="flex justify-between">
                  <span className="text-neutral-500 uppercase">{b.pipeline}</span>
                  <span className={b.violations > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                    {b.lastMs} / {b.budgetMs} ms
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Signal-Monitor (aus visMONK in perfMONK integriert) */}
        <div className="col-span-12">
          <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold tracking-widest text-neutral-500 flex items-center gap-2">
                <Waves className="w-4 h-4" /> SIGNAL MONITOR
              </h3>
              <select
                value={signalMode}
                onChange={(e) => setSignalMode(e.target.value as SignalMode)}
                className="bg-black text-white text-xs p-1 rounded border border-neutral-700"
              >
                <option value="OSCILLOSCOPE">Oszilloskop</option>
                <option value="SPECTROGRAM">Spektrogramm</option>
              </select>
            </div>
            <canvas ref={signalCanvasRef} width={560} height={180} className="w-full bg-black rounded" />
          </div>
        </div>
      </div>
    </div>
  );
});
