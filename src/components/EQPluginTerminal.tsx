import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePluginState } from '../hooks/usePluginState';
import { audioEngine } from '../utils/audioEngine';
import { readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { MoaAssistant } from './MoaAssistant';
import { webRTCManager } from '../utils/WebRTCManager';
import { AmCard, AmKnob, AmSeg, AmToggle } from './am/amUi';

/**
 * eqMONK · Rack-Modul (Vorlage public/uidesign/uiübersichtapp.jpg, Zeile 13)
 * =========================================================================
 * 36-Band-Para-EQ in einer kompakten Zeile:
 * - links Preset · A/B-Vergleich · FLAT · Bypass
 * - Mitte farbige ECHTE Frequenzgang-Kurve (RBJ-Biquad-Magnitude) mit
 *   Bandpunkten über dem Analyzer (Fan-out-Tap am Ausgang), darunter die
 *   36 Mini-Fader (Ziehen/Mausrad/Pfeiltasten/Doppelklick = 0 dB)
 * - rechts Werte des gewählten Bands (Gain, Q, Typ)
 * Stand in der Session (`writePluginSettings('eq', …)`).
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


type BandType = 'lowshelf' | 'highshelf' | 'peaking';
const bandType = (i: number): BandType => (i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking');
const BAND_TYPE_LABEL: Record<BandType, string> = { lowshelf: 'Low-Shelf', highshelf: 'High-Shelf', peaking: 'Glocke' };

/** Koeffizienten aller Bänder einmal je Änderung berechnen. */
function bandCoeffs(gains: number[], qs: number[], fs = 48000): Biquad[] {
  return BANDS.map((b, i) => rbjCoeffs(bandType(i), gains[i], b.freq, qs[i], fs));
}

function responseDb(coeffs: Biquad[], f: number, fs = 48000): number {
  let db = 0;
  for (const c of coeffs) db += biquadDb(c, f, fs);
  return db;
}

// ---------------------------------------------------------------------------
// Kurven-Geometrie
// ---------------------------------------------------------------------------

const CV_W = 900;
const CV_H = 130;
const F_MIN = 20;
const F_MAX = 20000;
const DB_RANGE = 18;
const CURVE_STEP = 3;
const xOf = (f: number) => (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * CV_W;
const fOf = (x: number) => F_MIN * Math.pow(F_MAX / F_MIN, clamp(x, 0, CV_W) / CV_W);
const yOf = (db: number) => CV_H / 2 - (clamp(db, -DB_RANGE, DB_RANGE) / DB_RANGE) * (CV_H / 2);
/** Farbe eines Bands (Regenbogen über das Spektrum). */
const bandHue = (i: number) => (190 + (i * 200) / (BAND_COUNT - 1)) % 360;
const GRID_FREQS = [30, 60, 100, 200, 500, 1000, 2000, 5000, 10000];

/** Nächstes Band zu einer Frequenz (logarithmischer Abstand). */
function nearestBand(f: number): number {
  let best = 0;
  let bestD = Infinity;
  BANDS.forEach((b, i) => {
    const d = Math.abs(Math.log(b.freq / f));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Bedienelemente
// ---------------------------------------------------------------------------

function VFader({ value, onChange, disabled, selected, onSelect, label, hue }: {
  value: number; onChange: (v: number) => void; disabled?: boolean; selected?: boolean; onSelect: () => void; label: string; hue: number;
}) {
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
      aria-valuetext={`${label} ${value > 0 ? '+' : ''}${value.toFixed(1)} dB`}
      title={`${label} · ${value > 0 ? '+' : ''}${value.toFixed(1)} dB · Doppelklick = 0 dB`}
      onFocus={onSelect}
      onPointerDown={(e) => {
        onSelect();
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
      className={`am-eqf ${selected ? 'am-on' : ''} ${disabled ? 'am-boff' : ''}`}
      style={{ ['--n' as string]: (value + 12) / 24, ['--bh' as string]: `hsl(${hue} 85% 62%)` }}
    >
      <i />
      <b />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

type AbStore = { gains: number[]; qs: number[] };
const isBandArray = (v: unknown): v is unknown[] => Array.isArray(v) && v.length === BAND_COUNT;

export const EQPluginTerminal = React.memo(function EQPluginTerminal() {
  const { state, lockStatus, updateState } = usePluginState('eq', 'PRO');
  const lockedByOther = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;

  // Persistenz einmalig beim ersten Rendern laden – keine setState-Aufrufe im Effect.
  const [loadedEqState] = useState(() => {
    try {
      const parsed = readPluginSettings<{
        gains?: number[]; qs?: number[]; power?: boolean;
        ab?: { slot?: unknown; other?: { gains?: unknown; qs?: unknown } | null };
      }>('eq', { legacyKey: 'eq-state' });
      if (parsed) {
        const gains = Array.isArray(parsed.gains) && parsed.gains.length === BAND_COUNT ? parsed.gains.map(Number) : BANDS.map(() => 0);
        const qs = Array.isArray(parsed.qs) && parsed.qs.length === BAND_COUNT ? parsed.qs.map(Number) : BANDS.map(() => 1);
        const o = parsed.ab?.other;
        const other: AbStore | null = o && isBandArray(o.gains) && isBandArray(o.qs)
          ? { gains: o.gains.map(Number), qs: o.qs.map(Number) } : null;
        const slot: 'A' | 'B' = parsed.ab?.slot === 'B' ? 'B' : 'A';
        return { gains, qs, power: typeof parsed.power === 'boolean' ? parsed.power : true, slot, other };
      }
    } catch { /* ignore */ }
    return null;
  });
  const [power, setPower] = useState(loadedEqState?.power ?? true);
  const [gainValues, setGainValues] = useState<number[]>(loadedEqState?.gains ?? BANDS.map(() => 0));
  const [qValues, setQValues] = useState<number[]>(loadedEqState?.qs ?? BANDS.map(() => 1));
  // A/B-Vergleich: aktiver Slot + Stand des anderen Slots (beides in der Session).
  const [abSlot, setAbSlot] = useState<'A' | 'B'>(loadedEqState?.slot ?? 'A');
  const [abOther, setAbOther] = useState<AbStore | null>(loadedEqState?.other ?? null);
  // Gewähltes Band (nur Ansicht).
  const [sel, setSel] = useState(0);
  const lastGainsRef = useRef<number[]>(loadedEqState?.gains ?? BANDS.map(() => 0));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasDrag = useRef(false);

  const pushEq = (gains: number[], qs: number[]) => {
    audioEngine.updateToneShiftEQ({
      bands: BANDS.map((b, i) => ({
        freq: b.freq,
        gain: gains[i],
        q: qs[i],
        type: bandType(i),
      })),
    });
  };

  // Geladene Werte genau einmal an die Engine pushen (Side-Effekt, kein setState).
  const didInitPushRef = useRef(false);
  useEffect(() => {
    if (didInitPushRef.current) return;
    didInitPushRef.current = true;
    pushEq(gainValues, qValues);
  }, [gainValues, qValues]);

  // Persistenz speichern.
  useEffect(() => {
    // Beständige Plugins: Stand an die Session (der nächste Halter startet damit).
    writePluginSettings('eq', { gains: gainValues, qs: qValues, power, ab: { slot: abSlot, other: abOther } });
  }, [gainValues, qValues, power, abSlot, abOther]);

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

  /** A/B: aktuellen Stand parken, anderen Slot laden (erster Wechsel = Kopie). */
  const switchAb = (slot: 'A' | 'B') => {
    if (slot === abSlot || !power) return;
    const current: AbStore = { gains: gainValues, qs: qValues };
    const next = abOther ?? current;
    setAbOther(current);
    setAbSlot(slot);
    setGainValues(next.gains);
    setQValues(next.qs);
    lastGainsRef.current = next.gains;
    pushEq(next.gains, next.qs);
  };

  // Kurve (echte Biquad-Antwort) nur bei Änderung neu berechnen.
  const curve = useMemo(() => {
    const coeffs = bandCoeffs(gainValues, qValues);
    const pts: number[] = [];
    for (let px = 0; px <= CV_W; px += CURVE_STEP) pts.push(responseDb(coeffs, fOf(px)));
    const bandDb = BANDS.map((b) => responseDb(coeffs, b.freq));
    return { pts, bandDb };
  }, [gainValues, qValues]);

  // Zeichenstand für die rAF-Schleife (Refs, damit die Schleife nicht neu startet).
  const drawRef = useRef({ curve, power, sel });
  useEffect(() => { drawRef.current = { curve, power, sel }; }, [curve, power, sel]);

  // Analyzer + Kurve + Bandpunkte zeichnen (~30 fps, nur sichtbar).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const color = getComputedStyle(canvas).getPropertyValue('--c').trim() || '#2dd4bf';
    const w = CV_W;
    const h = CV_H;
    let analyser: AnalyserNode | null = null;
    let bins: Uint8Array<ArrayBuffer> | null = null;
    let lastTap = -Infinity;
    let last = 0;
    let raf = 0;

    const stroke = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i < BAND_COUNT; i += 5) stroke.addColorStop(xOf(BANDS[i].freq) / w, `hsl(${bandHue(i)} 90% 62%)`);
    stroke.addColorStop(1, `hsl(${bandHue(BAND_COUNT - 1)} 90% 62%)`);

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 33 || !canvas.offsetWidth) return;
      last = now;
      const { curve: cv, power: on, sel: s } = drawRef.current;

      ctx.fillStyle = '#040912';
      ctx.fillRect(0, 0, w, h);

      // Raster
      ctx.lineWidth = 1;
      for (let db = -12; db <= 12; db += 6) {
        ctx.strokeStyle = db === 0 ? '#1d3360' : '#0f1d3a';
        ctx.beginPath(); ctx.moveTo(0, yOf(db)); ctx.lineTo(w, yOf(db)); ctx.stroke();
      }
      ctx.fillStyle = '#445a82';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      GRID_FREQS.forEach((f) => {
        const x = xOf(f);
        ctx.strokeStyle = '#0f1d3a';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, h - 3);
      });

      // Analyzer (Fan-out-Tap am Ausgang; ohne Wiedergabe kein Tap).
      if (!analyser && now - lastTap > 2000) {
        lastTap = now;
        analyser = audioEngine.createVisualAnalyser(2048);
        if (analyser) bins = new Uint8Array(analyser.frequencyBinCount);
      }
      if (analyser && bins) {
        analyser.getByteFrequencyData(bins);
        const binHz = analyser.context.sampleRate / analyser.fftSize;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let px = 0; px <= w; px += CURVE_STEP) {
          const bin = Math.min(bins.length - 1, Math.max(1, Math.round(fOf(px) / binHz)));
          ctx.lineTo(px, h - (bins[bin] / 255) * h * 0.92);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = 'rgba(110,150,255,0.16)';
        ctx.fill();
      }

      if (!on) {
        ctx.strokeStyle = '#24406f';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
        return;
      }

      // Kurve + Fläche
      ctx.beginPath();
      cv.pts.forEach((db, k) => { const x = k * CURVE_STEP; const y = yOf(db); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.save();
      ctx.lineTo(w, h / 2); ctx.lineTo(0, h / 2); ctx.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      cv.pts.forEach((db, k) => { const x = k * CURVE_STEP; const y = yOf(db); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Bandpunkte
      BANDS.forEach((b, i) => {
        const x = xOf(b.freq);
        const y = yOf(cv.bandDb[i]);
        ctx.beginPath();
        ctx.arc(x, y, i === s ? 6 : 3, 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${bandHue(i)} 90% 62%)`;
        ctx.fill();
        if (i === s) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      });
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      if (analyser) audioEngine.disconnectVisualAnalyser(analyser);
    };
  }, []);

  /** Kurve anfassen: nächstes Band wählen, Gain per Höhe setzen. */
  const canvasAt = (e: React.PointerEvent<HTMLCanvasElement>, pick: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * CV_W;
    const y = ((e.clientY - r.top) / r.height) * CV_H;
    const idx = pick ? nearestBand(fOf(x)) : sel;
    if (pick) setSel(idx);
    if (lockedByOther || !power) return;
    handleGainChange(idx, clamp(round01(((CV_H / 2 - y) / (CV_H / 2)) * DB_RANGE), -12, 12));
  };

  const activeBandGain = useMemo(() => {
    const max = Math.max(...gainValues.map((g) => Math.abs(g)));
    return max.toFixed(1);
  }, [gainValues]);

  const band = BANDS[sel];
  const faderOff = lockedByOther || !power;

  return (
    <div className="am-rackrow am-eq" style={lockedByOther ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="eq" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />

      <AmCard title="Preset" style={{ width: 170 }}>
        <select className="am-sel" aria-label="EQ-Preset" value="" disabled={lockedByOther}
          onChange={(e) => applyPreset(e.target.value)}>
          <option value="">Preset laden …</option>
          {Object.entries(PRESETS).map(([key, p]) => <option key={key} value={key}>{p.label}</option>)}
        </select>
        <div className="am-eqrow">
          <AmSeg label="A/B-Vergleich" value={abSlot} options={[['A', 'A'], ['B', 'B']] as const}
            onChange={switchAb} disabled={lockedByOther || !power} />
          <button type="button" className="am-btn am-eqflat" onClick={flatten} disabled={lockedByOther} title="Alle Bänder auf 0 dB / Q 1">FLAT</button>
        </div>
        <AmToggle on={power} onClick={togglePower} disabled={lockedByOther} ariaLabel={power ? 'EQ deaktivieren' : 'EQ aktivieren'}>
          {power ? 'EQ AN' : 'BYPASS'}
        </AmToggle>
        <span className="am-hint am-mono">{power ? `36 Bänder · Peak ${activeBandGain} dB` : 'BYPASS'}</span>
      </AmCard>

      <AmCard title="Frequenzgang · 20 Hz – 20 kHz" style={{ flex: 1, minWidth: 'min(460px, 100%)' }}
        right={<span className="am-vb">±18 dB</span>}>
        <canvas
          ref={canvasRef}
          width={CV_W}
          height={CV_H}
          className="am-cv am-eqcv"
          aria-label="EQ-Kurve: Band antippen und ziehen"
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            canvasDrag.current = true;
            canvasAt(e, true);
          }}
          onPointerMove={(e) => { if (canvasDrag.current) canvasAt(e, false); }}
          onPointerUp={() => { canvasDrag.current = false; }}
          onPointerCancel={() => { canvasDrag.current = false; }}
        />
        <div className="am-eqbank" role="group" aria-label="36 Band-Fader">
          {BANDS.map((b, idx) => (
            <VFader key={idx} label={b.label} hue={bandHue(idx)} value={gainValues[idx]} selected={idx === sel} onSelect={() => setSel(idx)}
              onChange={(v) => handleGainChange(idx, v)} disabled={faderOff} />
          ))}
        </div>
      </AmCard>

      <AmCard title="Band" style={{ width: 180 }} right={<span className="am-vb">{sel + 1}/{BAND_COUNT}</span>}>
        <div className="am-eqband">
          <b className="am-mono" style={{ color: `hsl(${bandHue(sel)} 90% 66%)` }}>{band.label}</b>
          <span className="am-lbl">{BAND_TYPE_LABEL[bandType(sel)]}</span>
        </div>
        <div className="am-knobs">
          <AmKnob value={gainValues[sel]} min={-12} max={12} def={0} unit="db" label="Gain dB" title="Band-Gain" disabled={faderOff}
            onChange={(v) => handleGainChange(sel, clamp(round01(v), -12, 12))} />
          <AmKnob value={qValues[sel]} min={0.1} max={6} def={1} log unit="raw" display={qValues[sel].toFixed(1)} label="Q" title="Band-Q" gold disabled={faderOff}
            onChange={(v) => handleQChange(sel, clamp(round01(v), 0.1, 6))} />
        </div>
        <span className="am-hint">Kurve ziehen · Fader: Mausrad/Pfeile · Doppelklick = 0</span>
      </AmCard>
    </div>
  );
});
