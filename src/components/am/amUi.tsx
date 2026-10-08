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
