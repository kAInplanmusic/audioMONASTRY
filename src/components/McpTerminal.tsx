import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Grid3X3 } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { useSamples } from '../context/SampleContext';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { storageGetJson, storageSetJson } from '../utils/storage';
import { random } from '../utils/random';
import type { AudioSample } from '../data/samples';
import { webRTCManager } from '../utils/WebRTCManager';

/**
 * mcpMONK – MPC + Sequencer (NEW-MONK-3: voller MPC-Ausbau)
 * ===========================================================
 * - 4×4-MPC-Pads mit Sample je Pad (Library-DnD / Action-Menu-Übernahme)
 * - 16-Level-Velocity (Tipp-Position), Note Repeat (Hold)
 * - Bank A–D, 16/32-Step-Sequencer je Pad, Swing systemweit
 * - Audio-Routing auf MAIN via mixerMONK (channel5)
 */

const PAD_COLORS = [
  '#f43f5e', '#fb7185', '#f97316', '#fbbf24',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#a855f7',
  '#d946ef', '#ec4899', '#f472b6', '#fb923c',
];

const BANKS = ['A', 'B', 'C', 'D'] as const;
type Bank = (typeof BANKS)[number];

const STORAGE_KEY = 'mcp-state-v2';

interface McpState {
  bank: Bank;
  seqCount: 16 | 32;
  swing: number;
  patterns: Record<string, boolean[]>;
  padSamples: Record<number, AudioSample>;
}

const emptyPattern = (n: number): boolean[] => Array(n).fill(false);

