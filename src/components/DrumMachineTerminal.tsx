import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { random } from '../utils/random';
import { useSamples } from '../context/SampleContext';
import { DropTarget } from './DropTarget';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { isTrustedMediaUrl } from '../utils/mediaUrlGuard';
import { readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { SampleModuleWrapper } from './SampleModuleWrapper';
import { MoaAssistant } from './MoaAssistant';
import { DRUM_KITS } from '../data/drumKits';
import { useMIDI } from '../hooks/useMIDI';
import { useMidiClockOut } from '../hooks/useMidiClockOut';
import { drumNoteFor } from '../core/hardware/midiClockOut';
import { webRTCManager } from '../utils/WebRTCManager';
import { AmCard, AmKnob, AmSeg, AmToggle } from './am/amUi';

/**
 * audioMONASTRY drumsamplerMONK – Rack-Modul (Vorlage uiübersichtapp, Zeile 06)
 * + echter 16-Step-Sequencer im TR-808-Farbschema.
 * ---------------------------------------------------------------
 * - Instrument-Pad wählen → dessen 16 Steps im TR-8S-Layout editieren
 * - Steps triggern beim globalen Transport (isPlaying/currentStep)
 * - Akzente: Downbeats (1/5/9/13) mit voller Velocity, Rest 72 %
 * - Sample-Drop auf Step = One-Shot-Sample statt Kit-Sound
 * - Pattern-Presets (Four/Offbeat/Fill/Random), Clear, Persistenz
 */

/** TR-808: Step-Tasten in vier Farbgruppen (rot, orange, gelb, weiß). */
const TR808_STEP_COLORS = ['#ff4a2a', '#ff9524', '#ffd43b', '#efe8d8'] as const;

const TYPE_COLORS: Record<string, string> = {
  kick: '#f97316',
  snare: '#fbbf24',
  clap: '#f43f5e',
  hat: '#22d3ee',
  tom: '#a78bfa',
  perc: '#34d399',
};

interface DrumMachineProps {
  isPlaying?: boolean;
  currentStep?: number;
  bpm?: number;
}

export const DrumMachineTerminal: React.FC<DrumMachineProps> = React.memo(({ isPlaying = false, bpm = 128 }) => {
  const { addSample, pendingSample, setPendingSample, takeoverRequest, clearTakeoverRequest } = useSamples();
  const { state, lockStatus, updateState } = usePluginState('drumsampler', 'PRO');
  const lockedByOther = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;

  // Persistenz einmalig beim ersten Rendern laden – keine setState-Aufrufe im Effect.
  const [loadedDrumState] = useState(() => {
    try {
      const parsed = readPluginSettings<{ kit?: string; patterns?: Record<string, boolean[]>; stepSamples?: Record<string, Record<number, AudioSample>> }>('drumsampler', { legacyKey: 'drum-state' });
      if (parsed) {
        const kit = parsed.kit && DRUM_KITS.some((k) => k.id === parsed.kit) ? parsed.kit : 'tr-808';
        const kitDef = DRUM_KITS.find((k) => k.id === kit) ?? DRUM_KITS[0];
        return {
          kit,
          soundId: kitDef?.sounds[0]?.id ?? '',
          patterns: parsed.patterns ?? {},
          stepSamples: parsed.stepSamples ?? {},
        };
      }
    } catch { /* ignore */ }
    return { kit: 'tr-808', soundId: DRUM_KITS[0]?.sounds[0]?.id ?? '', patterns: {}, stepSamples: {} };
  });
  const [activeKit, setActiveKit] = useState(loadedDrumState.kit);
  const [selectedSoundId, setSelectedSoundId] = useState<string>(loadedDrumState.soundId);
  const [patterns, setPatterns] = useState<Record<string, boolean[]>>(loadedDrumState.patterns);
  const [stepSamples, setStepSamples] = useState<Record<string, Record<number, AudioSample>>>(loadedDrumState.stepSamples);
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

  // NEW-MONK-1: MIDI-Out/Clock an externe Hardware (24 PPQN + Note-Out).
  const { outputs } = useMIDI();
  const midiOut = useMidiClockOut(outputs);

  // Eigener Step-Subscriber (Mehrfach-Listener statt Single-Slot): Das Terminal
  // aktualisiert seinen Step unabhängig vom App-Shell-Render (UI-Performance).
  useEffect(() => audioEngine.addStepListener(setCurrentStep), []);

  const activeDrumKit = DRUM_KITS.find((k) => k.id === activeKit) ?? DRUM_KITS[0];
  const selectedSound = activeDrumKit.sounds.find((s) => s.id === selectedSoundId) ?? activeDrumKit.sounds[0];
  const emptyPattern = useCallback(() => Array(stepCount).fill(false), [stepCount]);
  const patternKey = useCallback((soundId: string) => `${bank}:${activeKit}:${soundId}`, [activeKit, bank]);
  const selectedPattern = patterns[patternKey(selectedSound?.id ?? '')] ?? emptyPattern();
  const selectedSamples = stepSamples[patternKey(selectedSound?.id ?? '')] ?? {};

  // Geladenes Kit genau einmal an die Engine pushen (Side-Effekt, kein setState).
  const didInitKitRef = useRef(false);
  useEffect(() => {
    if (didInitKitRef.current) return;
    didInitKitRef.current = true;
    audioEngine.setDrumKit(activeKit);
  }, [activeKit]);

  // Persistenz speichern.
  useEffect(() => {
    // NOSONAR: lokaler, JSON-serialisierter App-State; wird nicht als HTML gerendert
    // Beständige Plugins: Stand an die Session (der nächste Halter startet damit).
    writePluginSettings('drumsampler', { kit: activeKit, patterns, stepSamples });
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
  }, [activeDrumKit, patternKey, stepCount]);

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
      midiOut.clockOut.stop();
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
    // NEW-MONK-1: Noten dieses Steps für die Hardware sammeln (GM-Percussion).
    const midiNotes: Array<{ note: number; velocity: number }> = [];
    activeDrumKit.sounds.forEach((s) => {
      const key = `${playBank}:${activeKit}:${s.id}`;
      if (!patterns[key]?.[step]) return;
      const sample = stepSamples[key]?.[step];
      if (sample) playStepSample(sample);
      else trigger(s.id, accent);
      midiNotes.push({ note: drumNoteFor(s.id, s.type), velocity: accent });
    });

    // Hardware-Sync: Clock (6 Pulse/Step) + Note-Out am selben Step-Raster.
    const now = performance.now();
    midiOut.clockOut.setBpm(bpm);
    if (!midiOut.clockOut.isRunning()) midiOut.clockOut.start(step, now);
    midiOut.clockOut.emitStep({ notes: midiNotes, timestampMs: now, bpm });
  }, [isPlaying, currentStep, patterns, stepSamples, activeKit, activeDrumKit, playStepSample, stepCount, bank, chain, flam, roll, bpm, midiOut.clockOut]);

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

  // Einheitliche Action-Menu-Übernahme: Sample auf den nächsten freien Step
  // des gewählten Sounds legen (bestehender One-Shot-Drop-Pfad).
  useEffect(() => {
    if (!takeoverRequest || takeoverRequest.pluginId !== 'drum') return;
    const key = patternKey(selectedSound?.id ?? '');
    const arr = patterns[key] ?? emptyPattern();
    const step = arr.findIndex((on) => !on);
    // Asynchron anwenden: kein synchroner setState-Aufruf im Effect-Body.
    if (step >= 0) void Promise.resolve().then(() => handleSampleDrop(takeoverRequest.sample, step));
    clearTakeoverRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeoverRequest]);

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

  const stepNow = currentStep % stepCount;
  const tune = selectedSound?.freqStart ?? selectedSound?.freq;

  return (
    <div className={`am-rackrow ${lockedByOther ? 'am-c-locked' : ''}`}>
      <MoaAssistant pluginId="drum" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />

      {/* Kit-/Modell-Auswahl (TR-808, TR-909, …) + Sample-Suche + MIDI-Out */}
      <AmCard title="Kit" style={{ width: 236 }} right={<span className="am-vb">{activeDrumKit.origin} · {activeDrumKit.year}</span>}>
        <select className="am-sel" aria-label="Drum-Kit (Modell)" value={activeKit} disabled={lockedByOther}
          onChange={(e) => handleKitChange(e.target.value)}>
          {DRUM_KITS.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}</option>)}
        </select>
        <SampleModuleWrapper onSelect={addSample} />
        <div className="am-c-row">
          {/* NEW-MONK-1: MIDI-Out/Clock an externe Hardware (24 PPQN). */}
          <AmToggle on={midiOut.enabled} kind="m" onClick={() => midiOut.setEnabled(!midiOut.enabled)}
            disabled={lockedByOther || !midiOut.connected}
            title={midiOut.connected ? 'MIDI-Clock (24 PPQN) + Note-Out an Hardware senden' : 'Kein MIDI-Ausgang gefunden'}>
            MIDI OUT {midiOut.enabled ? 'ON' : 'OFF'}
          </AmToggle>
          {midiOut.ports.length > 1 && (
            <select
              className="am-sel am-c-grow"
              value={midiOut.portId}
              onChange={(e) => midiOut.selectPort(e.target.value)}
              disabled={lockedByOther}
              title="MIDI-Ausgabeport"
              aria-label="MIDI-Ausgabeport"
            >
              <option value="">AUTO</option>
              {midiOut.ports.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
        </div>
      </AmCard>

      {/* Instrument-Spuren als farbige Kacheln (wählen = Step-Spur editieren) */}
      <AmCard title={`Instrumente · ${activeDrumKit.name}`} style={{ flex: 1, minWidth: 420 }}
        right={<span className="am-c-stat">{activeDrumKit.sounds.length} SOUNDS</span>}>
        <div className="am-c-tiles">
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
                aria-pressed={selected}
                title={`${s.name} (${s.type}) – Steps: ${stepsCount}/${stepCount}`}
                className={`am-c-tile ${selected ? 'am-c-sel' : ''} ${flashId === s.id ? 'am-hit' : ''}`}
                style={{ ['--pc' as string]: color }}
              >
                <b>{s.name}</b>
                <small>{s.type} · {stepsCount}/{stepCount}</small>
              </button>
            );
          })}
        </div>
      </AmCard>

      {/* Gewählter Sound: Kit-Werte (fest, aus dem Modell) + Groove */}
      <AmCard title={selectedSound ? selectedSound.name : 'Sound'} style={{ width: 236 }}
        right={<span className="am-c-stat" data-live-value="transport">{isPlaying ? `RUN ${stepNow + 1}/${stepCount}` : `STOP · ${bpm}`}</span>}>
        <div className="am-c-kv" title="Werte des Original-Modells (Kit-Preset)">
          <div><b>{tune !== undefined ? `${Math.round(tune)}` : '–'}</b><span>Tune Hz</span></div>
          <div><b>{selectedSound?.decay !== undefined ? `${Math.round(selectedSound.decay * 1000)}` : '–'}</b><span>Decay ms</span></div>
          <div><b>{selectedSound?.noiseFilter !== undefined ? `${(selectedSound.noiseFilter / 1000).toFixed(1)}k` : '–'}</b><span>Filter</span></div>
        </div>
        <div className="am-c-row" style={{ flexWrap: 'nowrap' }}>
          <AmKnob size="s" value={swing} min={0} max={1} def={0} unit="pct" label="Swing" title="Swing (systemweit)"
            onChange={(v) => { const n = Math.round(v * 100) / 100; setSwing(n); audioEngine.setSwing(n); }} />
          <AmToggle on={flam} kind="m" disabled={lockedByOther} onClick={() => setFlam(!flam)} title="Flam: zweiter Schlag nach 30 ms">FLAM</AmToggle>
          <AmToggle on={roll} kind="m" disabled={lockedByOther} onClick={() => setRoll(!roll)} title="Roll: zwei Nachschläge">ROLL</AmToggle>
        </div>
      </AmCard>

      {/* 16-Step-Raster im TR-808-Farbschema (Steps 1–4 rot, 5–8 orange, 9–12 gelb, 13–16 weiß) */}
      <AmCard title={`Step-Sequenzer · ${selectedSound?.name ?? ''}`} style={{ flexBasis: '100%' }}
        right={<span className="am-c-stat">{activeSteps}/{stepCount} STEPS · DOWNBEAT = AKZENT · SAMPLE AUF STEP = ONE-SHOT</span>}>
        <div className="am-c-row">
          {(['FOUR', 'OFF', 'FILL', 'RANDOM'] as const).map((p) => (
            <button type="button" key={p} className="am-tg" onClick={() => applyPatternPreset(p)} disabled={lockedByOther}>{p}</button>
          ))}
          <button type="button" className="am-tg am-m" onClick={clearSelected} disabled={lockedByOther} title="Spur leeren">CLEAR</button>
          <span className="am-lbl" style={{ marginLeft: 6 }}>Bank</span>
          <AmSeg<'A' | 'B'> label="Pattern-Bank" value={bank} onChange={setBank} disabled={lockedByOther} options={[['A', 'A'], ['B', 'B']]} />
          <AmToggle on={chain} disabled={lockedByOther} onClick={() => setChain(!chain)} title="A → B im Wechsel spielen">CHAIN</AmToggle>
          <AmSeg label="Steps" value={String(stepCount) as '16' | '32'} disabled={lockedByOther}
            onChange={(v) => setStepCount(v === '32' ? 32 : 16)} options={[['16', '16'], ['32', '32']]} />
        </div>
        <div className="am-c-drumseq am-c-st">
          {[...Array(stepCount)].map((_, i) => {
            const isOn = selectedPattern[i] ?? false;
            const sample = selectedSamples[i];
            const isCurrent = isPlaying && stepNow === i;
            return (
              <DropTarget
                key={i}
                onDrop={(sample) => handleSampleDrop(sample, i)}
                className="am-c-dstep"
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
                  className={`am-stp ${isOn ? 'am-v2' : ''} ${isCurrent ? 'am-ph' : ''}`}
                  style={{ ['--c' as string]: TR808_STEP_COLORS[Math.floor((i % 16) / 4)] }}
                  title={sample ? `Step ${i + 1}: ${sample.name}` : `Step ${i + 1}`}
                  aria-label={`Step ${i + 1} ${isOn ? 'aus' : 'an'}`}
                >
                  {sample && <i />}
                  {sample ? sample.name.slice(0, 6) : `${i + 1}`}
                </button>
              </DropTarget>
            );
          })}
        </div>
      </AmCard>
    </div>
  );
});
