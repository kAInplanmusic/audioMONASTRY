/**
 * effectMONK · Rack-Modul (Vorlage public/uidesign/uiübersichtapp.jpg, Zeile 04)
 * =========================================================================
 * Eine Zeile: links Effekt-Auswahl · Mitte Signalkette (Quelle → Algorithmus →
 * Mix → Ausgang, je mit Wert) über dem Scope · rechts XY-Feld + Makro-Regler.
 * Engine: `audioEngine.setEffectParams` (wie bisher). Stand in der Session
 * (`writePluginSettings('effect', …)`).
 */
import React, { useState, useEffect, useRef } from 'react';
import { random } from '../utils/random';
import { DropTarget } from './DropTarget';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { webRTCManager } from '../utils/WebRTCManager';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { AmCard, AmKnob, AmToggle } from './am/amUi';

/** intensity 50 = Preset-Werte unverändert (Stand wie vor dem XY-Feld). */
const DEFAULT_FX = { power: true, activeFx: 'REVERB', wetDry: 50, intensity: 50 };

const FX_LIST = [
  { id: 'DELAY', label: 'TAPE ECHO' },
  { id: 'REVERB', label: 'SPACE HALL' },
  { id: 'FLANGER', label: 'JET FLANGER' },
  { id: 'PHASER', label: 'ANALOG PHASER' },
  { id: 'DISTORTION', label: 'SATURATOR' },
  { id: 'BITCRUSHER', label: 'DECIMATOR' },
  { id: 'CHORUS', label: 'DIMENSION D' },
  { id: 'FILTER', label: 'VCF CUT' },
] as const;

