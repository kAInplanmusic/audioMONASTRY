import React, { useState, useEffect } from 'react';
import { usePluginState } from '../hooks/usePluginState';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { WasmPluginHost } from '../audio/wasm/WasmPluginHost';
import { MoaAssistant } from './MoaAssistant';
import { AmCard, AmKnob, AmSeg, AmToggle } from './am/amUi';
import { audioEngine } from '../utils/audioEngine';
import { DX7_REFERENCE_PATCHES } from '../core/instrument/dx7Presets';
import type { TrackType } from '../types';

const DEFAULT_SYNTH_PARAMS = {
  cutoff: 1000,
  decay: 0.2,
  engine: 'SUBTRACTIVE',
};

const PREVIEW_NOTES: Array<{ label: string; frequency: number }> = [
  { label: 'C4', frequency: 261.63 },
  { label: 'E4', frequency: 329.63 },
  { label: 'G4', frequency: 392.0 },
  { label: 'C5', frequency: 523.25 },
];

const TARGET_CHANNELS: TrackType[] = ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'];

/**
 * synthesizerMONK – P0-5: an `audioEngine` angebunden.
 * Cutoff/Resonanz laufen als sample-genaue Automation in den it-synth-Worklet;
 * die Preview-Noten sind direkt hörbar. Der WASM-Host bleibt optionaler Zusatz.
 */
