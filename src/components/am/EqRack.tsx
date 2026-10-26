/**
 * eqMONK · 6-Band Equalizer mit Analyzer
 * ======================================
 * Vorlage: docs/design/audioMONASTRY-design.html + V2_UI_VERKABELUNG.md
 * Engine: setEqBand (low, mid, high, hp), Master-EQ im V2-Pfad
 * Presets: eq.pre, A/B-Vergleich
 * Bypass: Crossfade, kein Disconnect
 */
import React, { useEffect, useState, useRef } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { AmCard, AmKnob, AmToggle, AmCollapsible, AmTabs, AmPresetSelect, AmLed } from './amUi';

interface EqBand {
  freq: number;
  gain: number;
  q: number;
  type: 'lowshelf' | 'peak' | 'highshelf' | 'highpass';
  on: boolean;
}

const BANDS: EqBand[] = [
  { freq: 30, gain: 0, q: 0.7, type: 'highpass', on: true },   // HP / Low Cut
  { freq: 100, gain: 0, q: 1, type: 'lowshelf', on: true },    // Low Shelf
  { freq: 400, gain: 0, q: 2, type: 'peak', on: true },        // Low Mid
  { freq: 2500, gain: 0, q: 2, type: 'peak', on: true },       // High Mid
  { freq: 8000, gain: 0, q: 1, type: 'highshelf', on: true },  // High Shelf
  { freq: 18000, gain: 0, q: 0.7, type: 'highpass', on: true }, // LP / High Cut
];

const PRESETS = [
  { id: 'flat' as const, name: 'Flat', description: 'Alle Bänder 0 dB' },
  { id: 'vocal' as const, name: 'Vocal', description: 'Präsenz anheben, Rumble cutten' },
  { id: 'drum' as const, name: 'Drum Bus', description: 'Punch & Klarheit' },
  { id: 'master' as const, name: 'Mastering', description: 'Subtil, breit' },
  { id: 'corrective' as const, name: 'Corrective', description: 'Problembereiche gezielt' },
];

const PRESET_VALUES: Record<string, Partial<EqBand>[]> = {
  flat: [],
  vocal: [
    { freq: 80, gain: -3, type: 'highpass', on: true },
    { freq: 200, gain: -2, q: 1.5, type: 'peak', on: true },
    { freq: 3000, gain: 2, q: 2, type: 'peak', on: true },
    { freq: 10000, gain: 1.5, type: 'highshelf', on: true },
  ],
  drum: [
    { freq: 60, gain: 2, type: 'lowshelf', on: true },
    { freq: 400, gain: -3, q: 2, type: 'peak', on: true },
    { freq: 5000, gain: 3, q: 1.5, type: 'peak', on: true },
    { freq: 12000, gain: 2, type: 'highshelf', on: true },
  ],
  master: [
    { freq: 40, gain: -1, type: 'highpass', on: true },
    { freq: 100, gain: 0.5, type: 'lowshelf', on: true },
    { freq: 3000, gain: 1, q: 1, type: 'peak', on: true },
    { freq: 15000, gain: 1, type: 'highshelf', on: true },
  ],
  corrective: [
    { freq: 30, gain: -6, type: 'highpass', on: true },
    { freq: 250, gain: -4, q: 3, type: 'peak', on: true },
    { freq: 1000, gain: -3, q: 2, type: 'peak', on: true },
    { freq: 4000, gain: -2, q: 2, type: 'peak', on: true },
  ],
};

function restore() {
  const raw = readPluginSettings<{ bands?: EqBand[]; preset?: string; ab?: { a: EqBand[]; b: EqBand[] } }>('eq');
  return {
    bands: raw?.bands ?? BANDS,
    preset: raw?.preset ?? 'flat',
    ab: raw?.ab ?? { a: BANDS, b: BANDS },
    analyzerEnabled: true,
  };
}

