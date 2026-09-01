import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { random } from '../utils/random';
import { useSamples } from '../context/SampleContext';
import { DropTarget } from './DropTarget';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { isTrustedMediaUrl } from '../utils/mediaUrlGuard';
import { storageGetJson, storageSetJson } from '../utils/storage';
import { SampleModuleWrapper } from './SampleModuleWrapper';
import { MoaAssistant } from './MoaAssistant';
import { DRUM_KITS } from '../data/drumKits';

/**
 * audioMONASTRY drumMONK – TR-8S-Optik + echter 16-Step-Sequencer.
 * ---------------------------------------------------------------
 * - Instrument-Pad wählen → dessen 16 Steps im TR-8S-Layout editieren
 * - Steps triggern beim globalen Transport (isPlaying/currentStep)
 * - Akzente: Downbeats (1/5/9/13) mit voller Velocity, Rest 72 %
 * - Sample-Drop auf Step = One-Shot-Sample statt Kit-Sound
 * - Pattern-Presets (Four/Offbeat/Fill/Random), Clear, Persistenz
 */

const TYPE_COLORS: Record<string, string> = {
  kick: '#f97316',
  snare: '#fbbf24',
  clap: '#f43f5e',
  hat: '#22d3ee',
  tom: '#a78bfa',
  perc: '#34d399',
};

const EMPTY_16 = (): boolean[] => Array(16).fill(false);

interface DrumMachineProps {
  isPlaying?: boolean;
  currentStep?: number;
  bpm?: number;
}

