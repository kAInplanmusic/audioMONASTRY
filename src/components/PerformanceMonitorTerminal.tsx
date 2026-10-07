import React, { useState, useEffect, useRef } from 'react';
import { Activity, Cpu, Gauge, Network, Waves, Play } from 'lucide-react';
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
  const { state, updateState } = usePluginState('perfor', 'PRO');
  const [perf, setPerf] = useState<PerformanceSnapshot>(() => performanceMonitor.snapshot());
  const [net, setNet] = useState({ rttMs: 0, dropouts: 0 });
  const [latencyBudget, setLatencyBudget] = useState(() => audioEngine.getLatencyBudgetMs());
  const [tel, setTel] = useState(() => telemetry.snapshot());
  const [signalMode, setSignalMode] = useState<SignalMode>('OSCILLOSCOPE');
  const signalCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    performanceMonitor.setAudioStateProvider(() => audioEngine.getAudioHealth());
    performanceMonitor.start();
    const timer = setInterval(() => {
      setPerf(performanceMonitor.snapshot());
      // AM-E6-1: Kontinuierliches Profiling – Xruns, Worklet-CPU-Budgets,
      // Per-Sample-Allokationen aus der Telemetrie-Registry anzeigen.
      setTel(telemetry.snapshot());
      // P2-1: End-to-End-Latenz live anzeigen (lokal = Audio, Netz = WebRTC).
      setNet({
        rttMs: Math.round(webRTCManager.lastRttMs * 10) / 10,
        dropouts: audioEngine.dropoutCount,
      });
      // A-4: Latenz-Budget inkl. Mastering-Lookahead/PDC.
      setLatencyBudget(audioEngine.getLatencyBudgetMs());
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

  const budgets = tel.budgets;
  const worklets = tel.worklets;
  const xruns = tel.xruns;

  // Kompakt nach Vorlage (uiübersichtapp, Zeile „PERFORMANCE / TELEMETRY"): eine Zeile Kennzahlen.
  const worst = worklets.reduce((m, w) => Math.max(m, w.lastMs / Math.max(0.001, w.budgetMs)), 0);
  const kpi = (label: string, value: React.ReactNode, ok = true, hint?: string) => (
    <div className="am-kpi" title={hint}><b style={{ color: ok ? 'var(--ok)' : 'var(--warn)' }}>{value}</b><span>{label}</span></div>
  );
  return (
    <div className="am-perf">
      <MoaAssistant pluginId="performance" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      <div className="am-perfgrid">
        <div className="am-kgroup"><span className="am-lbl"><Cpu className="am-ico" /> System</span>
          {kpi('UI FPS', perf.fps, perf.fps >= 30)}
          {kpi('Jitter', `${perf.jitterMs} ms`, perf.jitterMs < 8)}
          {kpi('Frames verloren', perf.droppedFrames, perf.droppedFrames < 30)}
        </div>
        <div className="am-kgroup"><span className="am-lbl"><Activity className="am-ico" /> Audio</span>
          {kpi('Zustand', perf.audioState.toUpperCase(), perf.audioState === 'running', perf.audioState === 'closed' ? 'PLAY drücken, um Audio zu starten' : undefined)}
          {kpi('Abtastrate', `${perf.audioSampleRate} Hz`)}
          {kpi('Latenz lokal', `${perf.audioBaseLatencyMs}/15 ms`, perf.audioBaseLatencyMs < 15)}
        </div>
        <div className="am-kgroup"><span className="am-lbl"><Network className="am-ico" /> Netz</span>
          {kpi('RTT', `${net.rttMs}/50 ms`, net.rttMs < 50)}
          {kpi('Dropouts', net.dropouts, net.dropouts === 0)}
          {kpi('Xruns', xruns.count, xruns.count === 0)}
        </div>
        <div className="am-kgroup"><span className="am-lbl"><Gauge className="am-ico" /> Budgets</span>
          {kpi('Lookahead', `${latencyBudget.masteringLookaheadMs.toFixed(1)} ms`)}
          {kpi('Cue PDC', `${latencyBudget.cuePdcMs.toFixed(1)} ms`)}
          {kpi('Worklets', worklets.length ? `${Math.round(worst * 100)} %` : '–', worst < 1, budgets.map((b) => `${b.pipeline} ${b.lastMs}/${b.budgetMs} ms`).join(' · '))}
        </div>
        <div className="am-kgroup am-kscope"><span className="am-lbl"><Waves className="am-ico" /> Signal
          <select value={signalMode} onChange={(e) => setSignalMode(e.target.value as SignalMode)} aria-label="Signal-Monitor Ansicht" className="am-sel" style={{ marginLeft: 6, padding: '1px 4px', fontSize: 10 }}>
            <option value="OSCILLOSCOPE">Oszilloskop</option>
            <option value="SPECTROGRAM">Spektrogramm</option>
          </select></span>
          <canvas ref={signalCanvasRef} width={560} height={60} className="am-scope" />
        </div>
      </div>
      {perf.audioState === 'closed' && (
        <div className="am-hint" style={{ color: 'var(--warn)' }}><Play className="am-ico" /> PLAY drücken, um Audio zu starten</div>
      )}
      {tel.counters['worklet.allocations'] > 0 && (
        <div className="am-hint" style={{ color: 'var(--warn)' }}>Per-Sample-Allokationen in Worklets: {tel.counters['worklet.allocations']}</div>
      )}
    </div>
  );
});