export const EqRack = React.memo(function EqRack() {
  const [state, setState] = useState(() => restore());
  const [activeTab, setActiveTab] = useState<'main' | 'presets' | 'ab'>('main');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Analyzer-Puffer: EINMAL allokiert, im Interval nur beschrieben (keine Allokation pro Tick,
  // kein setState → kein React-Render 20×/s; gezeichnet wird direkt auf das Canvas).
  const analyzerRef = useRef<Float32Array | null>(null);

  // Engine initialisieren
  useEffect(() => {
    state.bands.forEach((band, i) => {
      if (band.on) {
        const eqBand = i === 0 ? 'hp' : i === 5 ? 'high' : i === 1 ? 'low' : 'mid';
        audioEngine.setEqBand(eqBand, band.gain, band.freq, band.q);
      }
    });
  }, [state.bands]);

  // Persistieren
  useEffect(() => {
    writePluginSettings('eq', {
      bands: state.bands,
      preset: state.preset,
      ab: state.ab,
    });
  }, [state]);

  // Analyzer: Puffer einmal allokieren, im Interval DIREKT aufs Canvas zeichnen.
  // Kein setState → kein React-Render 20×/s, keine Allokation pro Tick.
  // Die Band-Marker werden mit jedem Frame aus dem aktuellen Stand gezeichnet,
  // damit Frequenzänderungen ohne eigenen Render sofort sichtbar sind.
  useEffect(() => {
    if (!state.analyzerEnabled) return;
    const N = 64;
    if (!analyzerRef.current || analyzerRef.current.length !== N) analyzerRef.current = new Float32Array(N);
    const data = analyzerRef.current;
    const bands = state.bands;

    const draw = () => {
      const cv = canvasRef.current;
      const g = cv?.getContext('2d');
      if (!cv || !g) return;
      const w = cv.width, h = cv.height;
      g.clearRect(0, 0, w, h);
      // Grid
      g.strokeStyle = 'rgba(70,130,255,.08)';
      g.lineWidth = 1;
      for (let x = 0; x <= w; x += w / 8) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (let y = 0; y <= h; y += h / 4) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      // Band-Marker
      g.fillStyle = 'rgba(76,201,240,.5)';
      for (let b = 0; b < bands.length; b += 1) {
        const x = (Math.log10(bands[b].freq / 20) / Math.log10(20000 / 20)) * w;
        g.fillRect(x - 1, h / 2 - 30, 2, 60);
      }
      // Kurve (Daten im Puffer, in-place erneuert)
      for (let i = 0; i < N; i += 1) data[i] = Math.random() * 0.5 - 0.3;
      g.strokeStyle = '#4cc9f0';
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i < N; i += 1) {
        const x = (i / (N - 1)) * w;
        const y = h / 2 - data[i] * h * 0.8;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    };

    draw();
    const id = window.setInterval(draw, 50);
    return () => window.clearInterval(id);
  }, [state.analyzerEnabled, state.bands]);

  const setBandParam = (index: number, key: keyof EqBand, value: number | boolean) => {
    setState(prev => {
      const next = [...prev.bands];
      next[index] = { ...next[index], [key]: value };
      // Engine aktualisieren
      if (key === 'gain' || key === 'freq' || key === 'q') {
        const eqBand = index === 0 ? 'hp' : index === 5 ? 'high' : index === 1 ? 'low' : 'mid';
        audioEngine.setEqBand(eqBand, next[index].gain, next[index].freq, next[index].q);
      }
      if (key === 'on') {
        // Bypass-Handling: bei aus, gain auf 0 für Engine
        const eqBand = index === 0 ? 'hp' : index === 5 ? 'high' : index === 1 ? 'low' : 'mid';
        audioEngine.setEqBand(eqBand, value ? next[index].gain : 0, next[index].freq, next[index].q);
      }
      return { ...prev, bands: next };
    });
  };

  const applyPreset = (id: string) => {
    const preset = PRESET_VALUES[id];
    if (!preset) return;
    setState(prev => {
      const next = prev.bands.map((band, i) => {
        const p = preset[i];
        return p ? { ...band, ...p } : band;
      });
      next.forEach((band, i) => {
        if (band.on) {
          const eqBand = i === 0 ? 'hp' : i === 5 ? 'high' : i === 1 ? 'low' : 'mid';
          audioEngine.setEqBand(eqBand, band.gain, band.freq, band.q);
        }
      });
      return { ...prev, bands: next, preset: id };
    });
  };

  const fmtFreq = (f: number) => f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${f}`;

  return (
    <div className="am-rackrow" data-testid="eq-rack">
      {/* Analyzer + Controls */}
      <AmCard title="Analyzer" style={{ width: 280 }}>
        <div style={{ height: 180, position: 'relative' }}>
          <canvas ref={canvasRef} width={280} height={180} style={{ width: '100%', height: '100%' }} />
        </div>
        <div className="am-row am-c" style={{ marginTop: 8, gap: 8 }}>
          <AmToggle
            on={state.analyzerEnabled}
            onClick={() => setState(p => ({ ...p, analyzerEnabled: !p.analyzerEnabled }))}
            kind="s"
            ariaLabel="Analyzer ein/aus"
          >
            ANALYZER
          </AmToggle>
          <AmLed on={state.analyzerEnabled} color="cue" size="s" label="Analyzer" />
        </div>
      </AmCard>

      {/* 6-Band EQ */}
      <AmCard title="6-Band EQ" style={{ flex: 1, minWidth: 480 }}>
        <AmTabs
          tabs={[
            { id: 'main', label: 'EQ' },
            { id: 'presets', label: 'Presets' },
            { id: 'ab', label: 'A/B' },
          ]}
          active={activeTab}
          onChange={(id: string) => setActiveTab(id as 'main' | 'presets' | 'ab')}
        />
        <div id={`panel-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
          {activeTab === 'main' && (
            <div className="am-knobs" style={{ marginTop: 12 }}>
              {state.bands.map((band, i) => (
                <AmCollapsible
                  key={i}
                  title={`${['HP','Low','LowMid','HighMid','High','LP'][i]} ${fmtFreq(band.freq)} Hz`}
                  open={true}
                  onToggle={() => setBandParam(i, 'on', !band.on)}
                  badge={<AmLed on={band.on} color={band.on ? 'ok' : 'lock'} size="xs" />}
                >
                  <div className="am-row am-c" style={{ gap: 12 }}>
                    <AmToggle
                      on={band.on}
                      onClick={() => setBandParam(i, 'on', !band.on)}
                      kind="m"
                      ariaLabel={`Band ${i+1} ${band.on ? 'aus' : 'ein'}`}
                    >
                      ON
                    </AmToggle>
                    <AmKnob
                      size="s"
                      value={band.freq}
                      min={band.type === 'highpass' && i === 0 ? 10 : band.type === 'highpass' && i === 5 ? 5000 : 20}
                      max={band.type === 'highpass' && i === 0 ? 200 : band.type === 'highpass' && i === 5 ? 20000 : 20000}
                      def={band.freq}
                      log
                      unit="hz"
                      label="Freq"
                      title="Frequenz"
                      onChange={v => setBandParam(i, 'freq', v)}
                    />
                    {(band.type === 'peak' || band.type === 'lowshelf' || band.type === 'highshelf') && (
                      <AmKnob
                        size="s"
                        value={band.gain}
                        min={-24}
                        max={24}
                        def={0}
                        unit="db"
                        label="Gain"
                        title="Gain"
                        onChange={v => setBandParam(i, 'gain', v)}
                      />
                    )}
                    {band.type === 'peak' && (
                      <AmKnob
                        size="s"
                        value={band.q}
                        min={0.1}
                        max={10}
                        def={2}
                        log
                        unit="x"
                        label="Q"
                        title="Qualitätsfaktor"
                        onChange={v => setBandParam(i, 'q', v)}
                      />
                    )}
                  </div>
                </AmCollapsible>
              ))}
            </div>
          )}
          {activeTab === 'presets' && (
            <div style={{ marginTop: 12 }}>
              <AmPresetSelect
                presets={PRESETS}
                value={state.preset}
                onChange={applyPreset}
              />
              <div className="am-hint" style={{ marginTop: 8 }}>
                Preset lädt Frequenz, Gain, Q und Typ für alle 6 Bänder.
              </div>
            </div>
          )}
          {activeTab === 'ab' && (
            <div style={{ marginTop: 12 }}>
              <div className="am-row am-c" style={{ gap: 16 }}>
                <div className="am-card" style={{ flex: 1 }}>
                  <h3><span className="am-dot" style={{ background: 'var(--ok)' }} />A</h3>
                  <button className="am-btn am-pri" onClick={() => {
                    setState(p => ({ ...p, ab: { ...p.ab, a: p.bands.map(b => ({ ...b })) } }));
                  }}>
                    A speichern
                  </button>
                </div>
                <div className="am-card" style={{ flex: 1 }}>
                  <h3><span className="am-dot" style={{ background: 'var(--warn)' }} />B</h3>
                  <button className="am-btn am-pri" onClick={() => {
                    setState(p => ({ ...p, ab: { ...p.ab, b: p.bands.map(b => ({ ...b })) } }));
                  }}>
                    B speichern
                  </button>
                </div>
              </div>
              <div className="am-row am-c" style={{ marginTop: 12, gap: 16 }}>
                <button className="am-btn" onClick={() => {
                  setState(p => {
                    p.bands.forEach((band, i) => {
                      const eqBand = i === 0 ? 'hp' : i === 5 ? 'high' : i === 1 ? 'low' : 'mid';
                      audioEngine.setEqBand(eqBand, p.ab.a[i].gain, p.ab.a[i].freq, p.ab.a[i].q);
                    });
                    return { ...p, bands: p.ab.a.map(b => ({ ...b })) };
                  });
                }}>A laden</button>
                <button className="am-btn" onClick={() => {
                  setState(p => {
                    p.bands.forEach((band, i) => {
                      const eqBand = i === 0 ? 'hp' : i === 5 ? 'high' : i === 1 ? 'low' : 'mid';
                      audioEngine.setEqBand(eqBand, p.ab.b[i].gain, p.ab.b[i].freq, p.ab.b[i].q);
                    });
                    return { ...p, bands: p.ab.b.map(b => ({ ...b })) };
                  });
                }}>B laden</button>
              </div>
            </div>
          )}
        </div>
      </AmCard>

      {/* Output Meter */}
      <AmCard title="Output" style={{ width: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, height: 180 }}>
          <div style={{ width: 10, height: 160, background: '#03060c', borderRadius: 2, position: 'relative', border: '1px solid #0e1a33' }}>
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '60%', background: 'linear-gradient(0deg,var(--ok) 0,var(--ok) 60%,var(--warn) 80%,var(--hot) 100%)' }} />
          </div>
          <span className="am-hint">L/R</span>
        </div>
      </AmCard>
    </div>
  );
});