import React, { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { TrackType, TrackPreset, Patterns } from '../types';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { SampleModuleWrapper } from './SampleModuleWrapper';
import { MoaAssistant } from './MoaAssistant';

interface SequencerProps {
  isPlaying: boolean;
  currentStep?: number;
  tracks: TrackPreset['patterns'];
  bpm: number;
  setBpm: (b: number) => void;
  stepCount?: 16 | 32;
  onSetStepCount?: (n: 16 | 32) => void;
  onPlay: () => void;
  onStop: () => void;
  onToggleStep: (track: TrackType, stepIndex: number) => void;
  /** Wendet komplette Patterns + BPM an (KI-Komposition). */
  onApplyPatterns?: (patterns: Patterns, bpm: number) => void;
}

export const SequencerPluginTerminal = React.memo(function SequencerPluginTerminal(props: SequencerProps) {
  const { setSelectedSample, pendingSample, setPendingSample } = useSamples();
  const { state, lockStatus, updateState } = usePluginState('sequencer', 'PRO');
  const [currentStep, setCurrentStep] = useState(0);
  const channels: TrackType[] = ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'];
  const [trackSamples, setTrackSamples] = useState<Record<string, AudioSample | null>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const lockedByOther = lockStatus.active && lockStatus.lockedBy !== 'localUser';

  /** KI-Pattern über den Server-Endpunkt /api/ai/compose anfordern und anwenden. */
  const handleAiCompose = async () => {
    setAiBusy(true);
    try {
      const resp = await fetch('/api/ai/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Dark warehouse techno' }),
      });
      const data = (await resp.json().catch(() => null)) as {
        patterns?: Record<string, boolean[]>;
        bpm?: number;
      } | null;
      if (!data?.patterns) return;
      const roleToTrack: Record<string, TrackType> = {
        kick: 'channel1',
        hat: 'channel2',
        clap: 'channel3',
        synth: 'channel4',
      };
      const next: Patterns = { ...props.tracks };
      for (const [role, steps] of Object.entries(data.patterns)) {
        const track = roleToTrack[role];
        if (track && Array.isArray(steps)) next[track] = steps as boolean[];
      }
      const nextBpm = Number(data.bpm) || props.bpm;
      props.onApplyPatterns?.(next, nextBpm);
    } finally {
      setAiBusy(false);
    }
  };

  useEffect(() => {
    audioEngine.onStepUpdate = (step) => {
        setCurrentStep(step);
    };
    return () => {
        audioEngine.onStepUpdate = () => {};
    };
  }, []);

  const handleDrop = (e: React.DragEvent, track: TrackType) => {
    e.preventDefault();
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      setTrackSamples(prev => ({ ...prev, [track]: data }));
      setSelectedSample(data);
      setPendingSample(null);
    } catch (err) {
      console.error("Invalid sample dropped", err);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  /** Touch-Fallback: armiertes Sample per Tippen auf die Spur setzen. */
  const placePendingSample = (track: TrackType) => {
    if (!pendingSample) return;
    setTrackSamples(prev => ({ ...prev, [track]: pendingSample }));
    setSelectedSample(pendingSample);
    setPendingSample(null);
  };

  return (
    <SampleModuleWrapper onSelect={setSelectedSample}>
        <section className={`bg-[#050508] p-5 short-landscape:p-3 rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800/80'} shadow-xl flex flex-col gap-4 short-landscape:gap-2 ${lockedByOther ? 'opacity-50 grayscale' : ''}`}>

        {/* Taktmaschine Header */}
        <div className="flex justify-between items-center gap-2 flex-wrap border-b border-neutral-800 pb-4 short-landscape:pb-2">
            <h3 className="text-sm font-mono text-neutral-300 font-bold tracking-wider flex items-center gap-2">
            <Clock className="w-4 h-4 text-emerald-400" /> SEQUENCER MONK
            </h3>

            <div className="flex items-center gap-2 flex-wrap">
              <button type="button"
                onClick={props.onPlay}
                disabled={props.isPlaying || lockedByOther}
                className="px-3 py-1.5 rounded border border-emerald-500/50 bg-emerald-500/10 text-emerald-300 text-[9px] font-bold tracking-widest hover:bg-emerald-500/20 cursor-pointer disabled:opacity-40"
              >▶ PLAY</button>
              <button type="button"
                onClick={props.onStop}
                disabled={!props.isPlaying || lockedByOther}
                className="px-3 py-1.5 rounded border border-red-500/50 bg-red-500/10 text-red-300 text-[9px] font-bold tracking-widest hover:bg-red-500/20 cursor-pointer disabled:opacity-40"
              >■ STOP</button>
              <button type="button"
                onClick={handleAiCompose}
                disabled={aiBusy || lockedByOther}
                className="px-3 py-1.5 rounded border border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-300 text-[9px] font-bold tracking-widest hover:bg-fuchsia-500/20 cursor-pointer disabled:opacity-40"
              >{aiBusy ? 'KI…' : '◆ KI-PATTERN'}</button>

              <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
                  <option value="OFF">OFF</option>
                  <option value="AUTO_AI">AI</option>
                  <option value="PRO">ACTIVE</option>
              </select>

              <div className="flex gap-4 items-center">
                  <div className="flex items-center gap-1">
                      {([16, 32] as const).map((n) => (
                          <button type="button"
                              key={n}
                              onClick={() => props.onSetStepCount?.(n)}
                              className={`px-2 py-0.5 rounded border text-[9px] font-mono font-bold cursor-pointer transition-colors ${
                                  (props.stepCount ?? 16) === n
                                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                                      : 'border-neutral-800 bg-black/40 text-neutral-500 hover:border-emerald-500/40 hover:text-emerald-300'
                              }`}
                          >{n} STEPS</button>
                      ))}
                  </div>
                  <div className="flex items-center gap-2">
                      <span className="text-[9px] font-mono text-neutral-500 uppercase">BPM</span>
                      <input type="number" value={props.bpm} onChange={e => props.setBpm(Number(e.target.value))} className="w-16 bg-neutral-900 border border-neutral-800 rounded text-center text-sm" />
                  </div>
              </div>
            </div>
        </div>

        <MoaAssistant pluginId="sequencer" placeholder="MOA: z. B. 'Four-on-the-Floor mit Break'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />

        {/* Grid als reine Rhythmus-Matrix (horizontal scrollbar auf kleinen Screens) */}
        <div className="bg-[#0c0c0e] p-4 short-landscape:p-2 rounded-lg border border-neutral-800/50 overflow-x-auto">
            {channels.map((trackKey) => (
            <div
                key={trackKey}
                role="button"
                tabIndex={0}
                onClick={() => placePendingSample(trackKey)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); placePendingSample(trackKey); } }}
                className={`mb-4 short-landscape:mb-2 rounded ${pendingSample ? 'ring-1 ring-fuchsia-500/60 bg-fuchsia-500/5 cursor-pointer' : ''}`}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, trackKey)}
            >
                <div className="flex justify-between text-[9px] font-mono text-neutral-500 uppercase mb-1">
                    <span>{trackKey} : {trackSamples[trackKey]?.name || '...'}{pendingSample ? ' · tippen = Sample setzen' : ''}</span>
                </div>
                <div className="grid gap-1 min-w-max" style={{ gridTemplateColumns: `repeat(${props.stepCount ?? 16}, minmax(${(props.stepCount ?? 16) === 32 ? 30 : 38}px, 1fr))` }}>
                {props.tracks[trackKey as TrackType].map((isActive, colIndex) => (
                    <div key={colIndex} className="flex flex-col gap-1 items-center">
                        <button type="button"
                            onClick={() => props.onToggleStep(trackKey as TrackType, colIndex)}
                            disabled={lockedByOther}
                            className={`${(props.stepCount ?? 16) === 32 ? 'w-6 h-6 touch:w-9 touch:h-9' : 'w-8 h-8 touch:w-11 touch:h-11'} short-landscape:w-5 short-landscape:h-5 rounded-sm transition-all duration-75 ${isActive ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-neutral-900'} ${currentStep === colIndex && props.isPlaying ? 'ring-2 ring-white scale-110 shadow-[0_0_15px_rgba(255,255,255,0.7)]' : ''}`}
                        />
                    </div>
                ))}
                </div>
            </div>
            ))}
        </div>
        </section>
    </SampleModuleWrapper>
  );
});
