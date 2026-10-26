/**
 * dspMONK · Filter, Saturator, Kompressor, Limiter — nur was wirklich klingt
 * ========================================================================
 * Vorlage: docs/design/audioMONASTRY-design.html + V2_UI_VERKABELUNG.md
 *
 * VERKABELUNG (korrigiert 2026-10-26). Der hörbare V2-Pfad kennt genau zwei
 * Stellschrauben-Gruppen, alles andere war Attrappe:
 *
 *   audioEngine.setDspParam({filterCutoff, resonance, depth, drive})
 *     → v2LiveSink.setMasterDsp()  (DspFilterNode: Lowpass + tanh-Sättiger)
 *   audioEngine.setMasterDynamics?(...)  → es gibt dafür keinen Setter;
 *     der Weg ist audioEngine.setMasteringParams({threshold, ratio, makeup, ceiling})
 *     → mirrorMastering → v2LiveSink.setMasterMastering()
 *
 * Deshalb gibt es hier nur noch vier Module:
 *   Filter     – cutoff/resonance, aktiviert über `depth` (Bypass bei depth=0 UND drive=0,
 *                siehe processingNodes.ts:346 – Cutoff allein ist wirkungslos!)
 *   Saturator  – drive (tanh-Sättiger, oversampled)
 *   Kompressor – threshold/ratio/makeup (setMasteringParams; KEIN attack/release/knee im V2-Pfad)
 *   Limiter    – ceiling + threshold/ratio (setMasteringParams)
 *
 * Entfernt (kein Gegenstück im V2-Pfad, als Live-Regler wären sie Attrappen):
 *   Gate (kein Gate-Knoten im Master-Pfad) · Tilt-EQ (liegt im masterMONK als
 *   12-Band-Klangbild) · Attack/Release/Knee des Kompressors.
 */
