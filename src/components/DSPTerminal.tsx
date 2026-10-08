/**
 * dspMONK · Rack-Modul (Vorlagen public/uidesign/uibspdsp1–5, uiübersichtapp Zeile 14)
 * ===============================================================================
 * Eine Zeile: Signalkette Input → Gate → Compressor → Dyn-EQ → Output als
 * Modul-Kästchen (antippen = an/aus), darunter die Regler je Stufe ·
 * it-synth-Automation mit Stimmen-Monitor · Engine-Parameter · Live-Monitor.
 * Optionale DSP-Bausteine kompakt aufklappbar.
 * Engine: setDynamicsParams / automateItSynthParam / setWorkletParam (wie bisher).
 * Stand in der Session (`writePluginSettings('dsp', …)`).
 */
import React, { useState, useEffect, useRef } from 'react';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { masterClock } from '../core/clock/MonastryMasterClock';
import { MoaAssistant } from './MoaAssistant';
import { OptionalDspPanel } from './dsp/OptionalDspPanel';
import { performanceMonitor, PerformanceSnapshot } from '../utils/PerformanceMonitor';
import { webRTCManager } from '../utils/WebRTCManager';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { AmCard, AmKnob, AmToggle } from './am/amUi';

const DEFAULT_AUTO_PARAMS = { cutoff: 1200, resonance: 0.4, modIndex: 5, gain: 0.8, lfoRate: 0, lfoDepth: 0 };
/** P1-Dynamik: Kompressor/Gate/Dynamic-EQ-Insert (Default = Bypass). */
const DEFAULT_DYNAMICS = {
  enabled: false,
  gateEnabled: false,
  dynEqEnabled: false,
  threshold: -18, ratio: 3, attack: 0.01, release: 0.12, makeup: 0,
  gateThreshold: -60, gateRange: 40,
  dynEqFreq: 3000, dynEqQ: 4, dynEqThreshold: -24, dynEqRange: 12,
};
/** Worklet-Engine-Parameter (Startwerte = bisherige feste Anzeige). */
const DEFAULT_ENGINE = { oversampling: 8, lookahead: 1.5, transient: 0.8, stereoLink: 1 };
type DspSettings = { power?: boolean; autoParams?: unknown; dynamics?: unknown; engine?: unknown };
type AutoParam = keyof typeof DEFAULT_AUTO_PARAMS;
type DynKey = Exclude<keyof typeof DEFAULT_DYNAMICS, 'enabled' | 'gateEnabled' | 'dynEqEnabled'>;
type EngineKey = keyof typeof DEFAULT_ENGINE;

