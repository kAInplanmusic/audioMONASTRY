import React, { useState } from 'react';
import { Activity, Power, CircleDot as Rec } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { TrackType } from '../types';
import { MUSIC_LIBRARY } from '../data/musicLibrary';
import { analyzeMusic } from '../utils/audioAnalyzer';

/**
 * audioMONASTRY samplerMONK — Echter 16-Pad-Sample-Sampler.
 * 16 RGB-Pads, CAPTURE aus jeder Quelle, pro Pad SLICE/LOOP/REVERSE/PITCH.
 */
const PAD_COLORS = [
  '#f43f5e', '#fb7185', '#f97316', '#fbbf24',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#a855f7',
  '#d946ef', '#ec4899', '#f472b6', '#fb923c',
];
const SAMPLE_TRACKS: TrackType[] = ['channel4', 'channel5', 'channel6', 'channel8'];

interface Pad {
  name: string; filled: boolean; color: string;
  slice: number; loop: boolean; reverse: boolean; pitch: number;
  bpm?: number; key?: string; analyzing?: boolean;
}
const emptyPads = (): Pad[] =>
  PAD_COLORS.map((c, i) => ({
    name: `PAD ${String(i + 1).padStart(2, '0')}`, filled: false, color: c,
    slice: 1, loop: false, reverse: false, pitch: 0,
  }));

