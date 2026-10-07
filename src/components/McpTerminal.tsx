import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePluginState } from '../hooks/usePluginState';
import { useSamples } from '../context/SampleContext';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { AmCard, AmKnob, AmSeg, AmToggle } from './am/amUi';
import { readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
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
  const { state, lockStatus, updateState } = usePluginState('syntisampler', 'PRO');
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
      const parsed = readPluginSettings<McpState>('syntisampler', { section: 'mpc', legacyKey: STORAGE_KEY });
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
    // Beständige Plugins: MPC-Bereich des syntisampler an die Session.
    writePluginSettings('syntisampler', { bank, seqCount, swing, patterns, padSamples } satisfies McpState, { section: 'mpc' });
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

  const step = currentStep % seqCount;
  const selPattern = patterns[key(selPad)] ?? [];
  const selColor = PAD_COLORS[selPad] ?? PAD_COLORS[0];

  return (
    <div className={`am-rackrow ${lockedByOther ? 'am-c-locked' : ''}`}>
      <MoaAssistant pluginId="mcp" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      {/* MPC-Pads: Sample je Pad (DnD/Touch-Armierung), Velocity aus der Tipp-Höhe */}
      <AmCard title={`MPC-Pads · Bank ${bank}`} style={{ width: 236 }}
        right={(
          <AmToggle on={noteRepeat} kind="m" disabled={lockedByOther} onClick={() => setNoteRepeat(!noteRepeat)} title="Note Repeat beim Halten">
            REPEAT
          </AmToggle>
        )}>
        <div className="am-c-pads">
          {PAD_COLORS.map((color, i) => {
            const sample = padSamples[i];
            const selected = selPad === i;
            return (
              <button
                type="button"
                key={i}
                aria-label={`Pad ${i + 1}${sample ? `: ${sample.name}` : ''}`}
                title={sample ? sample.name : `Pad ${i + 1} (leer) – Sample hierher ziehen`}
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
                className={`am-pad ${sample ? '' : 'am-c-empty'} ${selected ? 'am-c-sel' : ''} ${flashPad === i ? 'am-hit' : ''}`}
                style={{ ['--pc' as string]: color }}
              >
                <span>{sample ? sample.name.slice(0, 8) : String(i + 1).padStart(2, '0')}</span>
              </button>
            );
          })}
        </div>
      </AmCard>

      {/* Step-Sequencer des gewählten Pads */}
      <AmCard title={`Step-Sequenzer · Pad ${selPad + 1}`} style={{ flex: 1, minWidth: 440 }}
        right={<span className="am-c-stat"><span data-live-value="step">STEP {step + 1}/{seqCount}</span> · {selPattern.filter(Boolean).length} aktiv</span>}>
        <div className="am-c-row">
          <AmSeg<Bank> label="Bank" value={bank} onChange={setBank} disabled={lockedByOther} options={BANKS.map((b) => [b, b] as const)} />
          <AmSeg label="Steps" value={String(seqCount) as '16' | '32'} disabled={lockedByOther}
            onChange={(v) => setSeqCount(v === '32' ? 32 : 16)} options={[['16', '16'], ['32', '32']]} />
          {(['four', 'break', 'random'] as const).map((p) => (
            <button type="button" key={p} className="am-tg" onClick={() => applyPreset(p)} disabled={lockedByOther}>
              {p.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="am-c-seq am-c-st" style={{ ['--n' as string]: Math.min(seqCount, 16) }} role="group" aria-label={`Steps Pad ${selPad + 1}`}>
          {[...Array(seqCount)].map((_, i) => {
            const isOn = selPattern[i] ?? false;
            return (
              <React.Fragment key={i}>
                {i % 16 === 0 && <span className="am-c-trk am-on" style={{ ['--c' as string]: selColor }}>PAD {selPad + 1}{seqCount === 32 ? (i === 0 ? ' ·1' : ' ·2') : ''}</span>}
                <button
                  type="button"
                  aria-label={`Step ${i + 1} ${isOn ? 'aus' : 'an'}`}
                  aria-pressed={isOn}
                  onClick={() => toggleStep(i)}
                  disabled={lockedByOther}
                  className={`am-stp ${isOn ? 'am-v2' : ''} ${i % 4 === 0 ? 'am-q' : ''} ${step === i ? 'am-ph' : ''}`}
                  style={{ ['--c' as string]: selColor }}
                >
                  {i + 1}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </AmCard>

      <AmCard title="Groove" style={{ width: 120 }}>
        <div className="am-knobs">
          <AmKnob value={swing} min={0} max={1} def={0} unit="pct" label="Swing" title="Swing (systemweit)" disabled={lockedByOther}
            onChange={(v) => setSwing(Math.round(v * 100) / 100)} />
        </div>
        <span className="am-hint" style={{ fontSize: 10 }}>→ MAIN · CH5</span>
      </AmCard>
    </div>
  );
});
