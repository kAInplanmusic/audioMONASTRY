/**
 * dspMONK · Gate, Filter, Saturator, Kompressor, Tilt-EQ, Limiter, Automation
 * ========================================================================
 * Vorlage: docs/design/audioMONASTRY-design.html + V2_UI_VERKABELUNG.md
 * Engine: setDspParam (phase, filterCutoff, resonance, depth, drive)
 * Module: gate, filter, sat, comp, tilt, lim
 * LFO-Automation auf Cutoff/Resonanz/Gain
 */
import React, { useEffect, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { AmCard, AmKnob, AmToggle, AmTabs, AmLed } from './amUi';

interface DspModule {
  on: boolean;
  // Gate
  gateThresh: number;
  gateRange: number;
  gateAttack: number;
  gateRelease: number;
  // Filter
  filterCutoff: number;
  filterResonance: number;
  filterType: 'lowpass' | 'highpass' | 'bandpass' | 'notch';
  // Saturator
  satDrive: number;
  satMix: number;
  // Compressor
  compThresh: number;
  compRatio: number;
  compAttack: number;
  compRelease: number;
  compKnee: number;
  compMakeup: number;
  // Tilt EQ
  tiltGain: number;
  // Limiter
  limCeiling: number;
  limRelease: number;
}

const MODULES: { id: keyof DspModule; label: string; icon: string }[] = [
  { id: 'on', label: 'DSP Global', icon: '⚙️' },
  { id: 'gateThresh', label: 'Gate', icon: '🚪' },
  { id: 'filterCutoff', label: 'Filter', icon: '🔍' },
  { id: 'satDrive', label: 'Saturator', icon: '🔥' },
  { id: 'compThresh', label: 'Kompressor', icon: '📊' },
  { id: 'tiltGain', label: 'Tilt EQ', icon: '⚖️' },
  { id: 'limCeiling', label: 'Limiter', icon: '🧱' },
];

const DEFAULTS: DspModule = {
  on: true,
  gateThresh: -40,
  gateRange: -80,
  gateAttack: 0.1,
  gateRelease: 100,
  filterCutoff: 20000,
  filterResonance: 0.5,
  filterType: 'lowpass',
  satDrive: 0,
  satMix: 1,
  compThresh: -20,
  compRatio: 4,
  compAttack: 10,
  compRelease: 100,
  compKnee: 10,
  compMakeup: 0,
  tiltGain: 0,
  limCeiling: -1,
  limRelease: 50,
};

function restore() {
  const raw = readPluginSettings<Partial<DspModule>>('dsp');
  return { ...DEFAULTS, ...raw };
}

export const DspRack = React.memo(function DspRack() {
  const [state, setState] = useState(() => restore());
  const [activeModule, setActiveModule] = useState<keyof DspModule>('on');

  // Engine initialisieren
  useEffect(() => {
    audioEngine.setDspParam({
      phase: 0,
      filterCutoff: state.filterCutoff,
      resonance: state.filterResonance,
      depth: 0,
      drive: state.satDrive,
    });
    // TODO: Gate, Comp, Tilt, Limiter via Worklet
  }, [state.filterCutoff, state.filterResonance, state.satDrive]);

  // Persistieren
  useEffect(() => {
    writePluginSettings('dsp', state);
  }, [state]);

  const setParam = <K extends keyof DspModule>(key: K, value: DspModule[K]) => {
    setState(prev => {
      const next = { ...prev, [key]: value };
      // Engine updates für Echtzeit-Parameter
      if (key === 'filterCutoff' || key === 'filterResonance' || key === 'satDrive') {
        audioEngine.setDspParam({
          phase: 0,
          filterCutoff: next.filterCutoff,
          resonance: next.filterResonance,
          depth: 0,
          drive: next.satDrive,
        });
      }
      return next;
    });
  };

  return (
    <div className="am-rackrow" data-testid="dsp-rack">
      {/* Module Selector */}
      <AmCard title="DSP Modules" style={{ width: 220 }}>
        <div className="am-seg" role="group" aria-label="DSP Module" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {MODULES.map(m => (
            <button
              key={m.id}
              type="button"
              className={`am-tg ${activeModule === m.id ? 'am-on' : ''}`}
              onClick={() => setActiveModule(m.id)}
              aria-pressed={activeModule === m.id}
              aria-label={m.label}
              style={{ padding: '4px 10px', fontSize: 11 }}
            >
              {m.icon} {m.label}
            </button>
          ))}
        </div>
        <div className="am-row am-c" style={{ marginTop: 8, gap: 8 }}>
          <AmToggle
            on={state.on}
            onClick={() => setParam('on', !state.on)}
            kind="m"
            ariaLabel="DSP Global ein/aus"
          >
            ON
          </AmToggle>
          <AmLed on={state.on} color="ok" size="s" label={state.on ? 'DSP aktiv' : 'DSP Bypass'} />
        </div>
      </AmCard>

      {/* Module Parameters */}
      <AmCard title="Parameters" style={{ flex: 1, minWidth: 480 }}>
        <AmTabs
          tabs={MODULES.map(m => ({ id: m.id, label: m.label }))}
          active={activeModule}
          onChange={(id: string) => setActiveModule(id as keyof DspModule)}
        />
        <div id={`panel-${activeModule}`} role="tabpanel" aria-labelledby={`tab-${activeModule}`}>
          {activeModule === 'gateThresh' && (
            <div className="am-knobs" style={{ marginTop: 12 }}>
              <AmToggle on={state.on} onClick={() => setParam('on', !state.on)} kind="m" ariaLabel="Gate ON" disabled={!state.on} >ON</AmToggle>
              <AmKnob size="s" value={state.gateThresh} min={-80} max={0} def={-40} unit="db" label="Thresh" title="Gate Threshold" onChange={v => setParam('gateThresh', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.gateRange} min={-100} max={0} def={-80} unit="db" label="Range" title="Gate Range" onChange={v => setParam('gateRange', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.gateAttack} min={0.01} max={100} def={0.1} log unit="ms" label="Attack" title="Gate Attack" onChange={v => setParam('gateAttack', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.gateRelease} min={1} max={500} def={100} unit="ms" label="Release" title="Gate Release" onChange={v => setParam('gateRelease', v)} disabled={!state.on} />
            </div>
          )}
          {activeModule === 'filterCutoff' && (
            <div className="am-knobs" style={{ marginTop: 12 }}>
              <AmToggle on={state.on} onClick={() => setParam('on', !state.on)} kind="m" ariaLabel="Filter ON" disabled={!state.on} >ON</AmToggle>
              <AmKnob size="s" value={state.filterCutoff} min={20} max={20000} def={20000} log unit="hz" label="Cutoff" title="Filter Cutoff" onChange={v => setParam('filterCutoff', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.filterResonance} min={0} max={20} def={0.5} unit="x" label="Resonance" title="Filter Resonance (Q)" onChange={v => setParam('filterResonance', v)} disabled={!state.on} />
              <select className="am-sel" value={state.filterType} onChange={e => setParam('filterType', e.target.value as DspModule['filterType'])} disabled={!state.on} style={{ minWidth: 120 }}>
                <option value="lowpass">Lowpass</option>
                <option value="highpass">Highpass</option>
                <option value="bandpass">Bandpass</option>
                <option value="notch">Notch</option>
              </select>
            </div>
          )}
          {activeModule === 'satDrive' && (
            <div className="am-knobs" style={{ marginTop: 12 }}>
              <AmToggle on={state.on} onClick={() => setParam('on', !state.on)} kind="m" ariaLabel="Saturator ON" disabled={!state.on} >ON</AmToggle>
              <AmKnob size="s" value={state.satDrive} min={0} max={1} def={0} unit="pct" label="Drive" title="Saturation Drive" onChange={v => setParam('satDrive', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.satMix} min={0} max={1} def={1} unit="pct" label="Mix" title="Dry/Wet Mix" onChange={v => setParam('satMix', v)} disabled={!state.on} />
            </div>
          )}
          {activeModule === 'compThresh' && (
            <div className="am-knobs" style={{ marginTop: 12 }}>
              <AmToggle on={state.on} onClick={() => setParam('on', !state.on)} kind="m" ariaLabel="Compressor ON" disabled={!state.on} >ON</AmToggle>
              <AmKnob size="s" value={state.compThresh} min={-60} max={0} def={-20} unit="db" label="Thresh" title="Threshold" onChange={v => setParam('compThresh', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.compRatio} min={1} max={20} def={4} unit="x" label="Ratio" title="Ratio" onChange={v => setParam('compRatio', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.compAttack} min={0.1} max={100} def={10} log unit="ms" label="Attack" title="Attack" onChange={v => setParam('compAttack', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.compRelease} min={10} max={2000} def={100} log unit="ms" label="Release" title="Release" onChange={v => setParam('compRelease', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.compKnee} min={0} max={40} def={10} unit="db" label="Knee" title="Knee" onChange={v => setParam('compKnee', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.compMakeup} min={0} max={24} def={0} unit="db" label="Makeup" title="Makeup Gain" onChange={v => setParam('compMakeup', v)} disabled={!state.on} />
            </div>
          )}
          {activeModule === 'tiltGain' && (
            <div className="am-knobs" style={{ marginTop: 12 }}>
              <AmToggle on={state.on} onClick={() => setParam('on', !state.on)} kind="m" ariaLabel="Tilt EQ ON" disabled={!state.on} >ON</AmToggle>
              <AmKnob size="s" value={state.tiltGain} min={-12} max={12} def={0} unit="db" label="Tilt" title="Tilt Gain (dunkel ↔ hell)" onChange={v => setParam('tiltGain', v)} disabled={!state.on} />
            </div>
          )}
          {activeModule === 'limCeiling' && (
            <div className="am-knobs" style={{ marginTop: 12 }}>
              <AmToggle on={state.on} onClick={() => setParam('on', !state.on)} kind="m" ariaLabel="Limiter ON" disabled={!state.on} >ON</AmToggle>
              <AmKnob size="s" value={state.limCeiling} min={-12} max={0} def={-1} unit="db" label="Ceiling" title="Limiter Ceiling" onChange={v => setParam('limCeiling', v)} disabled={!state.on} />
              <AmKnob size="s" value={state.limRelease} min={1} max={500} def={50} unit="ms" label="Release" title="Limiter Release" onChange={v => setParam('limRelease', v)} disabled={!state.on} />
            </div>
          )}
          {activeModule === 'on' && (
            <div style={{ marginTop: 12, padding: 16, textAlign: 'center', color: 'var(--dm)' }}>
              Wählen Sie ein Modul oben aus, um dessen Parameter zu bearbeiten.
            </div>
          )}
        </div>
      </AmCard>

      {/* Meter */}
      <AmCard title="DSP Meter" style={{ width: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, height: 180 }}>
          <div style={{ width: 10, height: 160, background: '#03060c', borderRadius: 2, position: 'relative', border: '1px solid #0e1a33' }}>
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '50%', background: 'linear-gradient(0deg,var(--ok) 0,var(--ok) 60%,var(--warn) 80%,var(--hot) 100%)' }} />
          </div>
          <span className="am-hint">GR</span>
        </div>
      </AmCard>
    </div>
  );
});