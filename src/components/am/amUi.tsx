/**
 * audioMONASTRY · Bausteine des Designs (docs/design/audioMONASTRY-design.html)
 * ===========================================================================
 * Drehregler, Fader, Taster, Umschalter und Pegel genau wie im Entwurf – als
 * React-Bausteine. Aussehen kommt aus `src/styles/amDesign.css` (Präfix `am-`).
 * Bedienung wie im Entwurf: Regler ziehen (Shift = fein), Doppelklick =
 * Standardwert, Pfeiltasten. Die Bausteine halten keinen eigenen Wert: der
 * kommt immer von außen (Plugin-Stand), damit nichts nur lokal lebt.
 */
import React, { useRef } from 'react';

/* ------------------------------------------------------------------ */
/* Module: Kopfreihenfolge = Nummer = Farbe                             */
/* ------------------------------------------------------------------ */

export interface AmModule {
  id: string;
  /** Kurzname unter dem Kopf-Symbol. */
  short: string;
  /** Untertitel im Streifenkopf. */
  sub: string;
  /** Vorbild-Hardware/-Software. */
  vb: string;
  no: string;
  name: string;
  color: string;
}

const MOD_LIST: [string, string, string, string][] = [
  ['mixer', 'mixer', 'Mischpult · 8 Kanäle in 2 Bänken', 'Pioneer DJM · Ableton Mixer'],
  ['drop', 'drop', 'Drops, Loops und One-Shots auf Pads', 'Roland SP-404'],
  ['song', 'song', 'Songerzeugung und Arrangement', 'Suno Studio · Arrangement'],
  ['effect', 'effect', 'Fünf Send-Effekte', 'Eventide H90 · Pioneer Beat FX'],
  ['syntisampler', 'synth', 'Zwei-Oszillator-Synth mit Step-Sequenzer', 'Moog Subsequent · Dirtywave M8'],
  ['drumsampler', 'drums', 'Drum-Machine, Pads, Smart Drums, Kits', 'Roland TR-808 · MPC'],
  ['instru', 'instru', '50 Instrumente mit Spielflächen', 'NI Kontakt · Smart Instruments'],
  ['biblio', 'biblio', 'Kits, Presets, Loops, Prompts, Takes', 'Ableton Browser · Splice'],
  ['voice', 'voice', 'Text zu Gesang und Sprache', 'Synthesizer V · ElevenLabs'],
  ['sound', 'sound', 'Klänge aus einer Beschreibung', 'ElevenLabs SFX · Output Portal'],
  ['stem', 'stem', 'Song in 5 Stems trennen, Tempo anpassen', 'iZotope RX · Ableton Stems'],
  ['spatial', 'spatial', 'Objekte im Raum platzieren und bewegen', 'Dolby Atmos Panner'],
  ['eq', 'eq', '6-Band-Equalizer mit Analyzer', 'FabFilter Pro-Q'],
  ['dsp', 'dsp', 'Gate, Kompressor, EQ, Limiter, Automation', 'SSL Bus-Comp · Elektron Analog Heat'],
  ['master', 'master', 'Lautheit, Kompressor, Limiter', 'iZotope Ozone · FabFilter Pro-L'],
  ['record', 'record', 'Bit-genaue Aufnahme des Mixes', 'Ableton Resampling'],
];

export const AM_MODULES: readonly AmModule[] = MOD_LIST.map(([id, short, sub, vb], i) => ({
  id,
  short,
  sub,
  vb,
  no: String(i + 1).padStart(2, '0'),
  name: `${id}MONK`,
  color: `hsl(${(i * 22.5 + 11) % 360} 72% 64%)`,
}));

export const AM_MODULE: Readonly<Record<string, AmModule>> = Object.fromEntries(AM_MODULES.map((m) => [m.id, m]));

/** Farbe eines Moduls (Fallback: Cyan). */
export const amColor = (id: string): string => AM_MODULE[id]?.color ?? '#4cc9f0';