export const McpTerminal = React.memo(function McpTerminal() {
  const { state, lockStatus, updateState } = usePluginState('mcp', 'PRO');
  const lockedByOther = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  const { pendingSample, setPendingSample, takeoverRequest, clearTakeoverRequest } = useSamples();

  const [bank, setBank] = useState<Bank>('A');
  const [seqCount, setSeqCount] = useState<16 | 32>(16);
  const [swing, setSwing] = useState(0);
  const [patterns, setPatterns] = useState<Record<string, boolean[]>>({});
  const [padSamples, setPadSamples] = useState<Record<number, AudioSample>>({});
  const [selPad, setSelPad] = useState<number>(0);
  const [noteRepeat, setNoteRepeat] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [flashPad, setFlashPad] = useState<number | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Persistenz laden.
  useEffect(() => {
    try {
      const parsed = storageGetJson<McpState>(STORAGE_KEY);
      if (parsed) {
        if (BANKS.includes(parsed.bank as Bank)) setBank(parsed.bank as Bank);
        if (parsed.seqCount === 16 || parsed.seqCount === 32) setSeqCount(parsed.seqCount);
        if (typeof parsed.swing === 'number') setSwing(parsed.swing);
        if (parsed.patterns) setPatterns(parsed.patterns);
        if (parsed.padSamples) setPadSamples(parsed.padSamples);
      }
    } catch { /* ignore */ }
  }, []);

  // Persistenz speichern.
  useEffect(() => {
    storageSetJson(STORAGE_KEY, { bank, seqCount, swing, patterns, padSamples } satisfies McpState);
  }, [bank, seqCount, swing, patterns, padSamples]);

  // Step-Anzeige vom Master-Transport.
  useEffect(() => audioEngine.addStepListener(setCurrentStep), []);

  // Swing systemweit anwenden.
  useEffect(() => {
    audioEngine.setSwing(swing);
  }, [swing]);

  // Action-Menu-Übernahme: Sample auf das gewählte Pad legen.
  useEffect(() => {
    if (!takeoverRequest || takeoverRequest.pluginId !== 'mcp') return;
    const sample = takeoverRequest.sample;
    setPadSamples((prev) => ({ ...prev, [selPad]: sample }));
    if (sample.url) {
      void audioEngine.loadTrackSample('channel5', sample.url).catch(() => { /* URL optional */ });
    }
    clearTakeoverRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeoverRequest]);

  const key = useCallback((pad: number) => `${bank}:${pad}`, [bank]);

  const triggerPad = useCallback((idx: number, velocity: number) => {
    if (lockedByOther) return;
    const sample = padSamples[idx];
    if (sample?.url) {
      try {
        const a = new Audio(sample.url);
        a.volume = Math.max(0.2, Math.min(1, velocity));
        void a.play();
      } catch { /* Fallback unten */ }
    } else {
      audioEngine.triggerEvent('channel5', Math.max(0.2, Math.min(1, velocity)));
    }
    setSelPad(idx);
    setFlashPad(idx);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashPad(null), 160);
  }, [lockedByOther, padSamples]);

  const toggleStep = (step: number) => {
    if (lockedByOther) return;
    const k = key(selPad);
    setPatterns((prev) => {
      const arr = prev[k] ? [...prev[k]] : emptyPattern(seqCount);
      arr[step] = !arr[step];
      return { ...prev, [k]: arr };
    });
  };

  // Transport: aktive Steps des gewählten Pads triggern (Swing/16-Level-Akzent).
  useEffect(() => {
    const k = key(selPad);
    const arr = patterns[k];
    if (!arr) return;
    const step = currentStep % seqCount;
    if (arr[step]) {
      const accent = step % 4 === 0 ? 1 : 0.72;
      triggerPad(selPad, accent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, patterns, selPad, key, seqCount]);

  const applyPreset = useCallback((preset: 'four' | 'break' | 'random') => {
    if (lockedByOther) return;
    const k = key(selPad);
    setPatterns((prev) => {
      let arr: boolean[];
      if (preset === 'four') {
        arr = Array.from({ length: seqCount }, (_, i) => i % 4 === 0);
      } else if (preset === 'break') {
        arr = Array.from({ length: seqCount }, (_, i) => i % 4 === 0 || i % 7 === 3);
      } else {
        arr = Array.from({ length: seqCount }, () => random() < 0.5);
      }
      return { ...prev, [k]: arr };
    });
  }, [lockedByOther, key, selPad, seqCount]);

  // MOA-Kommandos: pattern_four / pattern_break / pattern_random.
  useEffect(() => {
    const handler = (e: Event) => {
      const preset = (e as CustomEvent).detail?.preset as 'four' | 'break' | 'random' | undefined;
      if (preset) applyPreset(preset);
    };
    window.addEventListener('monk:mcp-pattern', handler);
    return () => window.removeEventListener('monk:mcp-pattern', handler);
  }, [applyPreset]);

  const startNoteRepeat = (idx: number, velocity: number) => {
    if (!noteRepeat) { triggerPad(idx, velocity); return; }
    triggerPad(idx, velocity);
    if (repeatTimerRef.current) clearInterval(repeatTimerRef.current);
    repeatTimerRef.current = setInterval(() => triggerPad(idx, velocity), 120);
  };

  const stopNoteRepeat = () => {
    if (repeatTimerRef.current) {
      clearInterval(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
  };

  useEffect(() => () => stopNoteRepeat(), []);

  return (
    <div className={`w-full h-full flex flex-col bg-[#0d0d0f] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} text-neutral-300 font-sans shadow-2xl relative overflow-hidden ${lockedByOther ? 'opacity-50 grayscale' : ''}`}>
      <div className="px-5 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="mcp" placeholder="MOA: z. B. 'Pattern Four-on-the-Floor'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>

      <div className="flex items-center justify-between px-5 py-3 bg-linear-to-r from-amber-900/20 to-[#0d0d0f] border-b border-amber-900/30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-amber-500/20 flex items-center justify-center border border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.3)]">
            <Grid3X3 className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <h2 className="text-sm font-black tracking-widest uppercase">mcpMONK</h2>
            <p className="text-[9px] font-mono text-amber-400 tracking-widest">MPC PADS · {seqCount} STEPS · BANK {bank}</p>
          </div>
          <img src="/uipadsequenzer.jpg" alt="Pad-Sequenzer-Referenz" title="Pad-Sequenzer-Referenz (uipadsequenzer.jpg)"
            className="h-10 rounded border border-neutral-800 hover:border-amber-500/60 transition-colors object-cover" />
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[9px] font-mono tracking-widest px-2 py-1 rounded border ${currentStep >= 0 ? 'text-amber-300 border-amber-500/40 bg-amber-500/10' : 'text-neutral-500 border-neutral-700'}`}>
            STEP {currentStep + 1}/{seqCount}
          </span>
          <select value={state} onChange={(e) => updateState(e.target.value as any)} disabled={lockedByOther} className="bg-black text-white text-[10px] p-1 rounded border border-neutral-700">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
          </select>
        </div>
      </div>

      <div className="flex-1 p-4 grid grid-cols-2 gap-4 overflow-y-auto">
        {/* MPC-Pads */}
        <div className="bg-[#141416] rounded-lg border border-neutral-800 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono tracking-[0.25em] text-amber-500">PADS · SAMPLE JE PAD</span>
            <button
              type="button"
              onClick={() => setNoteRepeat(!noteRepeat)}
              disabled={lockedByOther}
              className={`text-[8px] font-bold px-2 py-0.5 rounded border ${noteRepeat ? 'bg-amber-500 text-black border-amber-300' : 'border-neutral-700 text-neutral-500'}`}
            >
              NOTE REPEAT {noteRepeat ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="grid grid-cols-4 gap-2 flex-1 min-h-[120px]">
            {PAD_COLORS.map((color, i) => {
              const sample = padSamples[i];
              const selected = selPad === i;
              return (
                <button
                  type="button"
                  key={i}
                  onPointerDown={(e) => {
                    if (lockedByOther) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const velocity = Math.max(0.2, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
                    startNoteRepeat(i, velocity);
                  }}
                  onPointerUp={stopNoteRepeat}
                  onPointerLeave={stopNoteRepeat}
                  onClick={(e) => {
                    // Touch-Fallback: armiertes Sample hat Vorrang vor Trigger.
                    if (pendingSample && !lockedByOther) {
                      e.preventDefault();
                      setPadSamples((prev) => ({ ...prev, [i]: pendingSample }));
                      setPendingSample(null);
                      setSelPad(i);
                      return;
                    }
                  }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (lockedByOther) return;
                    try {
                      const sample = JSON.parse(e.dataTransfer.getData('application/json')) as AudioSample;
                      setPadSamples((prev) => ({ ...prev, [i]: sample }));
                      if (sample.url) void audioEngine.loadTrackSample('channel5', sample.url).catch(() => {});
                      setSelPad(i);
                    } catch { /* kein gültiges Sample */ }
                  }}
                  disabled={lockedByOther}
                  className={`aspect-square rounded-[4px] border flex flex-col items-center justify-center gap-1 transition-all duration-75 active:scale-95 cursor-pointer disabled:opacity-40 ${
                    selected ? 'ring-2 ring-white/80' : ''
                  }`}
                  style={{
                    borderColor: flashPad === i ? '#fff' : sample ? color : '#26262b',
                    background: flashPad === i ? `${color}cc` : sample ? `${color}33` : `${color}22`,
                    boxShadow: flashPad === i ? `0 0 14px -2px ${color}` : 'none',
                  }}
                >
                  <span className="text-[7px] font-mono text-neutral-500">{String(i + 1).padStart(2, '0')}</span>
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                  <span className="text-[7px] font-black tracking-widest truncate max-w-[90%] text-neutral-200">
                    {sample ? sample.name.slice(0, 8) : 'PAD'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Step-Sequencer */}
        <div className="bg-[#141416] rounded-lg border border-neutral-800 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between flex-wrap gap-1">
            <span className="text-[9px] font-mono tracking-[0.25em] text-amber-500">STEP SEQ · PAD {selPad + 1}</span>
            <span className="text-[8px] font-mono text-neutral-600">{(patterns[key(selPad)] ?? []).filter(Boolean).length}/{seqCount} STEPS</span>
          </div>
          <div className="grid grid-cols-8 gap-1.5 flex-1 content-start">
            {[...Array(seqCount)].map((_, i) => {
              const isOn = patterns[key(selPad)]?.[i] ?? false;
              return (
                <button
                  type="button"
                  key={i}
                  onClick={() => toggleStep(i)}
                  disabled={lockedByOther}
                  className={`h-8 rounded-[3px] border transition-all cursor-pointer disabled:opacity-40 ${isOn ? 'bg-amber-500 border-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.6)]' : 'bg-[#0d0d0f] border-neutral-800 hover:border-amber-600/60'} ${currentStep % seqCount === i ? 'ring-2 ring-white/80' : ''}`}
                >
                  <span className="text-[7px] font-mono text-black/80">{i + 1}</span>
                </button>
              );
            })}
          </div>
          <div className="flex gap-1.5 flex-wrap items-center">
            {BANKS.map((b) => (
              <button
                type="button"
                key={b}
                onClick={() => setBank(b)}
                disabled={lockedByOther}
                className={`px-2 py-1 rounded-[3px] border text-[8px] font-bold tracking-widest cursor-pointer disabled:opacity-40 ${bank === b ? 'bg-amber-500 text-black border-amber-300' : 'bg-[#111] border-neutral-800 text-neutral-400'}`}
              >
                {b}
              </button>
            ))}
            {([16, 32] as const).map((n) => (
              <button
                type="button"
                key={n}
                onClick={() => setSeqCount(n)}
                disabled={lockedByOther}
                className={`px-2 py-1 rounded-[3px] border text-[8px] font-bold tracking-widest cursor-pointer disabled:opacity-40 ${seqCount === n ? 'bg-amber-500 text-black border-amber-300' : 'bg-[#111] border-neutral-800 text-neutral-400'}`}
              >
                {n}
              </button>
            ))}
            {(['four', 'break', 'random'] as const).map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => applyPreset(p)}
                disabled={lockedByOther}
                className="px-2 py-1 rounded-[3px] bg-[#111] border border-neutral-800 text-[8px] font-bold tracking-widest text-neutral-400 hover:text-amber-300 hover:border-amber-600/60 uppercase cursor-pointer disabled:opacity-40"
              >
                {p}
              </button>
            ))}
            <div className="flex items-center gap-1">
              <span className="text-[8px] font-mono text-neutral-600">SWING</span>
              <input
                type="range" min={0} max={100} value={Math.round(swing * 100)}
                onChange={(e) => setSwing(Number(e.target.value) / 100)}
                className="w-16 accent-amber-500"
              />
            </div>
          </div>
        </div>
      </div>

      <p className="px-5 pb-3 text-[9px] font-mono text-neutral-600 leading-relaxed">
        NEW-MONK-3: Sample je Pad (DnD/Touch-Armierung), 16-Level-Velocity, Note Repeat, Bank A–D, 16/32 Steps, Swing → MAIN via mixerMONK (channel5).
      </p>
    </div>
  );
});