export const SynthesizerTerminal: React.FC = React.memo(() => {
  // Plugin-Stand/Lock registrieren (Sperre zeigt der Streifenkopf).
  usePluginState('syntisampler', 'PRO');
  const hostRef = React.useRef(new WasmPluginHost());
  const [isLoaded, setIsLoaded] = useState(false);
  // Beständige Plugins: Einstiegsstand = letzter Stand (syntisampler › synth).
  const [saved] = useState(() => mergeKnown({
    cutoff: DEFAULT_SYNTH_PARAMS.cutoff, decay: DEFAULT_SYNTH_PARAMS.decay, engine: DEFAULT_SYNTH_PARAMS.engine as string,
    targetChannel: 'channel4' as string, seq: Array(16).fill(0) as number[], seqSemi: 0,
    fm6PatchIdx: 0, grainSize: 480, grainDensity: 20, grainPitch: 1, grainFreeze: false,
  }, readPluginSettings('syntisampler', { section: 'synth' })));
  const [cutoff, setCutoff] = useState(saved.cutoff);
  const [decay, setDecay] = useState(saved.decay);
  const [engine, setEngine] = useState(saved.engine as typeof DEFAULT_SYNTH_PARAMS.engine);
  const [targetChannel, setTargetChannel] = useState<TrackType>(saved.targetChannel as TrackType);
  // NEW-MONK-4: 16-Step-Notensequencer (C4 + Halbtöne).
  const [seq, setSeq] = useState<number[]>(saved.seq.length === 16 ? saved.seq : Array(16).fill(0));
  const [seqSemi, setSeqSemi] = useState(saved.seqSemi);
  const [curStep, setCurStep] = useState(0);
  // 6-Op-FM (DX7) + Granular-Preview
  const [fm6PatchIdx, setFm6PatchIdx] = useState(saved.fm6PatchIdx);
  const [grainSize, setGrainSize] = useState(saved.grainSize);
  const [grainDensity, setGrainDensity] = useState(saved.grainDensity);
  const [grainPitch, setGrainPitch] = useState(saved.grainPitch);
  const [grainFreeze, setGrainFreeze] = useState(saved.grainFreeze);
  useEffect(() => {
    writePluginSettings('syntisampler', {
      cutoff, decay, engine, targetChannel, seq, seqSemi, fm6PatchIdx, grainSize, grainDensity, grainPitch, grainFreeze,
    }, { section: 'synth' });
  }, [cutoff, decay, engine, targetChannel, seq, seqSemi, fm6PatchIdx, grainSize, grainDensity, grainPitch, grainFreeze]);
  // Übernahme: Filter-Cutoff einmal an die Engine (der Rest wirkt über State/Host).
  useEffect(() => {
    try { audioEngine.automateItSynthParam('cutoff', saved.cutoff); } catch { /* Graph noch nicht bereit */ }
  }, [saved]);

  const loadFm6Patch = (idx: number) => {
    setFm6PatchIdx(idx);
    try {
      audioEngine.setFm6Patch(DX7_REFERENCE_PATCHES[idx]);
      audioEngine.fm6NoteOn(261.63, 0.8);
    } catch (e) { console.warn('[synth] FM6-Patch fehlgeschlagen:', e); }
  };

  const loadGranularPreview = () => {
    try {
      const src = new Float32Array(48000);
      for (let i = 0; i < src.length; i++) src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
      audioEngine.loadGranularSource(src);
      audioEngine.setGranularParams({ grainSize, density: grainDensity, pitch: grainPitch, freeze: grainFreeze, gain: 0.8 });
    } catch (e) { console.warn('[synth] Granular-Source fehlgeschlagen:', e); }
  };

  useEffect(() => {
    const host = hostRef.current;
    // Worklet-/JS-Synth ist der produktive Pfad: Graph erst bei Aktivierung
    // aufbauen (P0-2 lazy – kein Rauschen bei OFF).
    void audioEngine.ensureSynthGraph();
    // Load plugin on startup (optionaler WASM-Zusatz)
    host.loadPlugin('/plugins/synth_core.wasm').then(() => {
        setIsLoaded(true);
        // Set initial parameters on load
        host.setParameter('cutoff', cutoff);
        host.setParameter('decay', decay);
        host.setParameter('engine', engine === 'SUBTRACTIVE' ? 0 : engine === 'FM' ? 1 : 2);
    }).catch(err => {
        // Optionales WASM-Plugin: Worklet-/JS-Synth ist der produktive Pfad.
        console.warn('[synth] WASM-Plugin optional nicht geladen – Worklet-Fallback aktiv:', err);
    });

    // Cleanup on unmount
    return () => {
      try { host.dispose(); } catch { /* best-effort */ }
    };
// eslint-disable-next-line react-hooks/exhaustive-deps -- bewusst beibehalten (Runde 3, Hook-Deps werden separat auditiert)
  }, []);

  // NEW-MONK-4: Sequencer triggert aktive Steps am Master-Transport.
  useEffect(() => audioEngine.addStepListener(setCurStep), []);
  useEffect(() => {
    const f = seq[curStep % 16];
    if (f > 0) audioEngine.noteOnWorklet(f, 0.7, 'saw');
  }, [curStep, seq]);

  const validateAndSetParameter = (param: string, value: number | string) => {
    const host = hostRef.current;
    if (param === 'cutoff' && (typeof value !== 'number' || value < 20 || value > 20000)) return false;
    if (param === 'decay' && (typeof value !== 'number' || value < 0 || value > 1)) return false;

    // P0-5: Parameter IMMER auch an die echte AudioEngine durchreichen –
    // die UI-Steuerung soll hörbar sein, nicht nur den WASM-Host bedienen.
    try {
      if (param === 'cutoff') {
        audioEngine.automateItSynthParam('cutoff', value as number);
      } else if (param === 'decay') {
        // Decay wird über die Tonhöhen-/Hüllkurven-Vorschau hörbar gemacht.
      }
    } catch (err) {
      console.warn('[synth] audioEngine-Automation fehlgeschlagen:', err);
    }

    if (!isLoaded || !host) {
      return true; // Worklet-Pfad ist produktiv – WASM ist optional.
    }

    try {
      if (param === 'engine') {
        const engineValue = value === 'SUBTRACTIVE' ? 0 : value === 'FM' ? 1 : 2;
        host.setParameter('engine', engineValue);
      } else {
        host.setParameter(param, value as number);
      }
      return true;
    } catch (error) {
      console.error(`Failed to set parameter ${param}:`, error);
      return false;
    }
  };

  const handleCutoffChange = (value: number) => {
    if (validateAndSetParameter('cutoff', value)) {
      setCutoff(value);
    }
  };

  const handleDecayChange = (value: number) => {
    if (validateAndSetParameter('decay', value)) {
      setDecay(value);
    }
  };

  const handleEngineChange = (value: string) => {
    if (validateAndSetParameter('engine', value)) {
      setEngine(value);
    }
  };

  const previewNote = (frequency: number) => {
    try {
      // Preview auf dem gewählten Kanal (Gain kurz öffnen) + hörbare Note.
      audioEngine.setChannelGain(targetChannel, 1);
      audioEngine.previewSynthesizedSample({ frequency, decay, oscillatorType: engine === 'FM' ? 'square' : 'sawtooth' });
    } catch (e) {
      console.warn('[synth] Preview fehlgeschlagen:', (e as Error).message);
    }
  };

  const stepIdx = curStep % 16;
  const chIdx = TARGET_CHANNELS.indexOf(targetChannel) + 1;

  return (
    <div className="am-rackrow">
      <MoaAssistant pluginId="synthesizer" />
      <AmCard title="Klang" style={{ width: 214 }}
        right={<span className="am-vb" title={isLoaded ? 'WASM-Synth geladen' : 'WASM optional – Worklet-Synth aktiv'}>{isLoaded ? 'WASM' : 'WORKLET'}</span>}>
        <AmSeg label="Synth-Engine" value={engine} onChange={handleEngineChange}
          options={[['SUBTRACTIVE', 'SUB'], ['FM', 'FM'], ['WAVETABLE', 'WAVE']]} />
        <div className="am-c-row">
          <span className="am-lbl">Ziel</span>
          <select className="am-sel am-c-grow" aria-label="Routing-Ziel" value={targetChannel}
            onChange={(e) => setTargetChannel(e.target.value as TrackType)}>
            {TARGET_CHANNELS.map((ch, i) => <option key={ch} value={ch}>CH{i + 1}</option>)}
          </select>
        </div>
        <div className="am-c-row" role="group" aria-label="Vorhören">
          {PREVIEW_NOTES.map((note) => (
            <button key={note.label} type="button" className="am-tg am-c-grow" onClick={() => previewNote(note.frequency)}
              title={`Note ${note.label} auf CH${chIdx} vorhören`}>
              {note.label}
            </button>
          ))}
        </div>
      </AmCard>

      <AmCard title="Filter · Hüllkurve" style={{ flex: 1, minWidth: 250 }}>
        <div className="am-chainmini" aria-label="Signalweg">
          {[engine === 'SUBTRACTIVE' ? 'OSC SUB' : `OSC ${engine === 'FM' ? 'FM' : 'WAVE'}`, 'FILTER', 'DECAY', `CH${chIdx}`].map((n, i) => (
            <React.Fragment key={n}>{i > 0 && <span>→</span>}<b>{n}</b></React.Fragment>
          ))}
        </div>
        <div className="am-knobs" style={{ justifyContent: 'flex-start' }}>
          <AmKnob value={cutoff} min={20} max={20000} log def={DEFAULT_SYNTH_PARAMS.cutoff} unit="hz" label="Cutoff" title="Filter-Cutoff"
            onChange={(v) => handleCutoffChange(Math.round(v))} />
          <AmKnob value={decay} min={0} max={1} def={DEFAULT_SYNTH_PARAMS.decay} unit="pct" label="Decay" title="Hüllkurve Decay"
            onChange={(v) => handleDecayChange(Math.round(v * 100) / 100)} />
        </div>
        <div className="am-c-row">
          <span className="am-lbl">DX7</span>
          <select className="am-sel am-c-grow" aria-label="6-Op-FM-Patch (DX7)" value={fm6PatchIdx} onChange={(e) => loadFm6Patch(Number(e.target.value))}>
            {DX7_REFERENCE_PATCHES.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
          </select>
          <button type="button" className="am-tg" title="DX7-Note C4 spielen" onClick={() => audioEngine.fm6NoteOn(261.63, 0.8)}>▶</button>
        </div>
      </AmCard>

      <AmCard title="XY · Cutoff / Decay" style={{ width: 180 }}>
        <SynthXY cutoff={cutoff} decay={decay}
          onChange={(c, d) => { handleCutoffChange(c); handleDecayChange(d); }} />
      </AmCard>

      <AmCard title="Granular · Makros" style={{ width: 236 }}>
        <div className="am-knobs">
          <AmKnob size="s" value={grainSize} min={64} max={4096} def={480} unit="int" label="Grain" title="Grain-Größe (Samples)"
            onChange={(v) => { const n = Math.round(v / 64) * 64; setGrainSize(n); audioEngine.setGranularParams({ grainSize: n }); }} />
          <AmKnob size="s" value={grainDensity} min={1} max={100} def={20} unit="int" label="Density" title="Grain-Dichte"
            onChange={(v) => { const n = Math.round(v); setGrainDensity(n); audioEngine.setGranularParams({ density: n }); }} />
          <AmKnob size="s" value={grainPitch} min={0.25} max={4} def={1} display={grainPitch.toFixed(2)} label="Pitch" title="Grain-Tonhöhe"
            onChange={(v) => { const n = Math.round(v * 100) / 100; setGrainPitch(n); audioEngine.setGranularParams({ pitch: n }); }} />
        </div>
        <div className="am-c-row">
          <AmToggle on={grainFreeze} title="Granular einfrieren"
            onClick={() => { const n = !grainFreeze; setGrainFreeze(n); audioEngine.setGranularParams({ freeze: n }); }}>
            FREEZE
          </AmToggle>
          <button type="button" className="am-tg am-c-grow" onClick={loadGranularPreview} title="Granular-Source laden">▶ SOURCE</button>
        </div>
      </AmCard>

      <AmCard title="Step-Sequenzer · 16" style={{ flexBasis: '100%' }}
        right={<span className="am-c-stat" data-live-value="step">STEP {stepIdx + 1}/16</span>}>
        <div className="am-c-row" style={{ flexWrap: 'nowrap', gap: 10 }}>
          <AmKnob size="xs" value={seqSemi} min={0} max={12} def={0} display={`+${seqSemi}`} label="HT" title="Transponieren neuer Steps (Halbtöne)"
            onChange={(v) => setSeqSemi(Math.round(v))} />
          <div className="am-c-seq am-c-st am-c-grow" role="group" aria-label="Synth-Steps">
            <span className="am-c-trk am-on">SYNTH</span>
            {seq.map((f, i) => {
              const on = f > 0;
              return (
                <button type="button" key={i}
                  aria-label={`Step ${i + 1} ${on ? 'aus' : 'an'}`} aria-pressed={on}
                  className={`am-stp ${on ? 'am-v2' : ''} ${i % 4 === 0 ? 'am-q' : ''} ${stepIdx === i ? 'am-ph' : ''}`}
                  onClick={() => setSeq((prev) => {
                    const next = [...prev];
                    next[i] = next[i] > 0 ? 0 : 261.63 * Math.pow(2, seqSemi / 12);
                    return next;
                  })}>
                  {i + 1}
                </button>
              );
            })}
          </div>
        </div>
      </AmCard>
    </div>
  );
});

/** XY-Feld: X = Cutoff (logarithmisch 20 Hz–20 kHz), Y = Decay (oben = lang). */
function SynthXY({ cutoff, decay, onChange }: { cutoff: number; decay: number; onChange: (cutoff: number, decay: number) => void }) {
  const drag = React.useRef(false);
  const LOG = Math.log(20000 / 20);
  const x = Math.min(1, Math.max(0, Math.log(cutoff / 20) / LOG));
  const y = Math.min(1, Math.max(0, decay));
  const set = (nx: number, ny: number) => {
    const cx = Math.min(1, Math.max(0, nx));
    const cy = Math.min(1, Math.max(0, ny));
    onChange(Math.round(20 * Math.exp(cx * LOG)), Math.round(cy * 100) / 100);
  };
  const at = (el: HTMLElement, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    set((clientX - r.left) / r.width, 1 - (clientY - r.top) / r.height);
  };
  return (
    <div
      className="am-c-xy"
      role="group"
      tabIndex={0}
      aria-label={`XY-Feld: Cutoff ${Math.round(cutoff)} Hz, Decay ${Math.round(decay * 100)} %. Pfeiltasten: links/rechts Cutoff, hoch/runter Decay`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        drag.current = true;
        at(e.currentTarget, e.clientX, e.clientY);
      }}
      onPointerMove={(e) => { if (drag.current) at(e.currentTarget, e.clientX, e.clientY); }}
      onPointerUp={() => { drag.current = false; }}
      onPointerCancel={() => { drag.current = false; }}
      onKeyDown={(e) => {
        const d = e.shiftKey ? 0.01 : 0.05;
        const map: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
        const m = map[e.key];
        if (!m) return;
        e.preventDefault();
        set(x + m[0], y + m[1]);
      }}
    >
      <span style={{ left: 5, bottom: 3 }}>CUTOFF →</span>
      <span style={{ left: 5, top: 3 }}>DECAY ↑</span>
      <b style={{ left: `${x * 100}%`, top: `${(1 - y) * 100}%` }} />
    </div>
  );
}
