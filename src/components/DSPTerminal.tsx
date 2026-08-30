import {  useState, useEffect, useRef  } from 'react';
import { Activity, Power, Cpu, Zap, SlidersHorizontal } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { performanceMonitor, PerformanceSnapshot } from '../utils/PerformanceMonitor';

export function DSPTerminal() {
  const { state, lockStatus, updateState } = usePluginState('dsp', 'PRO');
  const [power, setPower] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Worklet-Automation (Task 1/3): sichtbare Regler + aktive Stimmen.
  const [autoParams, setAutoParams] = useState({
    cutoff: 1200, resonance: 0.4, modIndex: 5, gain: 0.8, lfoRate: 0, lfoDepth: 0,
  });
  const [activeVoices, setActiveVoices] = useState(0);
  // Echtzeit-Performance-Snapshot (FPS, Jitter, Audio-Health).
  const [perf, setPerf] = useState<PerformanceSnapshot>(() => performanceMonitor.snapshot());

  const handleParamChange = (name: string, value: number) => {
      audioEngine.setWorkletParam(name, value);
  };

  // Performance-Monitor starten und 1x/Sekunde die Anzeige aktualisieren.
  useEffect(() => {
    performanceMonitor.setAudioStateProvider(() => audioEngine.getAudioHealth());
    performanceMonitor.start();
    const timer = setInterval(() => setPerf(performanceMonitor.snapshot()), 1000);
    return () => { clearInterval(timer); performanceMonitor.stop(); };
  }, []);

  const handleAutomate = (param: 'cutoff' | 'resonance' | 'modIndex' | 'gain' | 'lfoRate' | 'lfoDepth', value: number, rampTime = 0.02) => {
    setAutoParams(prev => ({ ...prev, [param]: value }));
    audioEngine.automateItSynthParam(param, value, rampTime);
  };

  // Stimmen-Status des it-synth-Worklets in die UI spiegeln.
  useEffect(() => {
    audioEngine.onItSynthStates = (n: number) => setActiveVoices(n);
    return () => { audioEngine.onItSynthStates = () => {}; };
  }, []);


  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frameId: number;
    let phase = 0;

    const draw = () => {
      ctx.fillStyle = 'rgba(17, 17, 17, 0.2)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (power) {
        ctx.beginPath();
        for (let i = 0; i < canvas.width; i++) {
          const y = canvas.height / 2 +
                    Math.sin(i * 0.05 + phase) * 20 +
                    Math.cos(i * 0.1 + phase * 1.5) * 10;
          if (i === 0) ctx.moveTo(i, y);
          else ctx.lineTo(i, y);
        }
        ctx.strokeStyle = '#8b5cf6'; // violet-500
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw corrected phase line
        ctx.beginPath();
        for (let i = 0; i < canvas.width; i++) {
          const y = canvas.height / 2 + Math.sin(i * 0.05 + phase) * 20;
          if (i === 0) ctx.moveTo(i, y);
          else ctx.lineTo(i, y);
        }
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.5)'; // emerald-500
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      phase -= 0.1;
      frameId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(frameId);
  }, [power]);

  const modules = [
    { name: 'PHASE CORRECTION', active: true, value: 'LINEAR' },
    { name: 'DYNAMIC FILTER', active: true, value: 'MULTI-BAND' },
    { name: 'RESONANCE SUPPRESSION', active: false, value: 'OFF' },
    { name: 'SURGICAL SHAPING', active: true, value: 'ACTIVE' },
  ];

  return (
    <div className={`w-full h-full flex flex-col bg-[#111] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} overflow-hidden text-neutral-300 font-sans shadow-2xl relative ${lockStatus.active && lockStatus.lockedBy !== 'localUser' ? 'opacity-50 grayscale' : ''}`}>
      <div className="px-4 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="dsp" placeholder="MOA: z. B. 'Filter-Sweep automatisieren'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-violet-900/20 to-[#111] border-b border-violet-900/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-violet-500/20 flex items-center justify-center border border-violet-500/50 shadow-[0_0_15px_rgba(139,92,246,0.3)]">
            <Activity className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase flex items-center gap-2">
              DSP Engine <span className="text-[10px] font-mono text-violet-400 border border-violet-500/30 px-2 py-0.5 rounded-sm">ZERO JITTER</span>
            </h2>
          </div>
        </div>

        <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
        </select>

        <button type="button"
          onClick={() => setPower(!power)}
          className={`w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all ${power ? 'bg-violet-500 border-violet-600 text-white shadow-[0_0_20px_rgba(139,92,246,0.6)]' : 'bg-[#222] border-[#333] text-neutral-500 hover:bg-[#333]'}`}
        >
          <Power className="w-5 h-5" />
        </button>
      </div>

      <div className={`flex-1 p-6 grid grid-cols-12 gap-6 transition-opacity duration-1000 ${power ? 'opacity-100' : 'opacity-40 grayscale pointer-events-none'}`}>
        {/* Left Col: DSP Modules */}
        <div className="col-span-4 flex flex-col gap-4">
          <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-4 shadow-inner flex flex-col gap-3">
            <h3 className="text-xs font-bold tracking-widest text-neutral-500 flex items-center gap-2 mb-2">
              <Cpu className="w-4 h-4" /> CORE PROCESSING
            </h3>
            {modules.map(mod => (
              <div key={mod.name} className={`p-3 rounded-lg border ${mod.active ? 'bg-violet-900/10 border-violet-500/30' : 'bg-[#111] border-neutral-800'} flex items-center justify-between`}>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${mod.active ? 'bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.8)]' : 'bg-neutral-700'}`}></div>
                  <span className={`text-[10px] font-bold tracking-wider ${mod.active ? 'text-neutral-200' : 'text-neutral-500'}`}>{mod.name}</span>
                </div>
                <span className={`text-[9px] font-mono ${mod.active ? 'text-violet-400' : 'text-neutral-600'}`}>{mod.value}</span>
              </div>
            ))}
          </div>

          <div className="flex-1 bg-[#1a1a1a] rounded-xl border border-neutral-800 p-4 shadow-inner">
            <h3 className="text-xs font-bold tracking-widest text-neutral-500 flex items-center gap-2 mb-4">
              <Zap className="w-4 h-4" /> LATENCY & JITTER
            </h3>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-[10px] font-mono text-neutral-400 mb-1">
                  <span>UI FPS</span>
                  <span className="text-emerald-400">{perf.fps} fps</span>
                </div>
                <div className="w-full h-1 bg-neutral-800 rounded overflow-hidden">
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, (perf.fps / 60) * 100)}%` }}></div>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[10px] font-mono text-neutral-400 mb-1">
                  <span>FRAME JITTER</span>
                  <span className={perf.jitterMs < 2 ? 'text-emerald-400' : 'text-amber-400'}>{perf.jitterMs}ms</span>
                </div>
                <div className="w-full h-1 bg-neutral-800 rounded overflow-hidden">
                  <div className={`h-full ${perf.jitterMs < 2 ? 'bg-emerald-500' : 'bg-amber-500'} transition-all`} style={{ width: `${Math.min(100, perf.jitterMs * 10)}%` }}></div>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[10px] font-mono text-neutral-400 mb-1">
                  <span>AUDIO LATENCY</span>
                  <span className="text-emerald-400">{perf.audioBaseLatencyMs}ms</span>
                </div>
                <div className="w-full h-1 bg-neutral-800 rounded overflow-hidden">
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, perf.audioBaseLatencyMs * 4)}%` }}></div>
                </div>
              </div>
              <div className="flex justify-between text-[10px] font-mono">
                <span className="text-neutral-500">AUDIO STATE</span>
                <span className={perf.audioState === 'running' ? 'text-emerald-400' : 'text-amber-400'}>
                  {perf.audioState.toUpperCase()} · {perf.audioSampleRate ? `${(perf.audioSampleRate / 1000).toFixed(1)}kHz` : '--'}
                </span>
              </div>
              <div className="flex justify-between text-[10px] font-mono">
                <span className="text-neutral-500">DROPPED FRAMES</span>
                <span className={perf.droppedFrames === 0 ? 'text-emerald-400' : 'text-amber-400'}>{perf.droppedFrames}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Col: Visualization & Settings */}
        <div className="col-span-8 flex flex-col gap-6">
          <div className="h-48 short-landscape:h-28 bg-black rounded-xl border-4 border-neutral-800 shadow-inner p-2 relative overflow-hidden">
             <canvas ref={canvasRef} width={800} height={200} className="w-full h-full opacity-80" />
             <div className="absolute top-2 left-3 bg-black/50 px-2 py-1 rounded text-[10px] font-mono text-teal-500 border border-teal-500/30">
               REALTIME PHASE MONITOR
             </div>
          </div>

          <div className="flex-1 bg-[#1a1a1a] rounded-xl border border-neutral-800 p-6 shadow-inner grid grid-cols-4 gap-6">
            {[
                { name: 'OVERSAMPLING', id: 'oversampling', min: 1, max: 8, val: 8 },
                { name: 'LOOKAHEAD', id: 'lookahead', min: 0, max: 10, val: 1.5 },
                { name: 'TRANSIENT DETECT', id: 'transient', min: 0, max: 1, val: 0.8 },
                { name: 'STEREO LINK', id: 'stereoLink', min: 0, max: 1, val: 1 }
            ].map((param, _i) => (
              <div key={param.name} className="flex flex-col items-center justify-center gap-4">
                <input
                    type="range"
                    min={param.min} max={param.max} step="0.1"
                    value={param.val}
                    onChange={(e) => handleParamChange(param.id, Number.parseFloat(e.target.value))}
                    className="w-16 h-16 rounded-full border-4 border-[#111] bg-neutral-800 accent-violet-500 appearance-none cursor-pointer"
                />
                <div className="text-center">
                  <span className="text-[9px] font-mono font-bold text-neutral-500">{param.name}</span>
                  <div className="text-xs font-black text-violet-400 mt-1">{param.val}</div>
                </div>
              </div>
            ))}
          </div>

          {/* instrumentMONK Worklet-Automation (Task 1/3) */}
          <div className="bg-[#1a1a1a] rounded-xl border border-violet-500/30 p-4 shadow-inner">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold tracking-widest text-neutral-500 flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4" /> IT-SYNTH AUTOMATION
              </h3>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${activeVoices > 0 ? 'text-emerald-400 border-emerald-500/40 bg-emerald-950/30' : 'text-neutral-600 border-neutral-800 bg-black'}`}>
                VOICES {activeVoices}
              </span>
            </div>
            <div className="grid grid-cols-6 gap-4">
              {([
                { label: 'CUTOFF', param: 'cutoff' as const, min: 40, max: 16000, step: 10, fmt: (v: number) => `${Math.round(v)} Hz` },
                { label: 'RESO', param: 'resonance' as const, min: 0, max: 16, step: 0.1, fmt: (v: number) => v.toFixed(1) },
                { label: 'MOD INDEX', param: 'modIndex' as const, min: 0, max: 32, step: 0.5, fmt: (v: number) => v.toFixed(1) },
                { label: 'GAIN', param: 'gain' as const, min: 0, max: 1.5, step: 0.01, fmt: (v: number) => v.toFixed(2) },
                { label: 'LFO RATE', param: 'lfoRate' as const, min: 0, max: 20, step: 0.1, fmt: (v: number) => `${v.toFixed(1)} Hz` },
                { label: 'LFO DEPTH', param: 'lfoDepth' as const, min: 0, max: 1, step: 0.01, fmt: (v: number) => v.toFixed(2) },
              ]).map((c) => (
                <div key={c.param} className="flex flex-col items-center gap-1">
                  <input
                    type="range"
                    min={c.min} max={c.max} step={c.step}
                    value={autoParams[c.param]}
                    onChange={(e) => handleAutomate(c.param, Number.parseFloat(e.target.value))}
                    className="w-full h-2 accent-violet-500 cursor-pointer"
                  />
                  <span className="text-[9px] font-mono font-bold text-neutral-500">{c.label}</span>
                  <span className="text-[10px] font-black text-violet-400">{c.fmt(autoParams[c.param])}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
