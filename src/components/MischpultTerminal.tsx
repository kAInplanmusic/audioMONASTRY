import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Sliders } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';

interface RoutingEntry {
  channel: number;
  source: string;
  type: string;
  color: string;
  volume: number; // 0 to 1
  pan: number; // -1 to 1 (Stereo)
}

const ChannelStrip = React.memo(({ ch, onUpdate }: { ch: RoutingEntry; onUpdate: (channel: number, updates: Partial<RoutingEntry>) => void }) => {
    return (
        <div
          className="flex-1 flex flex-col bg-[#161616] rounded-md border border-neutral-800 p-2"
        >
          <div className={`w-full h-2 ${ch.color} rounded-t-sm mb-2`} />
          <span className="text-[9px] font-black text-neutral-400 text-center uppercase truncate">{ch.source}</span>

          {/* Fader */}
          <div className="flex-1 flex justify-center bg-[#080808] rounded-sm border border-neutral-900 relative my-2">
              <input
                  type="range"
                  min="0" max="1" step="0.01"
                  value={ch.volume}
                  onChange={(e) => onUpdate(ch.channel, { volume: Number.parseFloat(e.target.value) })}
                  className="w-2 appearance-none h-full bg-neutral-800 rounded-sm accent-blue-500"
              />
          </div>

          {/* Pan */}
          <input
              type="range"
              min="-1" max="1" step="0.1"
              value={ch.pan}
              onChange={(e) => onUpdate(ch.channel, { pan: Number.parseFloat(e.target.value) })}
              className="w-full accent-neutral-500 h-1"
          />
        </div>
    );
});

export const MischpultTerminal = React.memo(() => {
  const { state, lockStatus, updateState } = usePluginState('mixer', 'PRO');
  const [channels, setChannels] = useState<RoutingEntry[]>(
    Array.from({ length: 10 }, (_, i) => ({
      channel: i,
      source: `CH ${i + 1}`,
      type: 'Input',
      color: 'bg-blue-500',
      volume: 0.8,
      pan: 0
    }))
  );

  const updateChannel = useCallback((channel: number, updates: Partial<RoutingEntry>) => {
    setChannels(prev => prev.map(ch => {
      if (ch.channel !== channel) return ch;
      const updated = { ...ch, ...updates };
      // Apply volume/pan changes to audio engine – ZIMMER-FREI (glatte Rampen)
      if (updates.volume !== undefined) {
        const dbVolume = updated.volume > 0 ? 20 * Math.log10(updated.volume) : -Infinity;
        audioEngine.setMixChannelParam('gain', dbVolume, 0.03);
        audioEngine.setWorkletParam(`ch${channel}_volume`, dbVolume);
      }
      if (updates.pan !== undefined) {
        audioEngine.setMixChannelParam('pan', updated.pan, 0.03);
        audioEngine.setWorkletParam(`ch${channel}_pan`, updated.pan);
      }
      return updated;
    }));
  }, []);

  // Task 8: LUFS-Metering im Mischpult (True-Peak/Lautheit anzeigen)
  const [lufs, setLufs] = useState<number>(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const tick = () => { setLufs(audioEngine.getLufsValue()); rafRef.current = requestAnimationFrame(tick); };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  return (
    <div className={`w-full h-full flex flex-col bg-[#1a1a1a] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} text-neutral-300 font-sans shadow-2xl relative ${lockStatus.active && lockStatus.lockedBy !== 'localUser' ? 'opacity-50 grayscale' : ''}`}>

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-b from-[#2a2a2a] to-[#1a1a1a] border-b border-neutral-800">
        <div className="flex items-center gap-3">
          <Sliders className="w-5 h-5 text-blue-400" />
          <h2 className="text-xl font-black tracking-widest uppercase">PRO-MIX 9000</h2>
        </div>
        <div className="flex items-center gap-3">
          <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
          </select>
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-lime-400" title="Integrierte Lautheit (LUFS)">
            <span className="w-2 h-2 rounded-full bg-lime-500 animate-pulse" />
            {lufs.toFixed(1)} LUFS
          </div>
        </div>
      </div>

      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="mixer" placeholder="MOA: z. B. 'Pegel -6 dB, Pan breit'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>

      {/* Mixer Matrix */}
      <div className="flex-1 p-6 flex gap-4 bg-[#111]">
        {channels.map((ch: RoutingEntry) => (
            <ChannelStrip key={ch.channel} ch={ch} onUpdate={updateChannel} />
        ))}
      </div>
    </div>
  );
});