const snap = (v: number, step: number) => Math.round(v / step) * step;
const fmtHz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`);
const fmtDb = (v: number, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;

interface Ctl<K extends string> { key: K; label: string; title: string; min: number; max: number; step: number; log?: boolean; fmt: (v: number) => string }

const GATE_CTL: Ctl<DynKey>[] = [
  { key: 'gateThreshold', label: 'Thr', title: 'Gate-Schwelle (dB)', min: -100, max: 0, step: 1, fmt: (v) => v.toFixed(0) },
  { key: 'gateRange', label: 'Range', title: 'Gate-Bereich (dB)', min: 0, max: 90, step: 1, fmt: (v) => v.toFixed(0) },
];
const COMP_CTL: Ctl<DynKey>[] = [
  { key: 'threshold', label: 'Thr', title: 'Kompressor-Schwelle (dB)', min: -60, max: 0, step: 0.5, fmt: (v) => v.toFixed(1) },
  { key: 'ratio', label: 'Ratio', title: 'Ratio', min: 1, max: 20, step: 0.1, log: true, fmt: (v) => `${v.toFixed(1)}:1` },
  { key: 'attack', label: 'Att ms', title: 'Attack', min: 0.001, max: 0.1, step: 0.001, log: true, fmt: (v) => (v * 1000).toFixed(0) },
  { key: 'release', label: 'Rel ms', title: 'Release', min: 0.01, max: 1, step: 0.01, log: true, fmt: (v) => (v * 1000).toFixed(0) },
  { key: 'makeup', label: 'Makeup', title: 'Makeup-Gain (dB)', min: -12, max: 24, step: 0.5, fmt: (v) => fmtDb(v) },
];
const EQ_CTL: Ctl<DynKey>[] = [
  { key: 'dynEqFreq', label: 'Freq', title: 'Dyn-EQ-Frequenz (Hz)', min: 40, max: 16000, step: 10, log: true, fmt: fmtHz },
  { key: 'dynEqQ', label: 'Q', title: 'Dyn-EQ-Güte', min: 0.3, max: 18, step: 0.1, log: true, fmt: (v) => v.toFixed(1) },
  { key: 'dynEqThreshold', label: 'Thr', title: 'Dyn-EQ-Schwelle (dB)', min: -80, max: 0, step: 1, fmt: (v) => v.toFixed(0) },
  { key: 'dynEqRange', label: 'Range', title: 'Dyn-EQ-Bereich (dB)', min: 0, max: 24, step: 0.5, fmt: (v) => v.toFixed(1) },
];
const AUTO_CTL: Ctl<AutoParam>[] = [
  { key: 'cutoff', label: 'Cutoff', title: 'Cutoff (Hz)', min: 40, max: 16000, step: 10, log: true, fmt: fmtHz },
  { key: 'resonance', label: 'Reso', title: 'Resonanz', min: 0, max: 16, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: 'modIndex', label: 'Mod-Idx', title: 'Modulationsindex', min: 0, max: 32, step: 0.5, fmt: (v) => v.toFixed(1) },
  { key: 'gain', label: 'Gain', title: 'Gain', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'lfoRate', label: 'LFO Hz', title: 'LFO-Rate (Hz)', min: 0, max: 20, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: 'lfoDepth', label: 'LFO Tiefe', title: 'LFO-Tiefe', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
];
const ENGINE_CTL: Ctl<EngineKey>[] = [
  { key: 'oversampling', label: 'Oversmp', title: 'Oversampling (x)', min: 1, max: 8, step: 0.1, fmt: (v) => `${v.toFixed(1)}x` },
  { key: 'lookahead', label: 'Lookahd', title: 'Lookahead (ms)', min: 0, max: 10, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: 'transient', label: 'Transnt', title: 'Transienten-Erkennung', min: 0, max: 1, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: 'stereoLink', label: 'St-Link', title: 'Stereo-Link', min: 0, max: 1, step: 0.1, fmt: (v) => v.toFixed(1) },
];

export const DSPTerminal = React.memo(function DSPTerminal() {
  const { state, lockStatus, updateState } = usePluginState('dsp', 'PRO');
  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  // Beständige Plugins: Einstiegsstand = letzter Stand in der Session.
  const [saved] = useState(() => readPluginSettings<DspSettings>('dsp'));
  const [power, setPower] = useState(typeof saved?.power === 'boolean' ? saved.power : true);
  // Worklet-Automation (Task 1/3): sichtbare Regler + aktive Stimmen.
  const [autoParams, setAutoParams] = useState(() => mergeKnown(DEFAULT_AUTO_PARAMS, saved?.autoParams));
  const [activeVoices, setActiveVoices] = useState(0);
  const [dynamics, setDynamics] = useState(() => mergeKnown(DEFAULT_DYNAMICS, saved?.dynamics));
  const [engine, setEngine] = useState(() => mergeKnown(DEFAULT_ENGINE, saved?.engine));
  // Echtzeit-Performance-Snapshot (FPS, Jitter, Audio-Health).
  const [perf, setPerf] = useState<PerformanceSnapshot>(() => performanceMonitor.snapshot());
  /**
   * Clock-Diagnose (Befund 2026-09-19): die NTP-artige Sync-Kette war vorhanden,
   * wurde aber nie ausgeloest - hier wird sichtbar, ob und wie gut die Clients
   * auf die Serveruhr eingemessen sind (RTT, Drift, Anzahl Messungen).
   */
  const [clock, setClock] = useState(() => masterClock.getDiagnostics());

  const handleParamChange = (name: EngineKey, value: number) => {
      setEngine((prev) => ({ ...prev, [name]: value }));
      audioEngine.setWorkletParam(name, value);
  };

  // Performance-Monitor starten und 1x/Sekunde die Anzeige aktualisieren.
  useEffect(() => {
    performanceMonitor.setAudioStateProvider(() => audioEngine.getAudioHealth());
    performanceMonitor.start();
    const timer = setInterval(() => {
      setPerf(performanceMonitor.snapshot());
      setClock(masterClock.getDiagnostics());
    }, 1000);
    return () => { clearInterval(timer); performanceMonitor.stop(); };
  }, []);

  /** Dynamik-Parameter an den Worklet-Insert schicken. */
  const pushDynamics = (next: typeof dynamics) => {
      audioEngine.setDynamicsParams({
        enabled: next.enabled,
        compressor: {
          threshold: next.threshold, ratio: next.ratio,
          attack: next.attack, release: next.release, makeup: next.makeup,
        },
        gate: { enabled: next.gateEnabled, threshold: next.gateThreshold, range: next.gateRange },
        dynEq: {
          enabled: next.dynEqEnabled, freq: next.dynEqFreq, q: next.dynEqQ,
          threshold: next.dynEqThreshold, range: next.dynEqRange,
        },
      });
  };

  /** Dynamik-Parameter setzen und an den Worklet-Insert schicken. */
  const updateDynamics = (patch: Partial<typeof dynamics>) => {
    setDynamics((prev) => {
      const next = { ...prev, ...patch };
      pushDynamics(next);
      return next;
    });
  };

  // Übernahme: gespeicherten Stand genau einmal an die Engine geben.
  const didRestoreRef = useRef(false);
  useEffect(() => {
    if (didRestoreRef.current || !saved) return;
    didRestoreRef.current = true;
    (Object.keys(autoParams) as (keyof typeof autoParams)[]).forEach((k) => audioEngine.automateItSynthParam(k, autoParams[k], 0.02));
    pushDynamics(dynamics);
    if (saved.engine) (Object.keys(engine) as EngineKey[]).forEach((k) => audioEngine.setWorkletParam(k, engine[k]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Öffnen (Einstiegsstand)
  }, []);

  // Beständige Plugins: jeden Stand an die Session (der nächste Halter startet damit).
  useEffect(() => {
    writePluginSettings('dsp', { power, autoParams, dynamics, engine });
  }, [power, autoParams, dynamics, engine]);

  const handleAutomate = (param: AutoParam, value: number, rampTime = 0.02) => {
    setAutoParams(prev => ({ ...prev, [param]: value }));
    audioEngine.automateItSynthParam(param, value, rampTime);
  };

  // Stimmen-Status des itSynth-Banks in die UI spiegeln.
  useEffect(() => {
    const interval = setInterval(() => {
      const sink = audioEngine.v2LiveSink;
      if (sink && typeof sink.itGetActiveVoices === 'function') {
        setActiveVoices(sink.itGetActiveVoices());
      }
    }, 100);
    return () => clearInterval(interval);
  }, []);

  const off = locked || !power;
  const ins = dynamics.enabled;
  const knob = <K extends string>(c: Ctl<K>, value: number, onChange: (v: number) => void) => (
    <AmKnob key={c.key} size="xs" value={value} min={c.min} max={c.max} log={c.log} label={c.label} title={c.title}
      display={c.fmt(value)} disabled={off} onChange={(v) => onChange(snap(v, c.step))} />
  );
  const dynKnob = (c: Ctl<DynKey>) => knob(c, dynamics[c.key], (v) => updateDynamics({ [c.key]: v }));
  const stage = (label: string, value: string, on: boolean, onClick?: () => void, title?: string) => {
    const body = (<><span className="am-lbl">{label}</span><b className="am-mono">{value}</b></>);
    return onClick ? (
      <button type="button" className={`am-dspbox ${on ? 'am-on' : ''}`} aria-pressed={on} title={title} disabled={locked} onClick={onClick}>{body}</button>
    ) : (
      <div className={`am-dspbox ${on ? 'am-on' : ''}`} title={title}>{body}</div>
    );
  };
  const kpi = (label: string, value: React.ReactNode, ok: boolean) => (
    <div className="am-kpi"><b style={{ color: ok ? 'var(--ok)' : 'var(--warn)' }}>{value}</b><span>{label}</span></div>
  );

  return (
    <div className="am-rackrow am-dsp" style={locked ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="dsp" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />

      <AmCard title="Signalkette · Dynamik" style={{ flex: 1, minWidth: 'min(560px, 100%)' }}
        right={(
          <AmToggle on={power} onClick={() => setPower(!power)} disabled={locked} ariaLabel={power ? 'DSP-Bedienung sperren' : 'DSP-Bedienung freigeben'}>
            {power ? 'DSP AN' : 'DSP AUS'}
          </AmToggle>
        )}>
        <div className="am-dspchain" aria-label="Signalkette">
          {stage('Input', ins ? 'INSERT' : 'BYPASS', ins, () => updateDynamics({ enabled: !ins }), 'Dynamik-Insert an/aus')}
          <span className="am-fxarr">→</span>
          {stage('Gate', `${dynamics.gateThreshold.toFixed(0)} dB`, ins && dynamics.gateEnabled, () => updateDynamics({ gateEnabled: !dynamics.gateEnabled }), 'Gate an/aus')}
          <span className="am-fxarr">→</span>
          {stage('Compressor', `${dynamics.ratio.toFixed(1)}:1`, ins, undefined, 'Kompressor läuft, sobald der Insert an ist')}
          <span className="am-fxarr">→</span>
          {stage('Dyn-EQ', `${fmtHz(dynamics.dynEqFreq)} Hz`, ins && dynamics.dynEqEnabled, () => updateDynamics({ dynEqEnabled: !dynamics.dynEqEnabled }), 'Dynamic EQ an/aus')}
          <span className="am-fxarr">→</span>
          {stage('Output', `${fmtDb(dynamics.makeup)} dB`, ins, undefined, 'Ausgang (Makeup-Gain)')}
        </div>
        <div className={`am-dspknobs ${off ? 'am-boff' : ''}`}>
          <div className="am-dspgrp"><span className="am-lbl">Gate</span><div className="am-knobs">{GATE_CTL.map(dynKnob)}</div></div>
          <div className="am-dspgrp"><span className="am-lbl">Compressor</span><div className="am-knobs">{COMP_CTL.map(dynKnob)}</div></div>
          <div className="am-dspgrp"><span className="am-lbl">Dyn-EQ</span><div className="am-knobs">{EQ_CTL.map(dynKnob)}</div></div>
        </div>
      </AmCard>

      <AmCard title="Automation · it-synth" style={{ width: 316 }}
        right={<span className="am-vb" style={activeVoices > 0 ? { color: 'var(--ok)', borderColor: 'var(--ok)' } : undefined}>VOICES {activeVoices}</span>}>
        <div className={`am-knobs ${off ? 'am-boff' : ''}`}>
          {AUTO_CTL.map((c) => knob(c, autoParams[c.key], (v) => handleAutomate(c.key, v)))}
        </div>
        <span className="am-lbl">Engine</span>
        <div className={`am-knobs ${off ? 'am-boff' : ''}`}>
          {ENGINE_CTL.map((c) => knob(c, engine[c.key], (v) => handleParamChange(c.key, v)))}
        </div>
      </AmCard>

      <AmCard title="Monitor" style={{ width: 210 }}>
        {/* VISUAL-P1-010: Live-Werte (FPS/Jitter/Latenz) aendern sich staendig -
            visuelle Baselines blenden den Bereich ueber [data-live-value] aus. */}
        <div
          className="am-dspmon"
          data-live-value="perf"
          data-clock-values={clock.syncCount}
          // Schätzwert der Serveruhr (Serverzeit-Epoche minus lokale performance.now())
          // - damit laesst sich vergleichen, ob zwei Clients dieselbe Serverzeit sehen.
          data-clock-offset-ms={Math.round(clock.syncedOffsetMs)}
        >
          {kpi('UI FPS', perf.fps, perf.fps >= 30)}
          {kpi('Jitter ms', perf.jitterMs, perf.jitterMs < 2)}
          {kpi('Latenz ms', perf.audioBaseLatencyMs, perf.audioBaseLatencyMs < 15)}
          {kpi(`Audio ${perf.audioSampleRate ? `${(perf.audioSampleRate / 1000).toFixed(1)}k` : '--'}`, perf.audioState.toUpperCase(), perf.audioState === 'running')}
          {kpi('Clock RTT', clock.serverRttMs > 0 ? `${clock.serverRttMs.toFixed(1)}` : '–', clock.serverRttMs > 0 && clock.serverRttMs < 50)}
          {kpi('Clock Drift', clock.syncCount > 0 ? `${clock.offsetDriftMs.toFixed(1)}` : '–', Math.abs(clock.offsetDriftMs) < 5)}
          {kpi('Messungen', clock.syncCount, clock.syncCount > 0)}
          {kpi('Frames verl.', perf.droppedFrames, perf.droppedFrames === 0)}
        </div>
      </AmCard>

      {/* FEAT-P3-002: optionale DSP-Bausteine – je Baustein sichtbar, welchem MONK er gehört. */}
      <details className="am-dspx">
        <summary className="am-lbl">Zusatz-Bausteine · Mod-Matrix · HQ-Reverb · Phase-Distortion · E-Piano</summary>
        <div className="am-dspxgrid">
          <OptionalDspPanel block="mod-matrix" />
          <OptionalDspPanel block="hq-reverb" />
          <OptionalDspPanel block="phase-distortion" />
          <OptionalDspPanel block="electric-piano" />
        </div>
      </details>
    </div>
  );
});
