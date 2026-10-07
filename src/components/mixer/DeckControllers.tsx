/**
 * Controller links/rechts am mixerMONK – drei Skins nach den Vorlagen
 * =================================================================
 *   CDJ        public/uidesign/uimixercontroller1.jpg (CDJ-1500X: Bildschirm,
 *              Hot Cues, Jogwheel, CUE/PLAY, Tempo-Fader)
 *   Pads       public/uidesign/uimixercontroller2.jpg (DJS-1000: Bildschirm,
 *              6 Regler, Modus-Tasten, 16 Pads, 16 Step-Tasten)
 *   Bibliothek public/uidesign/uimixercontroller3.jpg (Titelliste mit Suche)
 *
 * Jede Seite hat ihren eigenen Ziel-Kanal (1–8) und ist ein-/ausblendbar
 * (0–2 Controller, auch zweimal derselbe Skin). Der Stand liegt im Mixer-Stand
 * der Session; bedienen darf nur der Mixer-Halter.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { SORTED_MUSIC_LIBRARY, type MusicTrack } from '../../data/musicLibrary';
import { readMainLevel } from '../../core/audio/mainLevel';
import { AmKnob, AmSeg, amColor } from '../am/amUi';
import type { TrackType } from '../../types';

export type DeckSkin = 'cdj' | 'pads' | 'lib';
export type PadPage = 'drop' | 'drum' | 'chord' | 'voc';

export interface DeckSide {
  on: boolean;
  skin: DeckSkin;
  /** Ziel-Kanal 0..7 */
  ch: number;
  /** Hot Cues A–H: Zeitpunkt in Sekunden oder −1 (leer). */
  cues: number[];
  /** Tempo-Fader −1..1 (= ±8 %). */
  pitch: number;
  page: PadPage;
  /** 16 Step-Tasten des Pad-Controllers. */
  steps: boolean[];
  /** 6 Regler über den Pads. */
  knobs: number[];
}

export const freshSide = (skin: DeckSkin, ch: number, on = true): DeckSide => ({
  on, skin, ch, cues: Array(8).fill(-1), pitch: 0, page: 'drop', steps: Array(16).fill(false), knobs: Array(6).fill(0.5),
});

export const CHANNEL_NAMES = ['Drops', 'Song', 'Drums', 'Synth', 'Instru', 'Vox', 'Sound', 'Stems'];

export const PAD_PAGES: Record<PadPage, { name: string; ch: number; labels: string[] }> = {
  drop: { name: 'DROPS', ch: 0, labels: ['Sirene', 'Air Horn', 'Hey!', 'Riser', 'Impact', 'Rewind', 'Laser', 'Sub Drop', 'Loop 1', 'Loop 2', 'Loop 3', 'Loop 4', 'Loop 5', 'Loop 6', 'Loop 7', 'Loop 8'] },
  drum: { name: 'DRUMS', ch: 2, labels: ['BD', 'SD', 'CP', 'CH', 'OH', 'LT', 'HT', 'CY', 'BD+', 'SD+', 'CP+', 'CH+', 'OH+', 'LT+', 'HT+', 'CY+'] },
  chord: { name: 'AKKORD', ch: 4, labels: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'V/vi', 'I↑', 'II↑', 'III↑', 'IV↑', 'V↑', 'VI↑', 'VII↑', 'V/vi↑'] },
  voc: { name: 'VOX', ch: 5, labels: ['A1', 'E1', 'I1', 'O1', 'U1', 'A2', 'E2', 'I2', 'O2', 'U2', 'A3', 'E3', 'I3', 'O3', 'U3', 'A4'] },
};
const PADCOL = ['#b26bff', '#c084fc', '#e879f9', '#f472b6', '#4ade80', '#38bdf8', '#3b82f6', '#60a5fa', '#facc15', '#a3e635', '#4ade80', '#22c55e', '#f87171', '#fb923c', '#f59e0b', '#fdba74'];
const STEPCOL = ['#c084fc', '#4ade80', '#facc15', '#f87171', '#a78bfa', '#38bdf8', '#fde047', '#fb7185'];

export interface DeckControllerProps {
  side: 'L' | 'R';
  s: DeckSide;
  set: (p: Partial<DeckSide>) => void;
  sources: string[];
  tracks: TrackType[];
  titles: (MusicTrack | null)[];
  info: Record<number, string>;
  onLoad: (ch: number, t: MusicTrack) => void;
  bpm: number;
  setBpm: (v: number) => void;
  playing: boolean;
  disabled: boolean;
}

/* ------------------------------------------------------------------ */
/* Anzeigen                                                            */
/* ------------------------------------------------------------------ */