export const DrumMachineTerminal: React.FC<DrumMachineProps> = React.memo(({ isPlaying = false, bpm = 128 }) => {
  const { addSample, pendingSample, setPendingSample } = useSamples();
  const { state, lockStatus, updateState } = usePluginState('drum', 'PRO');
  const lockedByOther = lockStatus.active && lockStatus.lockedBy !== 'localUser';

  const [activeKit, setActiveKit] = useState('tr-808');
  const [selectedSoundId, setSelectedSoundId] = useState<string>(DRUM_KITS[0]?.sounds[0]?.id ?? '');
  const [patterns, setPatterns] = useState<Record<string, boolean[]>>({});
  const [stepSamples, setStepSamples] = useState<Record<string, Record<number, AudioSample>>>({});
  const [flashId, setFlashId] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  // NEW-MONK-1: 16/32 Steps, Pattern-Bank A/B + Chain, Flam/Roll, Swing.
  const [stepCount, setStepCount] = useState<16 | 32>(16);
  const [bank, setBank] = useState<'A' | 'B'>('A');
  const [chain, setChain] = useState(false);
  const [flam, setFlam] = useState(false);
  const [roll, setRoll] = useState(false);
  const [swing, setSwing] = useState(0);
  const lastStepRef = useRef(-1);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Eigener Step-Subscriber (Mehrfach-Listener statt Single-Slot): Das Terminal
  // aktualisiert seinen Step unabhängig vom App-Shell-Render (UI-Performance).
  useEffect(() => audioEngine.addStepListener(setCurrentStep), []);

  const activeDrumKit = DRUM_KITS.find((k) => k.id === activeKit) ?? DRUM_KITS[0];
  const selectedSound = activeDrumKit.sounds.find((s) => s.id === selectedSoundId) ?? activeDrumKit.sounds[0];
  const emptyPattern = useCallback(() => Array(stepCount).fill(false), [stepCount]);
  const patternKey = useCallback((soundId: string) => `${bank}:${activeKit}:${soundId}`, [activeKit, bank]);
  const selectedPattern = patterns[patternKey(selectedSound?.id ?? '')] ?? emptyPattern();
  const selectedSamples = stepSamples[patternKey(selectedSound?.id ?? '')] ?? {};

  // Persistenz laden.
  useEffect(() => {
    try {
      const parsed = storageGetJson<{ kit?: string; patterns?: Record<string, boolean[]>; stepSamples?: Record<string, Record<number, AudioSample>> }>('drum-state');
      if (parsed) {
        if (parsed.kit && DRUM_KITS.some((k) => k.id === parsed.kit)) {
          setActiveKit(parsed.kit);
          audioEngine.setDrumKit(parsed.kit);
          const kit = DRUM_KITS.find((k) => k.id === parsed.kit)!;
          setSelectedSoundId(kit.sounds[0]?.id ?? '');
        }
        if (parsed.patterns) setPatterns(parsed.patterns);
        if (parsed.stepSamples) setStepSamples(parsed.stepSamples);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persistenz speichern.
  useEffect(() => {
    // NOSONAR: lokaler, JSON-serialisierter App-State; wird nicht als HTML gerendert
    storageSetJson('drum-state', { kit: activeKit, patterns, stepSamples });
  }, [activeKit, patterns, stepSamples]);

  // MOA-Kommando: sichtbare Zufalls-Patterns für das aktive Kit.
  useEffect(() => {
    const onRandom = () => {
      setPatterns((prev) => {
        const next = { ...prev };
        for (const sound of activeDrumKit.sounds) {
          next[patternKey(sound.id)] = Array.from({ length: stepCount }, () => random() < 0.5);
        }
        return next;
      });
    };
    window.addEventListener('monk:drum-pattern-random', onRandom);
    return () => window.removeEventListener('monk:drum-pattern-random', onRandom);
  }, [activeDrumKit, patternKey]);

  const handleKitChange = useCallback((kitId: string) => {
    setActiveKit(kitId);
    audioEngine.setDrumKit(kitId);
    const kit = DRUM_KITS.find((k) => k.id === kitId);
    setSelectedSoundId(kit?.sounds[0]?.id ?? '');
  }, []);

  const playStepSample = useCallback((sample: AudioSample) => {
    if (sample.url) {
      // F4-Fix: Peer-gesteuerte URLs nur nach Allowlist laden.
      if (!isTrustedMediaUrl(sample.url)) return;
      try {
        const a = new Audio(sample.url);
        a.volume = 0.9;
        void a.play();
        return;
      } catch { /* Fallback unten */ }
    }
    const t = sample.type.toLowerCase();
    const match = activeDrumKit.sounds.find((s) => t.includes(s.type) || s.type.includes(t));
    if (match) void audioEngine.triggerDrumSound(activeDrumKit.id, match.id, 1);
  }, [activeDrumKit]);

  // Transport: aktive Steps am Step-Edge triggern (16/32 Steps, A/B-Chain, Flam/Roll).
  useEffect(() => {
    if (!isPlaying) {
      lastStepRef.current = -1;
      return;
    }
    const step = currentStep % stepCount;
    if (step === lastStepRef.current) return;
    lastStepRef.current = step;

    const playBank = chain ? (Math.floor(currentStep / 16) % 2 === 0 ? 'A' : 'B') : bank;
    const accent = step % 4 === 0 ? 1 : 0.72;
    const trigger = (soundId: string, velocity: number) => {
      void audioEngine.triggerDrumSound(activeKit, soundId, velocity);
      if (flam) setTimeout(() => void audioEngine.triggerDrumSound(activeKit, soundId, velocity * 0.6), 30);
      if (roll) [40, 80].forEach((ms) => setTimeout(() => void audioEngine.triggerDrumSound(activeKit, soundId, velocity * 0.5), ms));
    };
    activeDrumKit.sounds.forEach((s) => {
      const key = `${playBank}:${activeKit}:${s.id}`;
      if (!patterns[key]?.[step]) return;
      const sample = stepSamples[key]?.[step];
      if (sample) playStepSample(sample);
      else trigger(s.id, accent);
    });
  }, [isPlaying, currentStep, patterns, stepSamples, activeKit, activeDrumKit, playStepSample, stepCount, bank, chain, flam, roll]);

  const flash = (id: string) => {
    setFlashId(id);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashId(null), 160);
  };

  const handlePad = (s: { id: string }) => {
    if (lockedByOther) return;
    setSelectedSoundId(s.id);
    flash(s.id);
    void audioEngine.triggerDrumSound(activeDrumKit.id, s.id, 1);
  };

  const toggleStep = (step: number) => {
    if (lockedByOther) return;
    const key = patternKey(selectedSound?.id ?? '');
    setPatterns((prev) => {
      const arr = prev[key] ? [...prev[key]] : emptyPattern();
      arr[step] = !arr[step];
      return { ...prev, [key]: arr };
    });
  };

  const handleSampleDrop = useCallback((sample: AudioSample, step: number) => {
    if (lockedByOther) return;
    const key = patternKey(selectedSound?.id ?? '');
    setStepSamples((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [step]: sample } }));
    setPatterns((prev) => {
      const arr = prev[key] ? [...prev[key]] : emptyPattern();
      arr[step] = true;
      return { ...prev, [key]: arr };
    });
  }, [lockedByOther, patternKey, selectedSound, emptyPattern]);

  const clearSelected = () => {
    const key = patternKey(selectedSound?.id ?? '');
    setPatterns((prev) => ({ ...prev, [key]: emptyPattern() }));
    setStepSamples((prev) => ({ ...prev, [key]: {} }));
  };

  const applyPatternPreset = (preset: 'FOUR' | 'OFF' | 'FILL' | 'RANDOM') => {
    const arr = emptyPattern();
    const total = stepCount;
    if (preset === 'FOUR') { for (let i = 0; i < total; i += 4) arr[i] = true; }
    if (preset === 'OFF') { for (let i = 2; i < total; i += 4) arr[i] = true; }
    if (preset === 'FILL') arr.fill(true);
    if (preset === 'RANDOM') { for (let i = 0; i < total; i++) arr[i] = random() < 0.4; }
    const key = patternKey(selectedSound?.id ?? '');
    setPatterns((prev) => ({ ...prev, [key]: arr }));
  };

  const activeSteps = useMemo(() => selectedPattern.filter(Boolean).length, [selectedPattern]);
  const soundColor = TYPE_COLORS[selectedSound?.type ?? 'perc'] ?? '#34d399';

  return (
    <SampleModuleWrapper onSelect={addSample}>
      <div className={`drum-machine-ui p-4 short-landscape:p-2 rounded-xl border-2 border-black/80 bg-gradient-to-b from-[#2a2a2e] via-[#202024] to-[#17171a] text-white shadow-[0_15px_35px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.05)] ${lockedByOther ? 'opacity-50 grayscale' : ''}`}>
        <MoaAssistant pluginId="drum" placeholder="MOA: z. B. 'Kit auf 909, Pattern random'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
        {/* Kopfzeile */}
        <div className="flex justify-between items-center mb-3 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-black uppercase tracking-[0.2em] text-neutral-200">
              drum<span className="text-emerald-400">MONK</span>
            </h3>
            <span className="text-[9px] font-mono text-emerald-400 border border-emerald-500/40 px-1.5 py-0.5 rounded-sm tracking-widest">TR-8S</span>
            <span className="text-[8px] font-mono text-neutral-500 border border-neutral-700 px-1.5 py-0.5 rounded-sm hidden sm:inline">STEP SEQ · BUFFER SOURCE</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[9px] font-mono tracking-widest px-2 py-1 rounded border ${isPlaying ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-neutral-500 border-neutral-700'}`}>
              {isPlaying ? `RUN · STEP ${currentStep % stepCount + 1}/${stepCount}` : `STOP · ${bpm} BPM`}
            </span>
            <select value={state} onChange={(e) => updateState(e.target.value as any)} disabled={lockedByOther} className="bg-black text-emerald-300 text-xs p-1 rounded border border-neutral-700 cursor-pointer">
              <option value="OFF">OFF</option>
              <option value="AUTO_AI">AI</option>
              <option value="PRO">ACTIVE</option>
            </select>
          </div>
        </div>

        {/* Grünes LED-Display */}
        <div className="mb-3 rounded-md bg-[#06140a] border border-emerald-900/70 px-3 py-2 flex items-center justify-between font-mono shadow-[inset_0_0_12px_rgba(16,185,129,0.15)]">
          <span className="text-[11px] font-bold text-emerald-400 tracking-widest" style={{ textShadow: '0 0 8px rgba(16,185,129,0.8)' }}>
            {selectedSound ? `${activeDrumKit.name} · ${selectedSound.name}` : activeDrumKit.name}
          </span>
          <span className="text-[9px] text-emerald-600 tracking-widest">
            {activeDrumKit.origin} · {activeDrumKit.year} · {activeDrumKit.sounds.length} SOUNDS
          </span>
        </div>

        {/* Kit-Auswahl */}
        <div className="flex gap-1.5 mb-3 overflow-x-auto touch-scroll pb-1">
          {DRUM_KITS.map((kit) => (
            <button type="button"
              key={kit.id}
              onClick={() => handleKitChange(kit.id)}
              disabled={lockedByOther}
              className={`px-3 py-1.5 rounded-[3px] text-[10px] font-black tracking-widest whitespace-nowrap border transition-all cursor-pointer disabled:opacity-40 ${
                activeKit === kit.id
                  ? 'bg-emerald-500 text-black border-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.6)]'
                  : 'bg-[#111] text-neutral-500 border-neutral-800 hover:border-emerald-600/60 hover:text-emerald-300'
              }`}
            >
              {kit.name}
            </button>
          ))}
        </div>

        {/* Instrument-Pads (wählen = Step-Spur editieren) */}
        <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))' }}>
          {activeDrumKit.sounds.map((s) => {
            const color = TYPE_COLORS[s.type] ?? '#34d399';
            const selected = selectedSound?.id === s.id;
            const padPattern = patterns[patternKey(s.id)] ?? emptyPattern();
            const stepsCount = padPattern.filter(Boolean).length;
            return (
              <button type="button"
                key={s.id}
                onClick={() => handlePad(s)}
                disabled={lockedByOther}
                title={`${s.name} (${s.type}) – Steps: ${stepsCount}/${stepCount}`}
                className={`aspect-square rounded-[4px] border flex flex-col items-center justify-center gap-1 transition-all duration-75 active:scale-95 cursor-pointer disabled:opacity-40 shadow-[0_3px_8px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.12)] ${
                  selected ? 'border-white ring-2 ring-white/70' : 'border-black/80'
                } ${flashId === s.id ? 'brightness-150' : ''}`}
                style={{ background: `linear-gradient(180deg, ${color}cc, ${color}66 55%, #0c0c0e 56%)` }}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                <span className="text-[8px] font-black tracking-wider text-white uppercase" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}>
                  {s.name.length > 10 ? s.name.slice(0, 10) : s.name}
                </span>
                <span className="text-[6px] font-mono text-black/70 uppercase tracking-widest">{s.type}</span>
                <span className="text-[7px] font-mono text-black/80 font-bold">{stepsCount}/{stepCount}</span>
              </button>
            );
          })}
        </div>

        {/* Pattern-Tools für den gewählten Sound */}
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          <span className="text-[8px] font-mono tracking-[0.25em] text-emerald-500 mr-1">PATTERN · {selectedSound?.name ?? ''}</span>
          {(['FOUR', 'OFF', 'FILL', 'RANDOM'] as const).map((p) => (
            <button type="button"
              key={p}
              onClick={() => applyPatternPreset(p)}
              disabled={lockedByOther}
              className="px-2 py-1 rounded-[3px] bg-[#111] border border-neutral-800 text-[8px] font-bold tracking-widest text-neutral-400 hover:text-emerald-300 hover:border-emerald-600/60 cursor-pointer disabled:opacity-40"
            >
              {p}
            </button>
          ))}
          <button type="button"
            onClick={clearSelected}
            disabled={lockedByOther}
            className="px-2 py-1 rounded-[3px] bg-[#111] border border-neutral-800 text-[8px] font-bold tracking-widest text-red-400/80 hover:text-red-300 hover:border-red-500/60 cursor-pointer disabled:opacity-40"
          >
            CLEAR
          </button>
          {(['A', 'B'] as const).map((b) => (
            <button type="button" key={b} onClick={() => setBank(b)} disabled={lockedByOther}
              className={`px-2 py-1 rounded-[3px] border text-[8px] font-bold tracking-widest cursor-pointer disabled:opacity-40 ${bank === b ? 'bg-emerald-500 text-black border-emerald-300' : 'bg-[#111] border-neutral-800 text-neutral-400'}`}>
              {b}
            </button>
          ))}
          <button type="button" onClick={() => setChain(!chain)} disabled={lockedByOther}
            className={`px-2 py-1 rounded-[3px] border text-[8px] font-bold tracking-widest cursor-pointer disabled:opacity-40 ${chain ? 'bg-emerald-500 text-black border-emerald-300' : 'bg-[#111] border-neutral-800 text-neutral-400'}`}>
            CHAIN
          </button>
          {([16, 32] as const).map((n) => (
            <button type="button" key={n} onClick={() => setStepCount(n)} disabled={lockedByOther}
              className={`px-2 py-1 rounded-[3px] border text-[8px] font-bold tracking-widest cursor-pointer disabled:opacity-40 ${stepCount === n ? 'bg-emerald-500 text-black border-emerald-300' : 'bg-[#111] border-neutral-800 text-neutral-400'}`}>
              {n}
            </button>
          ))}
          <button type="button" onClick={() => setFlam(!flam)} disabled={lockedByOther}
            className={`px-2 py-1 rounded-[3px] border text-[8px] font-bold tracking-widest cursor-pointer disabled:opacity-40 ${flam ? 'bg-amber-500 text-black border-amber-300' : 'bg-[#111] border-neutral-800 text-neutral-400'}`}>
            FLAM
          </button>
          <button type="button" onClick={() => setRoll(!roll)} disabled={lockedByOther}
            className={`px-2 py-1 rounded-[3px] border text-[8px] font-bold tracking-widest cursor-pointer disabled:opacity-40 ${roll ? 'bg-amber-500 text-black border-amber-300' : 'bg-[#111] border-neutral-800 text-neutral-400'}`}>
            ROLL
          </button>
          <div className="flex items-center gap-1">
            <span className="text-[8px] font-mono text-neutral-600">SWING</span>
            <input type="range" min={0} max={100} value={Math.round(swing * 100)}
              onChange={(e) => { const v = Number(e.target.value) / 100; setSwing(v); audioEngine.setSwing(v); }}
              className="w-16 accent-emerald-500" />
          </div>
          <span className="ml-auto text-[8px] font-mono text-neutral-600">{activeSteps}/{stepCount} STEPS · DOWNBEAT = ACCENT</span>
        </div>

        {/* 16 Step-Pads (TR-8S: 2×8) */}
        <div className="rounded-md bg-black/40 border border-neutral-800 p-2">
          <div className="flex items-center justify-between mb-1.5 px-1">
            <span className="text-[8px] font-mono tracking-[0.25em] text-emerald-500">STEP SEQUENCER · {stepCount} STEPS</span>
            <span className="text-[8px] font-mono text-neutral-600">SAMPLE-DROP AUF STEP = ONE-SHOT</span>
          </div>
          <div className={`grid gap-1.5 ${stepCount === 16 ? 'grid-cols-8' : 'grid-cols-8'}`}>
            {[...Array(stepCount)].map((_, i) => {
              const isOn = selectedPattern[i] ?? false;
              const sample = selectedSamples[i];
              const isCurrent = isPlaying && (currentStep % stepCount) === i;
              return (
                <DropTarget
                  key={i}
                  onDrop={(sample) => handleSampleDrop(sample, i)}
                  className={`h-9 short-landscape:h-7 rounded-[3px] border flex items-center justify-center px-1 text-[7px] font-mono transition-all cursor-pointer ${
                    isOn
                      ? 'bg-black border-neutral-600 text-neutral-200'
                      : 'bg-[#0d0d0f] border-neutral-800 text-neutral-600 hover:border-emerald-600/60'
                  } ${isCurrent ? 'ring-2 ring-white/80 animate-pulse' : ''}`}
                >
                  <button type="button"
                    onClick={() => {
                      // Touch-Fallback: armiertes Sample hat Vorrang vor Step-Toggle.
                      if (pendingSample) {
                        handleSampleDrop(pendingSample, i);
                        setPendingSample(null);
                      } else {
                        toggleStep(i);
                      }
                    }}
                    disabled={lockedByOther}
                    className="w-full h-full relative flex items-center justify-center cursor-pointer disabled:cursor-not-allowed"
                    aria-label={`Step ${i + 1} ${isOn ? 'aus' : 'an'}`}
                  >
                    <span
                      className="absolute left-1 top-1 w-1.5 h-1.5 rounded-full"
                      style={{
                        background: isOn ? (sample ? '#fbbf24' : soundColor) : '#27272a',
                        boxShadow: isOn ? `0 0 6px ${sample ? '#fbbf24' : soundColor}` : 'none',
                      }}
                    />
                    <span className="truncate w-full text-center">
                      {sample ? sample.name.slice(0, 6) : `${i + 1}`}
                    </span>
                  </button>
                </DropTarget>
              );
            })}
          </div>
        </div>

        <p className="mt-2 text-[8px] font-mono text-neutral-600 leading-relaxed">
          Instrument-Pad wählen → Steps klicken zum Schalten · Sample aus der Library auf einen Step ziehen = One-Shot · Läuft synchron zum Master-Transport.
        </p>
      </div>
    </SampleModuleWrapper>
  );
});