import React, { useEffect, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { AmCard, AmKnob, AmToggle, AmTabs, AmLed } from './amUi';

type ModuleId = 'filter' | 'sat' | 'comp' | 'lim';

interface DspState {
  /** Filter */
  filterOn: boolean;
  cutoff: number;
  resonance: number;
  /** Saturator */
  satOn: boolean;
  drive: number;
  /** Kompressor */
  compOn: boolean;
  compThreshold: number;
  compRatio: number;
  compMakeup: number;
  /** Limiter */
  limOn: boolean;
  limThreshold: number;
  limRatio: number;
  limCeiling: number;
}

const MODULES: { id: ModuleId; label: string; icon: string }[] = [
  { id: 'filter', label: 'Filter', icon: '🔍' },
  { id: 'sat', label: 'Saturator', icon: '🔥' },
  { id: 'comp', label: 'Kompressor', icon: '📊' },
  { id: 'lim', label: 'Limiter', icon: '🧱' },
];

const DEFAULTS: DspState = {
  filterOn: false,
  cutoff: 20000,
  resonance: 0.5,
  satOn: false,
  drive: 0,
  compOn: false,
  compThreshold: -18,
  compRatio: 3,
  compMakeup: 0,
  limOn: false,
  limThreshold: -6,
  limRatio: 20,
  limCeiling: 0.98,
};

function restore(): DspState {
  const raw = readPluginSettings<Partial<DspState>>('dsp');
  return { ...DEFAULTS, ...raw };
}

/** dB-Wert (negativ) → linearer Pegel für den Limiter-Ceiling. */
const dbToLin = (db: number) => Math.pow(10, db / 20);

export const DspRack = React.memo(function DspRack() {
  const [state, setState] = useState<DspState>(restore);
  const [active, setActive] = useState<ModuleId>('filter');

  // Einziger Engine-Schreibpfad — aus dem Stand abgeleitet.
  const applyToEngine = (s: DspState) => {
    try {
      audioEngine.setDspParam({
        // Filter: Bypass bei depth=0 UND drive=0 → depth schaltet die Stufe.
        filterCutoff: s.cutoff,
        resonance: s.resonance,
        depth: s.filterOn ? 0.2 : 0,
        drive: s.satOn ? s.drive : 0,
      });
      audioEngine.setMasteringParams({
        threshold: s.limOn ? s.limThreshold : (s.compOn ? s.compThreshold : 0),
        ratio: s.limOn ? s.limRatio : (s.compOn ? s.compRatio : 1),
        makeup: s.compOn ? s.compMakeup : 0,
        ceiling: s.limOn ? dbToLin(s.limCeiling) : 1,
      });
    } catch { /* Engine noch nicht bereit – Stand bleibt */ }
  };

  useEffect(() => {
    applyToEngine(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Einhängen
  }, []);

  useEffect(() => {
    writePluginSettings('dsp', state);
  }, [state]);

  const patch = (p: Partial<DspState>) => {
    setState((prev) => {
      const next = { ...prev, ...p };
      applyToEngine(next);
      return next;
    });
  };

  return (
    <div className="am-rackrow" data-testid="dsp-rack">
      {/* Modulwahl */}
      <AmCard title="DSP-Module" style={{ width: 220 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {MODULES.map((m) => {
            const on = m.id === 'filter' ? state.filterOn : m.id === 'sat' ? state.satOn : m.id === 'comp' ? state.compOn : state.limOn;
            return (
              <button
                key={m.id}
                type="button"
                className={`am-btn ${active === m.id ? 'am-pri' : ''}`}
                onClick={() => setActive(m.id)}
                aria-pressed={active === m.id}
                aria-label={`Modul ${m.label}`}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>{m.icon} {m.label}</span>
                <AmLed on={on} color={on ? 'ok' : 'lock'} size="xs" />
              </button>
            );
          })}
        </div>
        <p className="am-hint" style={{ marginTop: 8 }}>
          Nur diese vier Stufen existieren im V2-Master-Pfad. Gate und Tilt-EQ sind entfernt
          (Gate: kein Knoten im Pfad · Tilt: liegt im masterMONK).
        </p>
      </AmCard>

      {/* Parameter */}
      <AmCard title={MODULES.find((m) => m.id === active)?.label ?? 'Parameter'} style={{ flex: 1, minWidth: 460 }}>
        <AmTabs
          tabs={MODULES.map((m) => ({ id: m.id, label: m.label }))}
          active={active}
          onChange={(id: string) => setActive(id as ModuleId)}
        />
        <div id={`panel-${active}`} role="tabpanel" aria-labelledby={`tab-${active}`}>
          {active === 'filter' && (
            <>
              <div className="am-row am-c" style={{ gap: 10, marginTop: 12 }}>
                <AmToggle on={state.filterOn} onClick={() => patch({ filterOn: !state.filterOn })} kind="m" ariaLabel="Filter ein/aus">
                  {state.filterOn ? 'ON' : 'OFF'}
                </AmToggle>
                <AmLed on={state.filterOn} color={state.filterOn ? 'ok' : 'lock'} size="s" label="Filter" />
                <span className="am-hint">Depth schaltet die Stufe (Bypass bei 0)</span>
              </div>
              <div className="am-knobs" style={{ marginTop: 10 }}>
                <AmKnob size="s" value={state.cutoff} min={20} max={20000} def={20000} log unit="hz" label="Cutoff" title="Eckfrequenz des Tiefpasses" onChange={(v) => patch({ cutoff: v })} disabled={!state.filterOn} />
                <AmKnob size="s" value={state.resonance} min={0.1} max={1} def={0.5} unit="pct" label="Resonanz" title="Güte Q (0,1–1)" onChange={(v) => patch({ resonance: v })} disabled={!state.filterOn} />
              </div>
            </>
          )}
          {active === 'sat' && (
            <>
              <div className="am-row am-c" style={{ gap: 10, marginTop: 12 }}>
                <AmToggle on={state.satOn} onClick={() => patch({ satOn: !state.satOn })} kind="m" ariaLabel="Saturator ein/aus">
                  {state.satOn ? 'ON' : 'OFF'}
                </AmToggle>
                <AmLed on={state.satOn} color={state.satOn ? 'ok' : 'lock'} size="s" label="Saturator" />
              </div>
              <div className="am-knobs" style={{ marginTop: 10 }}>
                <AmKnob size="s" value={state.drive} min={0} max={1} def={0} unit="pct" label="Drive" title="Sättigung (tanh, oversampled)" onChange={(v) => patch({ drive: v })} disabled={!state.satOn} />
              </div>
            </>
          )}
          {active === 'comp' && (
            <>
              <div className="am-row am-c" style={{ gap: 10, marginTop: 12 }}>
                <AmToggle on={state.compOn} onClick={() => patch({ compOn: !state.compOn })} kind="m" ariaLabel="Kompressor ein/aus">
                  {state.compOn ? 'ON' : 'OFF'}
                </AmToggle>
                <AmLed on={state.compOn} color={state.compOn ? 'ok' : 'lock'} size="s" label="Kompressor" />
              </div>
              <div className="am-knobs" style={{ marginTop: 10 }}>
                <AmKnob size="s" value={state.compThreshold} min={-60} max={0} def={-18} unit="db" label="Thresh" title="Threshold" onChange={(v) => patch({ compThreshold: v })} disabled={!state.compOn} />
                <AmKnob size="s" value={state.compRatio} min={1} max={20} def={3} unit="x" label="Ratio" title="Ratio" onChange={(v) => patch({ compRatio: v })} disabled={!state.compOn} />
                <AmKnob size="s" value={state.compMakeup} min={0} max={24} def={0} unit="db" label="Makeup" title="Makeup-Gain" onChange={(v) => patch({ compMakeup: v })} disabled={!state.compOn} />
              </div>
              <p className="am-hint" style={{ marginTop: 8 }}>
                Attack/Release/Knee gibt es im V2-Master-Pfad nicht — sie waren hier Attrappen und sind entfernt.
              </p>
            </>
          )}
          {active === 'lim' && (
            <>
              <div className="am-row am-c" style={{ gap: 10, marginTop: 12 }}>
                <AmToggle on={state.limOn} onClick={() => patch({ limOn: !state.limOn })} kind="m" ariaLabel="Limiter ein/aus">
                  {state.limOn ? 'ON' : 'OFF'}
                </AmToggle>
                <AmLed on={state.limOn} color={state.limOn ? 'ok' : 'lock'} size="s" label="Limiter" />
              </div>
              <div className="am-knobs" style={{ marginTop: 10 }}>
                <AmKnob size="s" value={state.limThreshold} min={-30} max={0} def={-6} unit="db" label="Thresh" title="Limiter-Threshold" onChange={(v) => patch({ limThreshold: v })} disabled={!state.limOn} />
                <AmKnob size="s" value={state.limRatio} min={1} max={40} def={20} unit="x" label="Ratio" title="Limiter-Ratio" onChange={(v) => patch({ limRatio: v })} disabled={!state.limOn} />
                <AmKnob size="s" value={state.limCeiling} min={-12} max={0} def={-1} unit="db" label="Ceiling" title="Ausgangs-Obergrenze" onChange={(v) => patch({ limCeiling: v })} disabled={!state.limOn} />
              </div>
            </>
          )}
        </div>
      </AmCard>
    </div>
  );
});
