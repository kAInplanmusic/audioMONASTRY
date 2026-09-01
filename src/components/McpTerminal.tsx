import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Grid3X3 } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { storageGetJson, storageSetJson } from '../utils/storage';
import { random } from '../utils/random';

/**
 * mcpMONK – MPC + Sequencer (v1, Slot-Ersatz für sequencerMONK)
 * ===============================================================
 * v1: 4×4-MPC-Pads (Trigger auf Kanal 5) + 16-Step-Grid mit Persistenz.
 * Voller MPC-Ausbau (Sample je Pad, 16-Level, Note Repeat, Bänke) folgt
 * laut MASTER_TODO (NEW-MONK-3).
 */

const PAD_COLORS = [
  '#f43f5e', '#fb7185', '#f97316', '#fbbf24',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#a855f7',
  '#d946ef', '#ec4899', '#f472b6', '#fb923c',
];

const EMPTY_16 = (): boolean[] => Array(16).fill(false);

const STORAGE_KEY = 'mcp-state';

export const McpTerminal = React.memo(function McpTerminal() {
  const { state, lockStatus, updateState } = usePluginState('mcp', 'PRO');
  const lockedByOther = lockStatus.active && lockStatus.lockedBy !== 'localUser';

  const [steps, setSteps] = useState<boolean[]>(EMPTY_16);
  const [currentStep, setCurrentStep] = useState(0);
  const [flashPad, setFlashPad] = useState<number | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persistenz laden.
  useEffect(() => {
    try {
      const parsed = storageGetJson<{ steps?: boolean[] }>(STORAGE_KEY);
      if (parsed?.steps && Array.isArray(parsed.steps) && parsed.steps.length === 16) {
        setSteps(parsed.steps);
      }
    } catch { /* ignore */ }
  }, []);

  // Persistenz speichern.
  useEffect(() => {
    storageSetJson(STORAGE_KEY, { steps });
  }, [steps]);

  // Step-Anzeige vom Master-Transport.
  useEffect(() => audioEngine.addStepListener(setCurrentStep), []);

  const applyPreset = useCallback((preset: 'four' | 'break' | 'random') => {
    setSteps((prev) => {
      if (preset === 'four') return [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false];
      if (preset === 'break') return [true, false, false, true, false, false, true, false, true, false, false, true, false, false, true, false];
      return Array.from({ length: 16 }, () => random() < 0.5);
    });
  }, []);

  // MOA-Kommandos: pattern_four / pattern_break / pattern_random.
  useEffect(() => {
    const handler = (e: Event) => {
      const preset = (e as CustomEvent).detail?.preset as 'four' | 'break' | 'random' | undefined;
      if (preset) applyPreset(preset);
    };
    window.addEventListener('monk:mcp-pattern', handler);
    return () => window.removeEventListener('monk:mcp-pattern', handler);
  }, [applyPreset]);

  const triggerPad = (idx: number, velocity: number) => {
    if (lockedByOther) return;
    audioEngine.triggerEvent('channel5', Math.max(0.2, Math.min(1, velocity)));
    setFlashPad(idx);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashPad(null), 160);
  };

  const toggleStep = (idx: number) => {
    if (lockedByOther) return;
    setSteps((prev) => {
      const next = [...prev];
      next[idx] = !next[idx];
      return next;
    });
  };

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
            <p className="text-[9px] font-mono text-amber-400 tracking-widest">MPC PADS · STEP SEQ</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[9px] font-mono tracking-widest px-2 py-1 rounded border ${currentStep >= 0 ? 'text-amber-300 border-amber-500/40 bg-amber-500/10' : 'text-neutral-500 border-neutral-700'}`}>
            STEP {currentStep + 1}/16
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
            <span className="text-[9px] font-mono tracking-[0.25em] text-amber-500">PADS</span>
            <span className="text-[8px] font-mono text-neutral-600">VELOCITY = TIPP-POSITION</span>
          </div>
          <div className="grid grid-cols-4 gap-2 flex-1 min-h-[120px]">
            {PAD_COLORS.map((color, i) => (
              <button
                type="button"
                key={i}
                onPointerDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const velocity = Math.max(0.2, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
                  triggerPad(i, velocity);
                }}
                disabled={lockedByOther}
                className="aspect-square rounded-[4px] border flex flex-col items-center justify-center gap-1 transition-all duration-75 active:scale-95 cursor-pointer disabled:opacity-40"
                style={{
                  borderColor: flashPad === i ? '#fff' : '#26262b',
                  background: flashPad === i ? `${color}cc` : `${color}22`,
                  boxShadow: flashPad === i ? `0 0 14px -2px ${color}` : 'none',
                }}
              >
                <span className="text-[7px] font-mono text-neutral-500">{String(i + 1).padStart(2, '0')}</span>
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
              </button>
            ))}
          </div>
        </div>

        {/* Step-Sequencer */}
        <div className="bg-[#141416] rounded-lg border border-neutral-800 p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono tracking-[0.25em] text-amber-500">STEP SEQ · 16</span>
            <span className="text-[8px] font-mono text-neutral-600">{steps.filter(Boolean).length}/16 STEPS</span>
          </div>
          <div className="grid grid-cols-8 gap-1.5 flex-1 content-start">
            {steps.map((isOn, i) => (
              <button
                type="button"
                key={i}
                onClick={() => toggleStep(i)}
                disabled={lockedByOther}
                className={`h-8 rounded-[3px] border transition-all cursor-pointer disabled:opacity-40 ${isOn ? 'bg-amber-500 border-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.6)]' : 'bg-[#0d0d0f] border-neutral-800 hover:border-amber-600/60'} ${currentStep === i ? 'ring-2 ring-white/80' : ''}`}
              >
                <span className="text-[7px] font-mono text-black/80">{i + 1}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-1.5 flex-wrap">
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
          </div>
        </div>
      </div>

      <p className="px-5 pb-3 text-[9px] font-mono text-neutral-600 leading-relaxed">
        v1: Pads triggern Kanal 5 · Step-Grid läuft zum Master-Transport · voller MPC-Ausbau folgt (MASTER_TODO NEW-MONK-3).
      </p>
    </div>
  );
});