/** Laufende Wellenform (Verlauf des Main-Pegels) im Deck-Bildschirm. */
function ScopeStrip({ color, playing, height = 46 }: { color: string; playing: boolean; height?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const hist: number[] = Array(160).fill(0);
    let id = 0;
    const draw = () => {
      if (cv.clientWidth < 4) return;
      const w = (cv.width = cv.clientWidth * devicePixelRatio);
      const h = (cv.height = cv.clientHeight * devicePixelRatio);
      const g = cv.getContext('2d');
      if (!g) return;
      hist.push(playing ? readMainLevel().raw : 0);
      hist.shift();
      g.clearRect(0, 0, w, h);
      const bw = w / hist.length;
      for (let i = 0; i < hist.length; i += 1) {
        const v = Math.max(0.02, hist[i]);
        const bh = v * h * 0.95;
        g.fillStyle = i > hist.length * 0.5 ? color : 'rgba(255,255,255,.75)';
        g.globalAlpha = i > hist.length * 0.5 ? 0.85 : 0.55;
        g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
      }
      g.globalAlpha = 1;
      g.fillStyle = '#ff4d4d';
      g.fillRect(w * 0.5, 0, 1.5 * devicePixelRatio, h);
    };
    draw();
    id = window.setInterval(draw, playing ? 60 : 500);
    return () => window.clearInterval(id);
  }, [color, playing]);
  return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} aria-hidden="true" />;
}