export const AM_ICON: Readonly<Record<string, string>> = {
  mixer: 'M6 4v16M12 4v16M18 4v16M4 9h4M10 15h4M16 8h4',
  drop: 'M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z',
  song: 'M9 18V5l10-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  effect: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  syntisampler: 'M2 12c2-8 4-8 6 0s4 8 6 0 4-8 6 0',
  drumsampler: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  instru: 'M3 5h18v14H3zM8 5v8M12 5v8M16 5v8',
  biblio: 'M5 4v16M10 4v16M15 5l4 14',
  voice: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
  sound: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12',
  stem: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  spatial: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  eq: 'M3 17c4 0 4-10 8-10s4 10 8 10h2',
  dsp: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  master: 'M3 12h4l2-6 4 12 2-6h6',
  record: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
};

export const AM_PATH = {
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z',
  unlock: 'M7 11V8a5 5 0 0 1 9.6-2M5 11h14v9H5z',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.1 14H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 20.9 10H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  clip: 'M9 4h6v3H9zM7 6H5v15h14V6h-2M9 12h6M9 16h4',
  board: 'M8 3h8v4H8zM6 5H4v16h16V5h-2',
  stream: 'M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0M12 12v8',
  visual: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  outputs: 'M3 5h12v9H3zM7 18h4M17 8h4v10h-4z',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  unfull: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
} as const;

/** Die vier Nutzerfarben (Reihenfolge des Beitritts). */
export const AM_USER_COLORS = ['#4cc9f0', '#ffb703', '#e879f9', '#a3e635'] as const;

