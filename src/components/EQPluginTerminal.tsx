import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Waves, Power } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { storageGetJson, storageSetJson } from '../utils/storage';
import { MoaAssistant } from './MoaAssistant';

/**
 * audioMONASTRY 36-Band-Equalizer (Para-EQ) – UX-Aufwertung
 * ---------------------------------------------------------
 * - ECHTE Frequenzgang-Kurve (RBJ-Biquad-Magnitude, analytisch berechnet)
 * - Präzise Vertikal-Fader (Drag/Wheel/Pfeiltasten/Doppelklick-Reset)
 * - Q-Regler als Drehknopf (Drag/Wheel/Doppelklick)
 * - Presets, Bypass (wirkt auf die Engine), Persistenz (localStorage)
 */

const BAND_COUNT = 36;

const BANDS = Array.from({ length: BAND_COUNT }, (_, i) => {
  const freq = Math.round(20 * Math.pow(10, (i * 3) / 35));
  const label = freq < 1000 ? `${freq}Hz` : `${(freq / 1000).toFixed(1).replace(/\.0$/, '')}kHz`;
  return { freq, label, type: 'BAND' };
});

const PRESETS_12: Record<string, { label: string; gains: number[] }> = {
  FLAT:    { label: 'Flat',      gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  'BASS+': { label: 'Bass+',     gains: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
  SUB:     { label: 'Sub',       gains: [8, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  VOCAL:   { label: 'Vocal',     gains: [-2, -2, 0, 1, 2, 3, 2, 1, 0, 1, 2, 1] },
  BRIGHT:  { label: 'Bright',    gains: [0, 0, 0, -1, -1, 0, 1, 2, 3, 4, 4, 3] },
  WARM:    { label: 'Warm',      gains: [2, 2, 1, 0, -1, -1, 0, 0, 0, -1, -1, -1] },
  LOUD:    { label: 'Loudness',  gains: [4, 3, 2, 1, 1, 1, 2, 3, 3, 2, 1, 1] },
  SMART:   { label: 'AI-Smart',  gains: [1, 2, 2, 1, 0, -1, 0, 1, 2, 2, 1, 1] },
};

/** Expandiert ein 12-Punkt-Preset auf 36 Bänder (nächster Nachbar). */
const expandGains = (g12: number[]): number[] =>
  BANDS.map((_, i) => g12[Math.min(g12.length - 1, Math.round((i * (g12.length - 1)) / (BAND_COUNT - 1)))]);

const PRESETS: Record<string, { label: string; gains: number[] }> = Object.fromEntries(
  Object.entries(PRESETS_12).map(([k, v]) => [k, { label: v.label, gains: expandGains(v.gains) }]),
);

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const round01 = (v: number) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// RBJ-Biquad-Magnitude (identisch zur eqProcessor-Koeffizientenberechnung)
// ---------------------------------------------------------------------------

interface Biquad { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number; }

function rbjCoeffs(type: 'lowshelf' | 'highshelf' | 'peaking', gainDb: number, f0: number, q: number, fs: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(0.1, q));
  const sqA = Math.sqrt(A);

  if (type === 'peaking') {
    return {
      b0: 1 + alpha * A, b1: -2 * cos, b2: 1 - alpha * A,
      a0: 1 + alpha / A, a1: -2 * cos, a2: 1 - alpha / A,
    };
  }
  if (type === 'lowshelf') {
    return {
      b0: A * ((A + 1) - (A - 1) * cos + 2 * sqA * alpha),
      b1: 2 * A * ((A - 1) - (A + 1) * cos),
      b2: A * ((A + 1) - (A - 1) * cos - 2 * sqA * alpha),
      a0: (A + 1) + (A - 1) * cos + 2 * sqA * alpha,
      a1: -2 * ((A - 1) + (A + 1) * cos),
      a2: (A + 1) + (A - 1) * cos - 2 * sqA * alpha,
    };
  }
  return {
    b0: A * ((A + 1) + (A - 1) * cos + 2 * sqA * alpha),
    b1: -2 * A * ((A - 1) + (A + 1) * cos),
    b2: A * ((A + 1) + (A - 1) * cos - 2 * sqA * alpha),
    a0: (A + 1) - (A - 1) * cos + 2 * sqA * alpha,
    a1: 2 * ((A - 1) - (A + 1) * cos),
    a2: (A + 1) - (A - 1) * cos - 2 * sqA * alpha,
  };
}

function biquadDb(c: Biquad, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const cos2W = Math.cos(2 * w);
  const sin2W = Math.sin(2 * w);
  const reN = c.b0 + c.b1 * cosW + c.b2 * cos2W;
  const imN = -(c.b1 * sinW + c.b2 * sin2W);
  const reD = c.a0 + c.a1 * cosW + c.a2 * cos2W;
  const imD = -(c.a1 * sinW + c.a2 * sin2W);
  const mag2 = (reN * reN + imN * imN) / Math.max(1e-12, reD * reD + imD * imD);
  return 20 * Math.log10(Math.sqrt(mag2));
}

function combinedResponseDb(gains: number[], qs: number[], f: number, fs = 48000): number {
  let db = 0;
  for (let i = 0; i < BANDS.length; i++) {
    const type: 'lowshelf' | 'highshelf' | 'peaking' =
      i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
    db += biquadDb(rbjCoeffs(type, gains[i], BANDS[i].freq, qs[i], fs), f, fs);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Bedienelemente
// ---------------------------------------------------------------------------

function VFader({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const fromClientY = (clientY: number) => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const ratio = clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
    return round01(ratio * 24 - 12);
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="EQ-Gain"
      aria-valuemin={-12}
      aria-valuemax={12}
      aria-valuenow={value}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        setDragging(true);
        onChange(fromClientY(e.clientY));
      }}
      onPointerMove={(e) => { if (dragging) onChange(fromClientY(e.clientY)); }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onWheel={(e) => { if (!disabled) onChange(clamp(round01(value - Math.sign(e.deltaY) * 0.5), -12, 12)); }}
      onDoubleClick={() => { if (!disabled) onChange(0); }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'ArrowUp') onChange(clamp(round01(value + 0.5), -12, 12));
        if (e.key === 'ArrowDown') onChange(clamp(round01(value - 0.5), -12, 12));
        if (e.key === '0') onChange(0);
      }}
      className={`relative h-36 short-landscape:h-24 w-9 rounded-md border border-neutral-800 bg-black/70 shadow-inner select-none touch-none ${disabled ? 'opacity-40' : 'cursor-ns-resize hover:border-teal-500/50'}`}
    >
      {/* Skala */}
      <div className="absolute left-1/2 top-1/2 w-full -translate-x-1/2 -translate-y-1/2 pointer-events-none">
        {[-12, -6, 0, 6, 12].map((g) => (
          <div
            key={g}
            className="absolute left-0 w-full flex items-center gap-1"
            style={{ top: `${((12 - g) / 24) * 100}%` }}
          >
            <span className="w-2 h-px bg-neutral-700" />
            <span className="text-[6px] text-neutral-600 font-mono">{g > 0 ? '+' : ''}{g}</span>
          </div>
        ))}
      </div>
      {/* Thumb */}
      <div
        className="absolute left-0.5 right-0.5 h-5 rounded-sm bg-linear-to-b from-neutral-600 to-neutral-800 border border-neutral-500 pointer-events-none flex items-center justify-center shadow-lg"
        style={{ bottom: `${((value + 12) / 24) * 100}%`, transform: 'translateY(50%)' }}
      >
        <div className="w-4 h-0.5 bg-teal-400 shadow-[0_0_6px_rgba(45,212,191,0.9)] rounded-full" />
      </div>
    </div>
  );
}

function QKnob({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const [dragging, setDragging] = useState(false);
  const deg = (value - 1) * 60; // 1 = Mitte

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="EQ-Q"
      aria-valuemin={0.1}
      aria-valuemax={6}
      aria-valuenow={value}
      title={`Q ${value.toFixed(2)} · Doppelklick = Reset`}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const dy = -e.movementY;
        onChange(clamp(round01(value + dy * 0.05), 0.1, 6));
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onWheel={(e) => { if (!disabled) onChange(clamp(round01(value - Math.sign(e.deltaY) * 0.2), 0.1, 6)); }}
      onDoubleClick={() => { if (!disabled) onChange(1); }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'ArrowUp') onChange(clamp(round01(value + 0.2), 0.1, 6));
        if (e.key === 'ArrowDown') onChange(clamp(round01(value - 0.2), 0.1, 6));
      }}
      className={`relative w-8 h-8 rounded-full border-2 border-neutral-700 bg-neutral-800 select-none touch-none ${disabled ? 'opacity-40' : 'cursor-ns-resize hover:border-teal-400/60'}`}
    >
      <div
        className="absolute left-1/2 top-1/2 w-0.5 h-3 bg-teal-300 rounded-full pointer-events-none"
        style={{ transform: `translate(-50%, -100%) rotate(${deg}deg)`, transformOrigin: '50% 100%' }}
      />
      <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 rounded-full bg-teal-400 -translate-x-1/2 -translate-y-1/2 pointer-events-none" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export const EQPluginTerminal = React.memo(function EQPluginTerminal() {
  const { state, lockStatus, updateState } = usePluginState('eq', 'PRO');
  const lockedByOther = lockStatus.active && lockStatus.lockedBy !== 'localUser';

  const [power, setPower] = useState(true);
  const [gainValues, setGainValues] = useState<number[]>(BANDS.map(() => 0));
  const [qValues, setQValues] = useState<number[]>(BANDS.map(() => 1));
  const lastGainsRef = useRef<number[]>(BANDS.map(() => 0));
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const pushEq = (gains: number[], qs: number[]) => {
    audioEngine.updateToneShiftEQ({
      bands: BANDS.map((b, i) => ({
        freq: b.freq,
        gain: gains[i],
        q: qs[i],
        type: i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking',
      })),
    });
  };

  // Persistenz laden + initial anwenden.
  useEffect(() => {
    try {
      const parsed = storageGetJson<{ gains?: number[]; qs?: number[]; power?: boolean }>('eq-state');
      if (parsed) {
        const gains = Array.isArray(parsed.gains) && parsed.gains.length === BAND_COUNT ? parsed.gains.map(Number) : BANDS.map(() => 0);
        const qs = Array.isArray(parsed.qs) && parsed.qs.length === BAND_COUNT ? parsed.qs.map(Number) : BANDS.map(() => 1);
        setGainValues(gains);
        setQValues(qs);
        lastGainsRef.current = gains;
        if (typeof parsed.power === 'boolean') setPower(parsed.power);
        pushEq(gains, qs);
      }
    } catch { /* ignore */ }
     
  }, []);

  // Persistenz speichern.
  useEffect(() => {
    storageSetJson('eq-state', { gains: gainValues, qs: qValues, power });
  }, [gainValues, qValues, power]);

  const handleGainChange = (idx: number, gain: number) => {
    setGainValues((prev) => {
      const next = [...prev];
      next[idx] = gain;
      pushEq(next, qValues);
      if (power) lastGainsRef.current = next;
      return next;
    });
  };

  const handleQChange = (idx: number, q: number) => {
    setQValues((prev) => {
      const next = [...prev];
      next[idx] = q;
      pushEq(gainValues, next);
      return next;
    });
  };

  const flatten = () => {
    const flat = BANDS.map(() => 0);
    const flatQ = BANDS.map(() => 1);
    setGainValues(flat);
    setQValues(flatQ);
    lastGainsRef.current = flat;
    pushEq(flat, flatQ);
  };

  const applyPreset = (key: string) => {
    const p = PRESETS[key];
    if (!p) return;
    setGainValues(p.gains);
    lastGainsRef.current = p.gains;
    pushEq(p.gains, qValues);
    if (!power) setPower(true);
  };

  const togglePower = () => {
    if (power) {
      // Bypass: flach an die Engine senden, Zustand merken.
      const flat = BANDS.map(() => 0);
      setGainValues(flat);
      pushEq(flat, qValues);
      setPower(false);
    } else {
      const restore = lastGainsRef.current;
      setGainValues(restore);
      pushEq(restore, qValues);
      setPower(true);
    }
  };

  const handleStateSelect = (s: string) => {
    updateState(s as any);
    if (s === 'OFF') { if (power) togglePower(); }
    else {
      if (!power) togglePower();
      if (s === 'AUTO_AI') applyPreset('SMART');
    }
  };

  // Echte Frequenzgang-Kurve zeichnen.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const dbRange = 18;
    const fMin = 20;
    const fMax = 20000;
    const xOf = (f: number) => (Math.log10(f / fMin) / Math.log10(fMax / fMin)) * w;
    const yOf = (db: number) => h / 2 - (clamp(db, -dbRange, dbRange) / dbRange) * (h / 2);

    ctx.fillStyle = '#0b0d0e';
    ctx.fillRect(0, 0, w, h);

    // dB-Grid
    ctx.lineWidth = 1;
    for (let db = -12; db <= 12; db += 6) {
      ctx.strokeStyle = db === 0 ? '#333' : '#1d1f21';
      ctx.beginPath();
      ctx.moveTo(0, yOf(db));
      ctx.lineTo(w, yOf(db));
      ctx.stroke();
    }

    // Frequenz-Grid (logarithmisch)
    const gridFreqs = [30, 60, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    ctx.fillStyle = '#4a4f54';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    gridFreqs.forEach((f) => {
      const x = xOf(f);
      ctx.strokeStyle = '#1d1f21';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, h - 4);
    });

    if (!power) {
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      return;
    }

    // Kombinierte Kurve (echte Biquad-Antwort).
    ctx.beginPath();
    for (let px = 0; px <= w; px += 2) {
      const f = fMin * Math.pow(fMax / fMin, px / w);
      const db = combinedResponseDb(gainValues, qValues, f);
      const y = yOf(db);
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(45,212,191,0.5)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Flächen-Füllung unter der Kurve.
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(45,212,191,0.22)');
    gradient.addColorStop(1, 'rgba(45,212,191,0)');
    ctx.fillStyle = gradient;
    ctx.fill();
  }, [gainValues, qValues, power]);

  const activeBandGain = useMemo(() => {
    const max = Math.max(...gainValues.map((g) => Math.abs(g)));
    return max.toFixed(1);
  }, [gainValues]);

  return (
    <div className={`w-full h-full flex flex-col bg-[#0d0f10] rounded-xl border ${lockedByOther ? 'border-red-500 opacity-60 grayscale' : 'border-neutral-800'} overflow-hidden text-neutral-300 font-sans shadow-2xl relative`}>
      <div className="px-4 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="eq" placeholder="MOA: z. B. 'Filter-Sweep automatisieren'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-linear-to-r from-teal-900/20 to-[#0d0f10] border-b border-teal-900/30 gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-teal-500/20 flex items-center justify-center border border-teal-500/50 shadow-[0_0_15px_rgba(20,184,166,0.3)]">
            <Waves className="w-5 h-5 text-teal-400" />
          </div>
          <div>
            <h2 className="text-lg font-black tracking-widest text-neutral-100 uppercase leading-none">Equalizer</h2>
            <p className="text-[9px] font-mono text-teal-400/80 tracking-widest mt-0.5">
              {power ? `12-BAND · PEAK ${activeBandGain} dB` : 'BYPASS'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Presets */}
          <div className="flex items-center gap-1 p-1 rounded bg-black border border-neutral-800">
            {Object.entries(PRESETS).map(([key, p]) => (
              <button type="button"
                key={key}
                onClick={() => applyPreset(key)}
                disabled={lockedByOther}
                title={`Preset ${p.label}`}
                className="px-2 py-1 rounded text-[8px] font-bold tracking-widest text-neutral-400 hover:text-teal-300 hover:bg-teal-500/10 cursor-pointer transition-colors disabled:opacity-40"
              >
                {p.label}
              </button>
            ))}
          </div>

          <button type="button"
            onClick={flatten}
            disabled={lockedByOther}
            title="Alle Bänder auf 0 dB / Q 1"
            className="px-3 py-1.5 rounded border border-neutral-700 bg-black text-[10px] font-mono font-bold text-neutral-400 hover:text-teal-300 hover:border-teal-500/50 cursor-pointer transition-colors disabled:opacity-40"
          >FLAT</button>

          <select
            value={state}
            onChange={(e) => handleStateSelect(e.target.value)}
            disabled={lockedByOther}
            className="bg-black text-white text-xs p-1 rounded border border-neutral-800 focus:outline-none cursor-pointer"
          >
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
          </select>

          <button type="button"
            onClick={togglePower}
            disabled={lockedByOther}
            aria-label={power ? 'EQ deaktivieren' : 'EQ aktivieren'}
            className={`w-11 h-11 rounded-full border-2 flex items-center justify-center transition-all cursor-pointer disabled:opacity-40 ${power ? 'bg-teal-500 border-teal-600 text-white shadow-[0_0_20px_rgba(20,184,166,0.6)]' : 'bg-[#222] border-[#333] text-neutral-500 hover:bg-[#333]'}`}
          >
            <Power className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className={`flex-1 flex flex-col p-4 short-landscape:p-2 gap-4 short-landscape:gap-2 overflow-hidden transition-opacity duration-300 ${power ? 'opacity-100' : 'opacity-60'}`}>
        {/* Echter Frequenzgang */}
        <div className="h-44 short-landscape:h-28 bg-black rounded-xl border border-neutral-800 shadow-inner p-1.5 relative overflow-hidden">
          <canvas ref={canvasRef} width={900} height={176} className="w-full h-full" />
          <div className="absolute top-2 left-3 bg-black/50 px-2 py-1 rounded text-[9px] font-mono text-teal-500 border border-teal-500/30 pointer-events-none">
            FREQUENZGANG · 20 Hz – 20 kHz · ±18 dB
          </div>
          {!power && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <span className="px-3 py-1 rounded-full border border-neutral-700 text-[10px] font-mono tracking-[0.3em] text-neutral-400">BYPASS</span>
            </div>
          )}
        </div>

        {/* Fader-Bank */}
        <div className="flex-1 min-h-0 overflow-x-auto rounded-xl border border-neutral-800 bg-[#131516] p-3">
          <div className="flex items-start justify-between gap-2 min-w-[780px] h-full">
            {BANDS.map((band, idx) => (
              <div key={idx} className="flex flex-col items-center gap-2 flex-1 min-w-[54px]">
                <div className="text-[8px] font-mono text-neutral-500 uppercase tracking-widest text-center leading-tight">{band.type}</div>

                <VFader value={gainValues[idx]} onChange={(v) => handleGainChange(idx, v)} disabled={lockedByOther || !power} />

                <div className="text-center">
                  <div className={`text-[11px] font-black font-mono ${gainValues[idx] > 0 ? 'text-teal-300' : gainValues[idx] < 0 ? 'text-amber-300' : 'text-neutral-500'}`}>
                    {gainValues[idx] > 0 ? '+' : ''}{gainValues[idx].toFixed(1)}
                  </div>
                  <div className="text-[8px] text-neutral-600 font-mono mt-0.5">{band.label}</div>
                </div>

                <QKnob value={qValues[idx]} onChange={(v) => handleQChange(idx, v)} disabled={lockedByOther || !power} />
                <div className="text-[7px] text-neutral-600 font-mono -mt-1.5">Q {qValues[idx].toFixed(1)}</div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-[8px] font-mono text-neutral-600 -mt-2">
          Fader: Ziehen / Mausrad / Pfeiltasten · Doppelklick = 0 dB · Q-Knopf: Ziehen / Mausrad · Doppelklick = 1.0
        </p>
      </div>
    </div>
  );
});