/** Jogwheel: dreht mit dem Transport, Ziehen schiebt das Tempo kurz an (Nudge). */
function Jog({ bpm, playing, disabled, color }: { bpm: number; playing: boolean; disabled: boolean; color: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const nudge = useRef<{ x: number } | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let raf = 0;
    let retry = 0;
    const draw = () => {
      if (cv.clientWidth < 20) { retry = window.setTimeout(draw, 500); return; }
      const s = (cv.width = cv.clientWidth * devicePixelRatio);
      cv.height = s;
      const g = cv.getContext('2d');
      if (!g) return;
      const c = s / 2;
      const ang = audioEngine.getTransportSeconds() * (33.3 / 60) * Math.PI * 2;
      g.clearRect(0, 0, s, s);
      const ring = g.createRadialGradient(c, c, c * 0.2, c, c, c);
      ring.addColorStop(0, '#2a2f38'); ring.addColorStop(0.7, '#14171d'); ring.addColorStop(1, '#3a3f4a');
      g.fillStyle = ring; g.beginPath(); g.arc(c, c, c - 2, 0, Math.PI * 2); g.fill();
      for (let i = 0; i < 64; i += 1) {
        const a = ang + (i / 64) * Math.PI * 2;
        g.strokeStyle = i % 8 === 0 ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.1)';
        g.lineWidth = devicePixelRatio;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * c * 0.78, c + Math.sin(a) * c * 0.78);
        g.lineTo(c + Math.cos(a) * c * 0.92, c + Math.sin(a) * c * 0.92);
        g.stroke();
      }
      g.fillStyle = '#0b0d11'; g.beginPath(); g.arc(c, c, c * 0.42, 0, Math.PI * 2); g.fill();
      g.strokeStyle = color; g.lineWidth = 3 * devicePixelRatio;
      g.beginPath(); g.arc(c, c, c * 0.42, ang, ang + Math.PI * 1.2); g.stroke();
      g.fillStyle = '#d5e2fb'; g.font = `600 ${11 * devicePixelRatio}px "JetBrains Mono", monospace`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(bpm.toFixed(1), c, c);
      if (playing) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); window.clearTimeout(retry); };
  }, [bpm, playing, color]);
  return (
    <div
      className="am-jog am-jog-s"
      title="Jogwheel: ziehen schiebt das Tempo kurz an (Nudge)"
      role="img"
      aria-label={`Jogwheel, Tempo ${bpm.toFixed(1)}`}
      onPointerDown={(e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        nudge.current = { x: e.clientX };
      }}
      onPointerMove={(e) => {
        if (!nudge.current) return;
        const d = Math.max(-1, Math.min(1, (e.clientX - nudge.current.x) / 120));
        audioEngine.setBpm(bpm * (1 + d * 0.04));
      }}
      onPointerUp={() => { if (nudge.current) audioEngine.setBpm(bpm); nudge.current = null; }}
      onPointerCancel={() => { if (nudge.current) audioEngine.setBpm(bpm); nudge.current = null; }}
    >
      <canvas ref={ref} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Kopf eines Controllers                                              */
/* ------------------------------------------------------------------ */

function CtlHead({ side, s, set, sources, disabled }: Pick<DeckControllerProps, 'side' | 's' | 'set' | 'sources' | 'disabled'>) {
  return (
    <div className="am-ctlhead">
      <span className="am-lbl">{side}</span>
      <AmSeg
        value={s.skin}
        label={`Controller ${side === 'L' ? 'links' : 'rechts'}: Skin`}
        disabled={disabled}
        options={[['cdj', 'CDJ'], ['pads', 'PADS'], ['lib', 'LIB']] as const}
        onChange={(v) => set({ skin: v })}
      />
      <select className="am-sel am-chsel" aria-label={`Controller ${side === 'L' ? 'links' : 'rechts'}: Kanal`} value={s.ch} disabled={disabled}
        onChange={(e) => set({ ch: Number(e.target.value) })} style={{ ['--c' as string]: amColor(sources[s.ch]) }}>
        {CHANNEL_NAMES.map((n, i) => <option key={i} value={i}>K{i + 1} {n}</option>)}
      </select>
      <button type="button" className="am-x" aria-label={`Controller ${side === 'L' ? 'links' : 'rechts'} ausblenden`} title="Controller ausblenden" onClick={() => set({ on: false })}>✕</button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Skins                                                               */
/* ------------------------------------------------------------------ */

function CdjSkin(p: DeckControllerProps) {
  const { s, set, sources, tracks, titles, info, bpm, setBpm, playing, disabled } = p;
  const color = amColor(sources[s.ch]);
  const title = titles[s.ch]?.name ?? `${CHANNEL_NAMES[s.ch]} – kein Titel`;
  const secs = audioEngine.getTransportSeconds();
  return (
    <>
      <div className="am-screen am-cdjscreen">
        <div className="am-ttl"><span>{s.ch + 1} · {title}</span><span>{playing ? '▶' : '■'}</span></div>
        <ScopeStrip color={color} playing={playing} height={54} />
        <div className="am-cdjinfo">
          <div><span>PLAYER</span><b>{s.ch + 1}</b></div>
          <div><span>TEMPO</span><b>{s.pitch >= 0 ? '+' : ''}{(s.pitch * 8).toFixed(1)}%</b></div>
          <div><span>BPM</span><b>{bpm.toFixed(1)}</b></div>
          <div><span>ZEIT</span><b>{Math.floor(secs / 60)}:{String(Math.floor(secs % 60)).padStart(2, '0')}</b></div>
        </div>
        <div className="am-hint" style={{ fontSize: 10 }}>{info[s.ch] ?? 'BPM/Tonart nach dem Laden'}</div>
      </div>
      <div className="am-hotcues" aria-label="Hot Cues">
        {'ABCDEFGH'.split('').map((l, i) => (
          <button key={l} type="button" disabled={disabled} className={s.cues[i] >= 0 ? 'am-on' : ''} style={{ ['--hc' as string]: PADCOL[i * 2] }}
            title={s.cues[i] >= 0 ? `Hot Cue ${l} anspielen (Doppelklick: löschen)` : `Hot Cue ${l} setzen`}
            onClick={() => {
              if (s.cues[i] < 0) set({ cues: s.cues.map((c, k) => (k === i ? audioEngine.getTransportSeconds() : c)) });
              else audioEngine.triggerEvent(tracks[s.ch], 0.9);
            }}
            onDoubleClick={() => set({ cues: s.cues.map((c, k) => (k === i ? -1 : c)) })}>{l}</button>
        ))}
      </div>
      <div className="am-cdjbody">
        <div className="am-cdjbtns">
          <button type="button" className="am-cdjround am-cue" disabled={disabled} title="CUE: Kanal anspielen" onClick={() => audioEngine.triggerEvent(tracks[s.ch], 0.9)}>CUE</button>
          <button type="button" className={`am-cdjround am-play ${playing ? 'am-on' : ''}`} disabled={disabled} title="PLAY/PAUSE (Transport)"
            onClick={() => (playing ? audioEngine.stop() : void audioEngine.play())}>▶/❚❚</button>
        </div>
        <Jog bpm={bpm} playing={playing} disabled={disabled} color={color} />
        <div className="am-tempo">
          <span className="am-lbl">Tempo</span>
          <input type="range" min={-1} max={1} step={0.01} value={s.pitch} disabled={disabled} aria-label="Tempo-Fader ±8 %"
            onChange={(e) => {
              const v = Number(e.target.value);
              const base = bpm / (1 + s.pitch * 0.08);
              set({ pitch: v });
              setBpm(base * (1 + v * 0.08));
            }} />
        </div>
      </div>
      <select className="am-sel" value={titles[s.ch]?.name ?? ''} disabled={disabled}
        aria-label={`Track laden auf Kanal ${s.ch + 1} (${CHANNEL_NAMES[s.ch]})`}
        onChange={(e) => { const t = SORTED_MUSIC_LIBRARY.find((x) => x.name === e.target.value); if (t) p.onLoad(s.ch, t); }}>
        <option value="">{titles[s.ch] ? titles[s.ch]?.name : '+ Titel laden'}</option>
        {SORTED_MUSIC_LIBRARY.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
      </select>
    </>
  );
}

function PadsSkin(p: DeckControllerProps) {
  const { s, set, tracks, disabled } = p;
  const page = PAD_PAGES[s.page];
  const [hit, setHit] = useState(-1);
  const fire = (k: number) => {
    audioEngine.triggerEvent(tracks[page.ch], k > 7 ? 1 : 0.8);
    setHit(k);
    window.setTimeout(() => setHit(-1), 120);
  };
  const KN = ['Level', 'Pitch', 'Filter', 'Attack', 'Release', 'FX'];
  return (
    <>
      <div className="am-screen am-padscreen">
        <div className="am-ttl"><span>PAD · {page.name} → Kanal {page.ch + 1}</span><span>{CHANNEL_NAMES[page.ch]}</span></div>
        <div className="am-padgrid">
          {page.labels.map((l, k) => <span key={k} style={{ color: PADCOL[k] }}>{l}</span>)}
        </div>
      </div>
      <div className="am-sixknobs">
        {KN.map((n, i) => (
          <AmKnob key={n} size="xs" value={s.knobs[i]} def={0.5} unit="pct" label={n} title={`Pad-Regler ${n}`} disabled={disabled}
            onChange={(v) => set({ knobs: s.knobs.map((x, k) => (k === i ? v : x)) })} />
        ))}
      </div>
      <div className="am-padmodes">
        {(Object.keys(PAD_PAGES) as PadPage[]).map((k) => (
          <button key={k} type="button" className={s.page === k ? 'am-on' : ''} aria-pressed={s.page === k} onClick={() => set({ page: k })}>{PAD_PAGES[k].name}</button>
        ))}
      </div>
      <div className="am-pads am-pads-big" aria-label={`Pads: ${page.name}`}>
        {page.labels.map((l, k) => (
          <button key={k} type="button" className={`am-pad ${hit === k ? 'am-hit' : ''}`} style={{ ['--pc' as string]: PADCOL[k] }} disabled={disabled}
            title={`Pad ${k + 1}: ${l} (Kanal ${page.ch + 1})`} onPointerDown={() => fire(k)}>{l}</button>
        ))}
      </div>
      <div className="am-steps" aria-label={`Step-Sequenz Kanal ${page.ch + 1}`}>
        {s.steps.map((on, i) => (
          <button key={i} type="button" className={on ? 'am-on' : ''} style={{ ['--sc' as string]: STEPCOL[i % 8] }} disabled={disabled}
            aria-pressed={on} aria-label={`Step ${i + 1}`}
            onClick={() => {
              const next = s.steps.map((x, k) => (k === i ? !x : x));
              set({ steps: next });
              audioEngine.setStep(tracks[page.ch], i, next[i]);
            }}>{i + 1}</button>
        ))}
      </div>
    </>
  );
}

function LibSkin(p: DeckControllerProps) {
  const { s, titles, disabled, onLoad } = p;
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return SORTED_MUSIC_LIBRARY.filter((x) => !t || x.name.toLowerCase().includes(t) || String(x.artist).toLowerCase().includes(t)).slice(0, 200);
  }, [q]);
  return (
    <>
      <input className="am-libq" placeholder="Suchen: Titel oder Interpret" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Bibliothek durchsuchen" />
      <div className="am-libl" role="listbox" aria-label={`Titel für Kanal ${s.ch + 1}`}>
        <div className="am-libh"><span>Track Title</span><span>Artist</span></div>
        {list.map((t) => {
          const loaded = titles[s.ch]?.id === t.id;
          return (
            <button key={t.id} type="button" role="option" aria-selected={loaded} className={loaded ? 'am-on' : ''} disabled={disabled}
              title={`Auf Kanal ${s.ch + 1} laden`} onClick={() => onLoad(s.ch, t)}>
              <span>{t.name}</span><span>{t.artist}</span>
            </button>
          );
        })}
        {list.length === 0 && <div className="am-hint" style={{ padding: 8 }}>Nichts gefunden.</div>}
      </div>
    </>
  );
}

export const DeckController = React.memo(function DeckController(p: DeckControllerProps) {
  const color = amColor(p.sources[p.s.ch]);
  return (
    <div className={`am-unit am-ctl am-ctl-${p.s.skin}`} style={{ ['--c' as string]: color }} data-testid={`deck-${p.side}`}>
      <CtlHead {...p} />
      {p.s.skin === 'cdj' ? <CdjSkin {...p} /> : p.s.skin === 'pads' ? <PadsSkin {...p} /> : <LibSkin {...p} />}
    </div>
  );
});