export function AmSvg({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Markenzeichen vor jedem Modulnamen (doppeltes Dreieck). */
export function AmMark() {
  return (
    <svg className="am-mk" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3L3 20h18zM12 9l-4 8h8z" />
    </svg>
  );
}

/** Verlauf der Reglerkappe – einmal pro Seite. */
export function AmDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <radialGradient id="kg" cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="#3a4558" />
          <stop offset="1" stopColor="#0b0f17" />
        </radialGradient>
      </defs>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Werte                                                               */
/* ------------------------------------------------------------------ */

export type AmUnit = 'db' | 'pct' | 'flt' | 'bi' | 'hz' | 'int' | 'x' | 'ms' | 'raw';

export function amFormat(v: number, unit: AmUnit = 'raw'): string {
  switch (unit) {
    case 'db': return (v > 0.05 ? '+' : '') + v.toFixed(Math.abs(v) < 10 ? 1 : 0);
    case 'pct': return `${Math.round(v * 100)}%`;
    case 'flt': return Math.abs(v) < 0.03 ? 'AUS' : `${v < 0 ? 'LP' : 'HP'} ${Math.round(Math.abs(v) * 100)}`;
    case 'bi': return Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`;
    case 'hz': return v >= 1000 ? `${(v / 1000).toFixed(v >= 9950 ? 0 : 1)}k` : `${Math.round(v)}`;
    case 'int': return `${Math.round(v)}`;
    case 'x': return `${v.toFixed(1)}:1`;
    case 'ms': return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(1)}s`;
    default: return v.toFixed(2);
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface Range { min: number; max: number; log?: boolean }
const toNorm = (v: number, r: Range) =>
  r.log ? Math.log(v / r.min) / Math.log(r.max / r.min) : (v - r.min) / (r.max - r.min);
const fromNorm = (n: number, r: Range) => {
  const c = clamp(n, 0, 1);
  return r.log ? r.min * Math.pow(r.max / r.min, c) : r.min + c * (r.max - r.min);
};

/** Tastatur: Pfeile = 5 %, Shift = 1 % (fein), Bild = 20 %. */
function keyStep(e: React.KeyboardEvent): number {
  const k = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 4, PageDown: -4 } as Record<string, number>)[e.key];
  if (!k) return 0;
  return k * (e.shiftKey ? 0.01 : 0.05);
}

/* ------------------------------------------------------------------ */
/* Drehregler                                                          */
/* ------------------------------------------------------------------ */

const ARC = 'M9.39 30.61A15 15 0 1 1 30.61 30.61';
const AL = 70.686;

export interface AmKnobProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** Standardwert (Doppelklick). */
  def?: number;
  log?: boolean;
  unit?: AmUnit;
  label?: string;
  /** Zugänglicher Name, wenn er vom sichtbaren Text abweicht. */
  title?: string;
  size?: '' | 's' | 'xs' | 'l';
  gold?: boolean;
  disabled?: boolean;
  /** Eigene Anzeige statt `amFormat`. */
  display?: string;
}

export const AmKnob = React.memo(function AmKnob({
  value, onChange, min = 0, max = 1, def, log, unit = 'raw', label, title, size = '', gold, disabled, display,
}: AmKnobProps) {
  const r: Range = { min, max, log };
  const n = clamp(toNorm(value, r), 0, 1);
  const bi = min < 0 && max > 0 && !log;
  const z = bi ? toNorm(0, r) : 0;
  const dash = bi ? `${Math.abs(n - z) * AL} ${AL * 2}` : `${n * AL} ${AL * 2}`;
  const off = bi ? -Math.min(n, z) * AL : 0;
  const drag = useRef<{ y: number; n: number } | null>(null);
  const text = display ?? amFormat(value, unit);
  const name = title ?? label ?? 'Regler';
  return (
    <div
      className={`am-kn ${size ? `am-${size}` : ''} ${gold ? 'am-gold' : ''}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={name}
      aria-disabled={disabled || undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(n * 100)}
      aria-valuetext={text}
      title={`${name} · ziehen, Doppelklick = Standard`}
      style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        drag.current = { y: e.clientY, n };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        onChange(fromNorm(d.n + (d.y - e.clientY) / (e.shiftKey ? 600 : 160), r));
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => { if (!disabled && def !== undefined) onChange(def); }}
      onKeyDown={(e) => {
        if (disabled) return;
        const s = keyStep(e);
        if (!s) return;
        e.preventDefault();
        onChange(fromNorm(n + s, r));
      }}
    >
      <svg viewBox="0 0 40 40">
        <path className="am-kb" d={ARC} />
        <path className="am-ka" d={ARC} style={{ strokeDasharray: dash, strokeDashoffset: off }} />
        <circle className="am-kc" cx="20" cy="20" r="11" />
        <line className="am-ki" x1="20" y1="20" x2="20" y2="10" transform={`rotate(${-135 + n * 270} 20 20)`} />
      </svg>
      <b>{text}</b>
      {label ? <i>{label}</i> : null}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Fader                                                               */
/* ------------------------------------------------------------------ */

export interface AmFaderProps {
  value: number;
  onChange: (v: number) => void;
  label: string;
  def?: number;
  big?: boolean;
  disabled?: boolean;
}

/** Senkrechter Fader (0..1). */
export const AmFader = React.memo(function AmFader({ value, onChange, label, def, big, disabled }: AmFaderProps) {
  const active = useRef(false);
  const n = clamp(value, 0, 1);
  const at = (el: HTMLElement, y: number) => {
    const r = el.getBoundingClientRect();
    onChange(clamp(1 - (y - r.top - 8) / (r.height - 16), 0, 1));
  };
  return (
    <div
      className={`am-fd ${big ? 'am-big' : ''}`}
      role="slider"
      aria-orientation="vertical"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(n * 100)}
      aria-valuetext={`${Math.round(n * 100)} %`}
      style={{ ['--n' as string]: n, ...(disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        active.current = true;
        at(e.currentTarget, e.clientY);
      }}
      onPointerMove={(e) => { if (active.current) at(e.currentTarget, e.clientY); }}
      onPointerUp={() => { active.current = false; }}
      onPointerCancel={() => { active.current = false; }}
      onDoubleClick={() => { if (!disabled && def !== undefined) onChange(def); }}
      onKeyDown={(e) => {
        if (disabled) return;
        const s = keyStep(e);
        if (!s) return;
        e.preventDefault();
        onChange(clamp(n + s, 0, 1));
      }}
    >
      <i className="am-fdt" />
      <b className="am-fdk" />
    </div>
  );
});

/** Waagerechter Fader (Crossfader, 0..1). */
export const AmHFader = React.memo(function AmHFader({ value, onChange, label, def, disabled }: AmFaderProps) {
  const active = useRef(false);
  const n = clamp(value, 0, 1);
  const at = (el: HTMLElement, x: number) => {
    const r = el.getBoundingClientRect();
    onChange(clamp((x - r.left - 10) / (r.width - 20), 0, 1));
  };
  return (
    <div
      className="am-fh"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(n * 100)}
      aria-valuetext={`A ${Math.round((1 - n) * 100)} % / B ${Math.round(n * 100)} %`}
      style={{ ['--n' as string]: n }}
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        active.current = true;
        at(e.currentTarget, e.clientX);
      }}
      onPointerMove={(e) => { if (active.current) at(e.currentTarget, e.clientX); }}
      onPointerUp={() => { active.current = false; }}
      onPointerCancel={() => { active.current = false; }}
      onDoubleClick={() => { if (!disabled && def !== undefined) onChange(def); }}
      onKeyDown={(e) => {
        if (disabled) return;
        const s = keyStep(e);
        if (!s) return;
        e.preventDefault();
        onChange(clamp(n + s, 0, 1));
      }}
    >
      <i className="am-fdt" />
      <b className="am-fdk" />
    </div>
  );
});

/** Balkenregler (Effekt-Tabelle, 0..1). */
export const AmBar = React.memo(function AmBar({ value, onChange, label, color, disabled }: {
  value: number; onChange: (v: number) => void; label: string; color: string; disabled?: boolean;
}) {
  const active = useRef(false);
  const n = clamp(value, 0, 1);
  const at = (el: HTMLElement, x: number) => {
    const r = el.getBoundingClientRect();
    onChange(clamp((x - r.left) / r.width, 0, 1));
  };
  return (
    <div
      className="am-bar"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      title={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(n * 100)}
      style={{ ['--n' as string]: n, ['--bc' as string]: color }}
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        active.current = true;
        at(e.currentTarget, e.clientX);
      }}
      onPointerMove={(e) => { if (active.current) at(e.currentTarget, e.clientX); }}
      onPointerUp={() => { active.current = false; }}
      onKeyDown={(e) => {
        const s = keyStep(e);
        if (!s || disabled) return;
        e.preventDefault();
        onChange(clamp(n + s, 0, 1));
      }}
    >
      <i className="am-fdt" />
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Taster, Umschalter, Pegel                                           */
/* ------------------------------------------------------------------ */

export function AmToggle({ on, onClick, children, kind = '', title, disabled, ariaLabel }: {
  on: boolean; onClick: () => void; children: React.ReactNode; kind?: '' | 'm' | 's' | 'cue' | 'sync';
  title?: string; disabled?: boolean; ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={`am-tg ${kind ? `am-${kind}` : ''} ${on ? 'am-on' : ''}`}
      aria-pressed={on}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function AmSeg<T extends string>({ value, options, onChange, label, disabled }: {
  value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string; disabled?: boolean;
}) {
  return (
    <div className="am-seg" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" className={value === v ? 'am-on' : ''} aria-pressed={value === v} disabled={disabled} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Pegelsäule (0..1) mit Spitzenmarke. */
export const AmMeter = React.memo(function AmMeter({ level, peak, width, height }: {
  level: number; peak?: number; width?: number; height?: number | string;
}) {
  const l = clamp(level, 0, 1);
  return (
    <div className="am-vm" data-live-value="meter" style={{ width, height }}>
      <i style={{ height: `${l * 100}%` }} />
      {peak !== undefined ? <b style={{ bottom: `${clamp(peak, 0, 1) * 100}%` }} /> : null}
    </div>
  );
});

/** Karte mit Titelzeile (Plugin-Inhalte). */
export function AmCard({ title, right, children, style, className = '' }: {
  title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties; className?: string;
}) {
  return (
    <div className={`am-card ${className}`} style={style}>
      {title ? (
        <h3>
          <span><span className="am-dot" />{title}</span>
          {right}
        </h3>
      ) : null}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* X/Y Pad (für Spatial, Filter, etc.)                                 */
/* ------------------------------------------------------------------ */

export interface AmXyPadProps {
  x: number;        // -1..1
  y: number;        // -1..1
  onChange: (x: number, y: number) => void;
  label?: string;
  xLabel?: string;
  yLabel?: string;
  disabled?: boolean;
  grid?: boolean;
  quadrantLabels?: { tl?: string; tr?: string; bl?: string; br?: string };
}

/** 2D-Pad (X horizontal, Y vertical). Drag oder Click. */
export const AmXyPad = React.memo(function AmXyPad({
  x, y, onChange, label, xLabel = 'X', yLabel = 'Y', disabled, grid, quadrantLabels,
}: AmXyPadProps) {
  const active = useRef(false);
  const nx = clamp((x + 1) / 2, 0, 1);
  const ny = clamp((y + 1) / 2, 0, 1);

  const at = (el: HTMLElement, ex: number, ey: number) => {
    const r = el.getBoundingClientRect();
    const cx = clamp((ex - r.left) / r.width, 0, 1);
    const cy = clamp((ey - r.top) / r.height, 0, 1);
    onChange(cx * 2 - 1, 1 - cy * 2);
  };

  return (
    <div
      className="am-xypad"
      role="slider"
      aria-label={label ?? 'XY-Pad'}
      aria-orientation="horizontal"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={Math.round(x * 100)}
      aria-valuetext={`${xLabel} ${(x * 100).toFixed(0)}%, ${yLabel} ${(y * 100).toFixed(0)}%`}
      style={{
        ['--x' as string]: nx,
        ['--y' as string]: ny,
        ...(disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {})
      }}
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        active.current = true;
        at(e.currentTarget, e.clientX, e.clientY);
      }}
      onPointerMove={(e) => { if (active.current) at(e.currentTarget, e.clientX, e.clientY); }}
      onPointerUp={() => { active.current = false; }}
      onPointerCancel={() => { active.current = false; }}
      onClick={(e) => { if (!disabled && !active.current) at(e.currentTarget, e.clientX, e.clientY); }}
      onKeyDown={(e) => {
        if (disabled) return;
        const step = 0.05;
        let nx = x, ny = y;
        switch (e.key) {
          case 'ArrowLeft': nx = clamp(x - step, -1, 1); break;
          case 'ArrowRight': nx = clamp(x + step, -1, 1); break;
          case 'ArrowUp': ny = clamp(y + step, -1, 1); break;
          case 'ArrowDown': ny = clamp(y - step, -1, 1); break;
          default: return;
        }
        e.preventDefault();
        onChange(nx, ny);
      }}
    >
      <i className="am-xy-handle" />
      {grid && (
        <>
          <i className="am-xy-grid-v" />
          <i className="am-xy-grid-h" />
        </>
      )}
      {quadrantLabels && (
        <>
          {quadrantLabels.tl && <span className="am-xy-q am-xy-tl">{quadrantLabels.tl}</span>}
          {quadrantLabels.tr && <span className="am-xy-q am-xy-tr">{quadrantLabels.tr}</span>}
          {quadrantLabels.bl && <span className="am-xy-q am-xy-bl">{quadrantLabels.bl}</span>}
          {quadrantLabels.br && <span className="am-xy-q am-xy-br">{quadrantLabels.br}</span>}
        </>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Step-Sequenzer Grid (8×16, 16×16, etc.)                             */
/* ------------------------------------------------------------------ */

export interface AmStepGridProps {
  steps: boolean[][];
  onToggle: (row: number, step: number) => void;
  accentSteps?: number[][];
  labels?: string[];
  cols?: number;
  _rows?: number;
  disabled?: boolean;
  showStepNumbers?: boolean;
}

/** Step-Grid für Drum-Patterns, Synth-Sequencer, etc. */
export const AmStepGrid = React.memo(function AmStepGrid({
  steps, onToggle, accentSteps, labels, cols = 16, _rows = 8, disabled, showStepNumbers = true,
}: AmStepGridProps) {
  return (
    <div className="am-stepgrid" role="grid" aria-label="Step-Sequenzer" aria-readonly={disabled || undefined}>
      {showStepNumbers && (
        <div className="am-stepgrid-head" aria-hidden="true">
          {Array.from({ length: cols }, (_, i) => (
            <span key={i} className={i % 4 === 0 ? 'am-beat' : ''}>{i + 1}</span>
          ))}
        </div>
      )}
      <div className="am-stepgrid-body">
        {steps.map((rowSteps, r) => (
          <div key={r} className="am-stepgrid-row" role="row">
            {labels && <span className="am-stepgrid-label" role="rowheader">{labels[r]}</span>}
            {rowSteps.map((on, c) => (
              <button
                key={c}
                type="button"
                role="gridcell"
                aria-selected={on}
                aria-label={`Step ${c + 1}${labels ? `, ${labels[r]}` : ''}: ${on ? 'an' : 'aus'}`}
                className={`am-step ${on ? 'am-on' : ''} ${accentSteps?.[r]?.[c] ? 'am-accent' : ''} ${c % 4 === 0 ? 'am-beat' : ''}`}
                disabled={disabled}
                onClick={() => !disabled && onToggle(r, c)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Parameter-Row: Label + Regler + Wert (für kompakte Listen)          */
/* ------------------------------------------------------------------ */

export interface AmParamRowProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  unit?: AmUnit;
  def?: number;
  log?: boolean;
  size?: '' | 's' | 'xs';
  disabled?: boolean;
}

/** Eine Zeile: Label links, Knob rechts, Wert dazwischen. */
export const AmParamRow = React.memo(function AmParamRow({
  label, value, onChange, min = 0, max = 1, unit = 'raw', def, log, size = 'xs', disabled,
}: AmParamRowProps) {
  const r: Range = { min, max, log };
  const n = clamp(toNorm(value, r), 0, 1);
  const text = amFormat(value, unit);
  const bi = min < 0 && max > 0 && !log;
  const z = bi ? toNorm(0, r) : 0;
  const dash = bi ? `${Math.abs(n - z) * AL} ${AL * 2}` : `${n * AL} ${AL * 2}`;
  const off = bi ? -Math.min(n, z) * AL : 0;
  const drag = useRef<{ y: number; n: number } | null>(null);

  return (
    <div className="am-paramrow" style={{ ['--c' as string]: 'var(--cue)' }}>
      <label className="am-paramrow-label" htmlFor={`param-${label}`}>{label}</label>
      <div
        id={`param-${label}`}
        className={`am-kn ${size ? `am-${size}` : ''}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(n * 100)}
        aria-valuetext={text}
        title={`${label} · ziehen, Doppelklick = Standard`}
        style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
        onPointerDown={(e) => {
          if (disabled) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          e.currentTarget.focus({ preventScroll: true });
          drag.current = { y: e.clientY, n };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          onChange(fromNorm(d.n + (d.y - e.clientY) / (e.shiftKey ? 600 : 160), r));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={() => { if (!disabled && def !== undefined) onChange(def); }}
        onKeyDown={(e) => {
          if (disabled) return;
          const s = keyStep(e);
          if (!s) return;
          e.preventDefault();
          onChange(fromNorm(n + s, r));
        }}
      >
        <svg viewBox="0 0 40 40">
          <path className="am-kb" d={ARC} />
          <path className="am-ka" d={ARC} style={{ strokeDasharray: dash, strokeDashoffset: off }} />
          <circle className="am-kc" cx="20" cy="20" r="11" />
          <line className="am-ki" x1="20" y1="20" x2="20" y2="10" transform={`rotate(${-135 + n * 270} 20 20)`} />
        </svg>
        <b>{text}</b>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* LED-Indikator (Status, Clip, Sync, etc.)                           */
/* ------------------------------------------------------------------ */

export interface AmLedProps {
  on: boolean;
  color?: 'ok' | 'warn' | 'hot' | 'cue' | 'free' | 'lock' | string;
  size?: 'xs' | 's' | 'm' | 'l';
  pulse?: boolean;
  label?: string;
}

/** Kleiner Status-LED. */
export const AmLed = React.memo(function AmLed({ on, color = 'ok', size = 'm', pulse, label }: AmLedProps) {
  const colorMap: Record<string, string> = {
    ok: 'var(--ok)',
    warn: 'var(--warn)',
    hot: 'var(--hot)',
    cue: 'var(--cue)',
    free: 'var(--free)',
    lock: 'var(--lock)',
  };
  const c = colorMap[color] ?? color;
  return (
    <span
      className={`am-led am-led-${size} ${on ? 'am-on' : ''} ${pulse ? 'am-pulse' : ''}`}
      role="status"
      aria-label={label}
      style={{
        backgroundColor: on ? c : 'transparent',
        boxShadow: on ? `0 0 8px ${c}` : 'none',
        borderColor: on ? c : 'var(--ln2)',
      }}
    />
  );
});

/* ------------------------------------------------------------------ */
/* Pegelkette (Multi-Meter für Mixer-Kanäle, Busse)                   */
/* ------------------------------------------------------------------ */

export interface AmMeterStackProps {
  levels: number[];
  peaks?: number[];
  labels?: string[];
  width?: number;
  height?: number;
  gap?: number;
}

/** Vertikale Meter nebeneinander (Mixer-Kanal-Pegel, Bus-Pegel). */
export const AmMeterStack = React.memo(function AmMeterStack({
  levels, peaks, labels, width = 6, height = 120, gap = 2,
}: AmMeterStackProps) {
  return (
    <div className="am-meterstack" style={{ gap }} role="img" aria-label="Pegelanzeige" aria-readonly="true">
      {levels.map((level, i) => (
        <div key={i} className="am-meterstack-ch" style={{ width, height }}>
          {labels && <span className="am-meterstack-label" style={{ bottom: 'auto', top: -14 }}>{labels[i]}</span>}
          <AmMeter level={level} peak={peaks?.[i]} width={width} height={height} />
          {labels && <span className="am-meterstack-label">{labels[i]}</span>}
        </div>
      ))}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Collapsible Section (für Plugin-Bereiche)                          */
/* ------------------------------------------------------------------ */

export interface AmCollapsibleProps {
  title: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}

/** Einklappbare Sektion mit Chevron. */
export const AmCollapsible = React.memo(function AmCollapsible({
  title, open, onToggle, children, icon, badge,
}: AmCollapsibleProps) {
  return (
    <details className="am-collapsible" open={open} onToggle={onToggle}>
      <summary className="am-collapsible-summary" aria-expanded={open}>
        {icon && <span className="am-collapsible-icon">{icon}</span>}
        <span className="am-collapsible-title">{title}</span>
        {badge && <span className="am-collapsible-badge">{badge}</span>}
        <AmSvg d="M6 9l6 6 6-6" className={`am-collapsible-chevron ${open ? 'am-open' : ''}`} />
      </summary>
      <div className="am-collapsible-content">{children}</div>
    </details>
  );
});

/* ------------------------------------------------------------------ */
/* Tabs (für Plugin-Sub-Sections wie Effect/ EQ / DSP)                */
/* ------------------------------------------------------------------ */

export interface AmTabsProps {
  tabs: { id: string; label: string; icon?: React.ReactNode }[];
  active: string;
  onChange: (id: string) => void;
  disabled?: string[];
}

/** Tab-Leiste für Sub-Navigation. */
export const AmTabs = React.memo(function AmTabs({ tabs, active, onChange, disabled = [] }: AmTabsProps) {
  return (
    <div className="am-tabs" role="tablist" aria-label="Tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          aria-controls={`panel-${t.id}`}
          id={`tab-${t.id}`}
          className={`am-tab ${active === t.id ? 'am-on' : ''} ${disabled.includes(t.id) ? 'am-disabled' : ''}`}
          disabled={disabled.includes(t.id)}
          onClick={() => !disabled.includes(t.id) && onChange(t.id)}
        >
          {t.icon && <span className="am-tab-icon">{t.icon}</span>}
          <span className="am-tab-label">{t.label}</span>
        </button>
      ))}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Color Swatch / Theme Picker                                        */
/* ------------------------------------------------------------------ */

export interface AmColorSwatchProps {
  color: string;
  onClick: () => void;
  active?: boolean;
  size?: number;
  label?: string;
}

/** Farb-Wahl für Modul-Themes, User-Farben, etc. */
export const AmColorSwatch = React.memo(function AmColorSwatch({ color, onClick, active, size = 24, label }: AmColorSwatchProps) {
  return (
    <button
      type="button"
      className={`am-swatch ${active ? 'am-on' : ''}`}
      onClick={onClick}
      aria-label={label ?? `Farbe ${color}`}
      aria-pressed={active}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        borderColor: active ? 'var(--tx)' : 'var(--ln2)',
        boxShadow: active ? `0 0 0 2px var(--tx), 0 0 8px ${color}` : 'none',
      }}
    />
  );
});

/* ------------------------------------------------------------------ */
/* Preset Selector (Dropdown mit Vorschau)                            */
/* ------------------------------------------------------------------ */

export interface AmPresetSelectProps<T extends string> {
  presets: { id: T; name: string; description?: string }[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
  _placeholder?: string;
}

/** Preset-Auswahl mit Beschreibung. */
export const AmPresetSelect = React.memo(function AmPresetSelect<T extends string>({
  presets, value, onChange, disabled, _placeholder = 'Preset wählen…',
}: AmPresetSelectProps<T>) {
  return (
    <select
      className="am-sel"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      disabled={disabled}
      aria-label="Preset wählen"
    >
      {presets.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
});