const FX_PRESETS: Record<string, Record<string, number>> = {
  DELAY:      { feedback: 0.45 },
  REVERB:     { feedback: 0.62 },
  FLANGER:    { rate: 0.8, depth: 0.7 },
  PHASER:     { rate: 0.5, depth: 0.6 },
  DISTORTION: { drive: 0.7 },
  BITCRUSHER: { bits: 8, sampleReduction: 8 },
  CHORUS:     { rate: 0.4, depth: 0.5 },
  FILTER:     { depth: 0.6 },
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const opt = (v: number | undefined, f: (x: number) => number) => (v === undefined ? undefined : f(v));

/** Preset-Werte des Algorithmus, skaliert mit der Intensität (50 = 1:1). */
function fxParams(fx: string, intensity: number) {
  const p = FX_PRESETS[fx] ?? {};
  const f = clamp(intensity, 0, 100) / 50;
  return {
    feedback: opt(p.feedback, (v) => clamp(v * f, 0, 0.95)),
    rate: opt(p.rate, (v) => clamp(v * f, 0.02, 4)),
    depth: opt(p.depth, (v) => clamp(v * f, 0, 1)),
    drive: opt(p.drive, (v) => clamp(v * f, 0, 1)),
    bits: opt(p.bits, () => Math.round(16 / (1 + f))),
    sampleReduction: opt(p.sampleReduction, (v) => Math.max(1, Math.round(v * f))),
  };
}

/** Kurzwert für das Algorithmus-Kästchen der Kette. */
function fxValue(fx: string, intensity: number): string {
  const p = fxParams(fx, intensity);
  if (p.feedback !== undefined) return `FB ${Math.round(p.feedback * 100)}%`;
  if (p.drive !== undefined) return `DRIVE ${Math.round(p.drive * 100)}%`;
  if (p.bits !== undefined) return `${p.bits} BIT`;
  if (p.rate !== undefined) return `${p.rate.toFixed(2)} Hz`;
  if (p.depth !== undefined) return `DEPTH ${Math.round(p.depth * 100)}%`;
  return '–';
}

export const FXEngineTerminal = React.memo(function FXEngineTerminal() {
  const { state, lockStatus, updateState } = usePluginState('effect', 'PRO');
  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  // Beständige Plugins: Einstiegsstand = letzter Stand in der Session (applyFx
  // unten schickt ihn beim Öffnen an die Engine).
  const [saved] = useState(() => mergeKnown(DEFAULT_FX, readPluginSettings('effect')));
  const [power, setPower] = useState(saved.power);
  const [activeFx, setActiveFx] = useState(saved.activeFx);
  const [wetDry, setWetDry] = useState(saved.wetDry);
  const [intensity, setIntensity] = useState(saved.intensity);
  useEffect(() => {
    writePluginSettings('effect', { power, activeFx, wetDry, intensity });
  }, [power, activeFx, wetDry, intensity]);
  const [sourceSample, setSourceSample] = useState<AudioSample | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const xyRef = useRef<HTMLDivElement>(null);
  const xyDrag = useRef(false);

  const applyFx = (fx: string, dryWet: number) => {
    // Integrate with AudioEngine's effect parameters
    audioEngine.setEffectParams({
      type: fx,
      wet: dryWet / 100,
      power: power,
      ...fxParams(fx, intensity),
    });
  };

  const handleSampleDrop = (sample: AudioSample) => {
    if (locked) return;
    setSourceSample(sample);
    // Logic for loading sample to effect chain if needed
  };

  const handleFxChange = (fx: string) => {
    setActiveFx(fx);
    applyFx(fx, wetDry);
  };

  useEffect(() => {
    applyFx(activeFx, wetDry);
// eslint-disable-next-line react-hooks/exhaustive-deps -- bewusst beibehalten (Runde 3, Hook-Deps werden separat auditiert)
  }, [activeFx, wetDry, power, intensity]);

  // Visualizer loop (Farbe = Modulfarbe des Streifens).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const color = getComputedStyle(canvas).getPropertyValue('--c').trim() || '#f43f5e';

    let frameId: number;
    let phase = 0;
    const draw = () => { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
      ctx.fillStyle = '#040912';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (power) {
        ctx.beginPath();
        const scale = canvas.height / 120;
        const amplitude = (activeFx === 'REVERB' ? 20 : activeFx === 'DELAY' ? 40 : activeFx === 'DISTORTION' ? 60 : 30) * scale;
        const frequency = activeFx === 'DISTORTION' ? 0.2 : 0.05;

        for (let i = 0; i < canvas.width; i++) {
          const y = canvas.height / 2 +
                    Math.sin(i * frequency + phase) * amplitude * (wetDry/100) * (random() > 0.8 && activeFx === 'BITCRUSHER' ? 0.5 : 1) +
                    (activeFx === 'DISTORTION' ? (random() - 0.5) * 10 * (wetDry/100) : 0);

          if (i === 0) ctx.moveTo(i, y);
          else ctx.lineTo(i, y);
        }

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 8;
        ctx.shadowColor = color;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      phase -= 0.1;
      frameId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(frameId);
  }, [power, activeFx, wetDry]);

  /** XY-Feld: X = Dry↔Wet, Y = Intensität. */
  const xyAt = (clientX: number, clientY: number) => {
    const el = xyRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setWetDry(Math.round(clamp((clientX - r.left) / r.width, 0, 1) * 100));
    setIntensity(Math.round(clamp(1 - (clientY - r.top) / r.height, 0, 1) * 100));
  };

  const fxLabel = FX_LIST.find((f) => f.id === activeFx)?.label ?? activeFx;
  const disabled = locked || !power;

  return (
    <div className="am-rackrow am-fx" style={locked ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="fx" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />

      <AmCard title="FX-Auswahl" style={{ width: 190 }}>
        <div className="am-fxl" role="group" aria-label="Effekt-Algorithmus">
          {FX_LIST.map((fx) => (
            <button type="button" key={fx.id} className={activeFx === fx.id ? 'am-on' : ''} aria-pressed={activeFx === fx.id}
              disabled={locked} onClick={() => handleFxChange(fx.id)}>
              <i />{fx.label}
            </button>
          ))}
        </div>
      </AmCard>

      <AmCard title="Signalkette" style={{ flex: 1, minWidth: 'min(420px, 100%)' }}
        right={<span className="am-vb" style={{ color: power ? 'var(--ok)' : 'var(--hot)' }}>{power ? 'ACTIVE' : 'BYPASS'}</span>}>
        <div className="am-fxchain">
          <DropTarget label="Drop Sample to FX" onDrop={handleSampleDrop} className="am-fxbox am-fxsrc">
            <span className="am-lbl">Quelle</span>
            <b title={sourceSample?.name}>{sourceSample ? sourceSample.name : 'MASTER BUS'}</b>
            <small>Sample hierher ziehen</small>
          </DropTarget>
          <span className="am-fxarr">→</span>
          <div className={`am-fxbox ${power ? 'am-on' : ''}`}>
            <span className="am-lbl">Algorithmus</span>
            <b>{fxLabel}</b>
            <small className="am-mono">{fxValue(activeFx, intensity)}</small>
          </div>
          <span className="am-fxarr">→</span>
          <div className="am-fxbox">
            <span className="am-lbl">Mix</span>
            <b className="am-mono">{wetDry}%</b>
            <small>Dry ↔ Wet</small>
          </div>
          <span className="am-fxarr">→</span>
          <button type="button" className={`am-fxbox ${power ? 'am-on' : ''}`} onClick={() => setPower(!power)} disabled={locked}
            aria-pressed={power} title={power ? 'Effekt umgehen (Bypass)' : 'Effekt einschalten'}>
            <span className="am-lbl">Ausgang</span>
            <b>{power ? 'ACTIVE' : 'BYPASS'}</b>
            <small>zum Main</small>
          </button>
        </div>
        <canvas data-live-value="fx-scope" ref={canvasRef} width={600} height={64} className="am-cv am-fxscope" />
      </AmCard>

      <AmCard title="XY" style={{ width: 170 }}>
        <div
          ref={xyRef}
          className={`am-fxxy ${disabled ? 'am-boff' : ''}`}
          role="group"
          aria-label={`XY-Feld: Mix ${wetDry} %, Intensität ${intensity} %`}
          onPointerDown={(e) => {
            if (disabled) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            xyDrag.current = true;
            xyAt(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => { if (xyDrag.current) xyAt(e.clientX, e.clientY); }}
          onPointerUp={() => { xyDrag.current = false; }}
          onPointerCancel={() => { xyDrag.current = false; }}
        >
          <span className="am-fxxy-x">MIX →</span>
          <span className="am-fxxy-y">INTENS. →</span>
          <b style={{ left: `${wetDry}%`, top: `${100 - intensity}%` }} />
        </div>
      </AmCard>

      <AmCard title="Makro" style={{ width: 170 }}>
        <div className="am-knobs">
          <AmKnob value={wetDry} min={0} max={100} def={50} unit="int" label="Mix %" title="Wet / Dry" disabled={disabled}
            onChange={(v) => setWetDry(Math.round(v))} />
          <AmKnob value={intensity} min={0} max={100} def={50} unit="int" gold label="Intens." title="Intensität (Feedback/Rate/Tiefe/Drive)" disabled={disabled}
            onChange={(v) => setIntensity(Math.round(v))} />
        </div>
        <AmToggle on={power} onClick={() => setPower(!power)} disabled={locked} ariaLabel={power ? 'Effekt umgehen' : 'Effekt einschalten'}>
          {power ? 'FX AN' : 'BYPASS'}
        </AmToggle>
      </AmCard>
    </div>
  );
});
