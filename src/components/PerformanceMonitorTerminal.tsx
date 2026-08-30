import { useState, useEffect } from 'react';
import { Activity, Cpu, Gauge, Network } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { performanceMonitor, PerformanceSnapshot } from '../utils/PerformanceMonitor';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { telemetry } from '../utils/telemetry';

/**
 * R1 – Performance-Monitoring-Terminal (Plugin-Slot 17)
 * =====================================================
 * Echtzeit-CPU-/UI-Metriken, Latenz-Budgets pro Pipeline und
 * WebRTC-/Jitter-Überblick.
 */
export function PerformanceMonitorTerminal() {
  const { state, updateState } = usePluginState('performance', 'PRO');
  const [perf, setPerf] = useState<PerformanceSnapshot>(() => performanceMonitor.snapshot());

  useEffect(() => {
    performanceMonitor.setAudioStateProvider(() => audioEngine.getAudioHealth());
    performanceMonitor.start();
    const timer = setInterval(() => setPerf(performanceMonitor.snapshot()), 1000);
    return () => { clearInterval(timer); performanceMonitor.stop(); };
  }, []);

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
      </div>
    </div>
  );
}