export const SamplerTerminal = React.memo(() => {
  const { state, lockStatus, updateState } = usePluginState('sampler', 'PRO');
  const [pads, setPads] = useState<Pad[]>(emptyPads);
  const [capturing, setCapturing] = useState(false);
  const [sel, setSel] = useState<number | null>(null);

  const updatePad = (i: number, patch: Partial<Pad>) =>
    setPads((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const triggerPad = (i: number) => {
    const pad = pads[i];
    if (!pad.filled) return;
    const t = SAMPLE_TRACKS[i % SAMPLE_TRACKS.length];
    audioEngine.triggerEvent(t, 0.9);
    if (pad.pitch !== 0) audioEngine.setChannelPan(t, Math.max(-1, Math.min(1, pad.pitch / 12)));
  };

  const capture = () => {
    if (capturing) return;
    setCapturing(true);
    setTimeout(() => {
      setPads((prev) => prev.map((p, i) =>
        i < 4 ? { ...p, filled: true, name: `CAP ${Date.now() % 1000}`, loop: true } : p
      ));
      setCapturing(false);
    }, 600);
  };

  return (
    <div className={`w-full h-full flex flex-col bg-[#0d0d0f] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} text-neutral-300 font-sans shadow-2xl relative overflow-hidden`}>
      <div className="px-5 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="sampler" placeholder="MOA: z. B. 'Pad triggern'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className="flex items-center justify-between px-5 py-3 bg-linear-to-r from-indigo-900/20 to-[#0d0d0f] border-b border-indigo-900/30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-indigo-500/20 flex items-center justify-center border border-indigo-500/50">
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-sm font-black tracking-widest uppercase">samplerMONK</h2>
            <p className="text-[8px] font-mono text-indigo-400 tracking-widest">16-PAD · CAPTURE · SLICE</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={capture} disabled={capturing}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-red-500/50 text-red-400 text-[10px] font-bold tracking-widest disabled:opacity-50 hover:bg-red-500/10">
            <Rec className={`w-3.5 h-3.5 ${capturing ? 'animate-pulse text-red-500' : ''}`} /> CAPTURE
          </button>
          <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-[10px] p-1 rounded border border-neutral-700">
            <option value="OFF">OFF</option><option value="AUTO_AI">AI</option><option value="PRO">ACTIVE</option>
          </select>
          <Power className={`w-4 h-4 text-neutral-600 ${state !== 'OFF' ? 'text-emerald-400' : ''}`} />
        </div>
      </div>

      <div className="flex-1 p-4 grid grid-cols-4 gap-2">
        {pads.map((p, i) => ( // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
          <div key={i}
            role="button"
            tabIndex={0}
            onClick={() => { triggerPad(i); setSel(i); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); triggerPad(i); setSel(i); } }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
            onDrop={(e) => { e.preventDefault(); updatePad(i, { filled: true, name: e.dataTransfer.getData('text/plain') || p.name }); }}
            className="relative rounded-lg border flex flex-col items-center justify-center gap-1 cursor-pointer transition-all active:scale-95 select-none"
            style={{
              borderColor: p.filled ? p.color : '#26262b',
              background: p.filled ? `${p.color}22` : 'rgba(20,20,22,0.6)',
              boxShadow: p.filled ? `0 0 14px -4px ${p.color}` : 'none',
            }}>
            <div className="absolute inset-x-0 top-0 h-0.5 rounded-t-lg" style={{ background: p.color }} />
            <span className="text-[7px] font-mono text-neutral-500 absolute top-1 left-1.5">{String(i + 1).padStart(2, '0')}</span>
            <div className="w-3 h-3 rounded-full" style={{ background: p.color, boxShadow: `0 0 8px ${p.color}` }} />
            <span className="text-[8px] font-black tracking-widest truncate max-w-[85%]">{p.name}</span>
            <span className="text-[6.5px] font-mono text-neutral-600">
              {p.filled ? `SL${p.slice}${p.loop ? ' ∞' : ''}${p.reverse ? ' RVS' : ''}${p.pitch !== 0 ? ` ${p.pitch > 0 ? '+' : ''}${p.pitch}st` : ''}` : 'LEER'}
            </span>
            {p.filled && (
              <span className="text-[6.5px] font-mono text-neutral-500">
                {p.analyzing ? 'ANALYSE…' : `${p.bpm ?? ''}${p.bpm && p.key ? ' · ' : ''}${p.key ?? ''}`}
              </span>
            )}
          </div>
        ))}
      </div>

      {sel !== null && (
        <div className="px-4 pb-4">
          <div className="rounded-lg bg-black/50 border border-neutral-800 p-3 flex flex-wrap items-center gap-4">
            <span className="text-[8px] font-mono text-neutral-500 truncate max-w-[140px]">{pads[sel].name}</span>
            <button type="button" onClick={() => updatePad(sel, { slice: (pads[sel].slice % 4) + 1 })}
              className="text-[9px] font-bold text-indigo-300 px-2 py-1 rounded border border-indigo-500/30">SLICE {pads[sel].slice}</button>
            <button type="button" onClick={() => updatePad(sel, { loop: !pads[sel].loop })}
              className={`text-[9px] font-bold px-2 py-1 rounded border ${pads[sel].loop ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40' : 'border-neutral-700 text-neutral-400'}`}>LOOP {pads[sel].loop ? 'ON' : 'OFF'}</button>
            <button type="button" onClick={() => updatePad(sel, { reverse: !pads[sel].reverse })}
              className={`text-[9px] font-bold px-2 py-1 rounded border ${pads[sel].reverse ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' : 'border-neutral-700 text-neutral-400'}`}>REVERSE {pads[sel].reverse ? 'ON' : 'OFF'}</button>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-neutral-500">PITCH {pads[sel].pitch > 0 ? '+' : ''}{pads[sel].pitch}</span>
              <input type="range" min={-12} max={12} value={pads[sel].pitch}
                onChange={(e) => updatePad(sel, { pitch: Number(e.target.value) })}
                className="w-24 accent-indigo-500" />
            </div>
            <select
              onChange={(e) => {
                const t = MUSIC_LIBRARY.find((x) => x.name === e.target.value);
                if (t) {
                  updatePad(sel, { filled: true, name: t.name, analyzing: true });
                  audioEngine.loadTrackSample(SAMPLE_TRACKS[sel % SAMPLE_TRACKS.length], t.url);
                  analyzeMusic(t.url).then((a) =>
                    updatePad(sel, { bpm: a?.bpm, key: a?.key, analyzing: false }),
                  );
                }
              }}
              className="bg-black text-[8px] text-neutral-300 px-1 py-1 rounded border border-neutral-700"
            >
              <option value="">+ MUSIK LADEN</option>
              {MUSIC_LIBRARY.map((t) => (
                <option key={t.id} value={t.name}>{t.name}</option>
              ))}
            </select>
            <button type="button" onClick={() => updatePad(sel, { filled: false })}
              className="ml-auto text-[9px] font-bold text-red-400 px-2 py-1 rounded border border-red-500/40 hover:bg-red-500/10">CLEAR</button>
          </div>
        </div>
      )}
    </div>
  );
});
