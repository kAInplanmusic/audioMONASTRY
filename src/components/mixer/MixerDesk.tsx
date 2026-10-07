/**
 * mixerMONK · Hardware-Pult nach dem Entwurf (docs/design/audioMONASTRY-design.html)
 * ================================================================================
 * 8 Kanäle in 2 Bänken (A = 1–4, B = 5–8), Kanal = Quelle aus dem Audio-Vertrag
 * (src/plugins/pluginContract.ts): Drops · Song · Drums · Synth · Instru · Vox ·
 * Sound · Stems. Aufbau von links: Sprungleiste · Deck (gewählter Kanal, Jog) ·
 * Master · 4 Kanalzüge · Effekte/Pads/Makros/Szenen · Crossfader.
 *
 * Regeln:
 * - Nur der Halter bedient das Pult (alle anderen sehen den eingeklappten Streifen).
 * - Der ganze Stand liegt in der Session (`writePluginSettings('mixer', …)`), wer
 *   übernimmt, startet damit – auch in der Audio-Engine.
 * - Wo die Engine schon eine Schnittstelle hat, wirkt der Regler sofort
 *   (Kanal-Gain/EQ/Pan/PFL, Master, Tempo, Transport, Pads). Alles andere liegt
 *   im Stand und wird von der v2-Verkabelung gelesen.
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { webRTCManager } from '../../utils/WebRTCManager';
import { audioEngine } from '../../utils/audioEngine';
import { analyzeMusic } from '../../utils/audioAnalyzer';
import { ALL_TRACKS, type TrackType } from '../../types';
import { SORTED_MUSIC_LIBRARY, type MusicTrack } from '../../data/musicLibrary';
import { type AutoloadSong, clearAutoloadSong, loadAutoloadSong, saveAutoloadSong } from '../../core/session/autoloadSong';
import { SIGNAL_CHAIN } from '../../plugins/signalChain';
import { channelMapFromContract } from '../../plugins/pluginContract';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { usePluginManager } from '../../context/PluginManagerContext';
import { useModuleState } from '../../context/ModuleStateContext';
import { pluginModeOf, pluginOwnerOf } from '../../core/session/pluginMode';
import { isPluginSynced, pluginSyncVersion, subscribePluginSync } from '../../core/session/pluginSync';
import { personColor, personLabel, useSessionPeople } from '../../core/session/sessionPeople';
import { AM_MODULE, AmBar, AmFader, AmHFader, AmKnob, AmMeter, AmSeg, AmToggle, amColor } from '../am/amUi';

/* ------------------------------------------------------------------ */
/* Stand                                                               */
/* ------------------------------------------------------------------ */

type Xf = 'A' | 'T' | 'B';
interface DeskChannel {
  trim: number; hi: number; mid: number; low: number; filter: number; send: number; pan: number;
  fader: number; mute: boolean; solo: boolean; cue: boolean; xf: Xf;
}
interface FxRow { on: boolean; amt: number; time: number; fb: number; mix: number }
interface DeskState {
  channels: DeskChannel[];
  xfd: number; curve: 'smooth' | 'cut'; master: number;
  bank: 'A' | 'B'; sel: number; fxLock: boolean; keyLock: boolean;
  key: string; macros: { flt: number; fx: number; build: number };
  fx: Record<string, FxRow>; scenes: Record<string, DeskChannel[]>; padPage: 'drop' | 'drum' | 'chord' | 'voc';
}

const CHANNEL_NAMES = ['Drops', 'Song', 'Drums', 'Synth', 'Instru', 'Vox', 'Sound', 'Stems'];
const CH_MAP = channelMapFromContract();
const CH_SRC: string[] = Array.from({ length: 8 }, (_, i) => CH_MAP[i + 1] ?? '');
const TRACKS: TrackType[] = ALL_TRACKS.slice(0, 8);
const FX_LIST: [string, string][] = [['delay', 'Delay'], ['reverb', 'Hall'], ['flanger', 'Flanger'], ['crush', 'Crush'], ['filter', 'Filter']];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'H'];
const KEYS = NOTES.flatMap((n) => [`${n}-Dur`, `${n}-Moll`]);
const PADCOL = ['#b26bff', '#c084fc', '#e879f9', '#f472b6', '#4ade80', '#38bdf8', '#3b82f6', '#60a5fa', '#facc15', '#a3e635', '#4ade80', '#22c55e', '#f87171', '#fb923c', '#f59e0b', '#fdba74'];
const PAD_PAGES: Record<DeskState['padPage'], { ch: number; labels: string[] }> = {
  drop: { ch: 0, labels: ['Sirene', 'Air Horn', 'Hey!', 'Riser', 'Impact', 'Rewind', 'Laser', 'Sub Drop', 'Loop 1', 'Loop 2', 'Loop 3', 'Loop 4', 'Loop 5', 'Loop 6', 'Loop 7', 'Loop 8'] },
  drum: { ch: 2, labels: ['BD', 'SD', 'CP', 'CH', 'OH', 'LT', 'HT', 'CY', 'BD !', 'SD !', 'CP !', 'CH !', 'OH !', 'LT !', 'HT !', 'CY !'] },
  chord: { ch: 4, labels: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'V/vi', 'I ↑', 'II ↑', 'III ↑', 'IV ↑', 'V ↑', 'VI ↑', 'VII ↑', 'V/vi ↑'] },
  voc: { ch: 5, labels: ['A1', 'E1', 'I1', 'O1', 'U1', 'A2', 'E2', 'I2', 'O2', 'U2', 'A3', 'E3', 'I3', 'O3', 'U3', 'A4'] },
};

const freshChannel = (): DeskChannel => ({
  trim: 0, hi: 0, mid: 0, low: 0, filter: 0, send: 0, pan: 0, fader: 0.75, mute: false, solo: false, cue: false, xf: 'T',
});
const freshState = (): DeskState => ({
  channels: Array.from({ length: 8 }, freshChannel),
  xfd: 0.5, curve: 'smooth', master: 0.8, bank: 'A', sel: 0, fxLock: false, keyLock: false, key: 'A-Moll',
  macros: { flt: 0, fx: 0, build: 0 },
  fx: Object.fromEntries(FX_LIST.map(([id]) => [id, { on: false, amt: 0, time: 0.4, fb: 0.3, mix: 0.5 }])),
  scenes: {}, padPage: 'drop',
});

/** Gespeicherten Stand prüfen: nur bekannte Felder, richtige Typen. */
function restoreState(saved: unknown): DeskState {
  const base = freshState();
  const desk = (saved as { desk?: Partial<DeskState> } | null)?.desk;
  if (!desk || typeof desk !== 'object') return base;
  const channels = Array.isArray(desk.channels)
    ? base.channels.map((c, i) => {
      const s = mergeKnown(c, desk.channels?.[i]);
      return { ...s, xf: (['A', 'T', 'B'] as Xf[]).includes(s.xf) ? s.xf : 'T' };
    })
    : base.channels;
  const fx = Object.fromEntries(FX_LIST.map(([id]) => [id, mergeKnown(base.fx[id], desk.fx?.[id])]));
  const scenes: Record<string, DeskChannel[]> = {};
  if (desk.scenes && typeof desk.scenes === 'object') {
    for (const [k, v] of Object.entries(desk.scenes)) {
      if (Array.isArray(v) && v.length === 8) scenes[k] = v.map((c, i) => mergeKnown(channels[i], c));
    }
  }
  const flat = mergeKnown(
    { xfd: base.xfd, master: base.master, sel: base.sel, fxLock: base.fxLock, keyLock: base.keyLock, key: base.key },
    desk,
  );
  return {
    ...base,
    ...flat,
    sel: Math.max(0, Math.min(7, Math.round(flat.sel))),
    key: KEYS.includes(flat.key) ? flat.key : base.key,
    curve: desk.curve === 'cut' ? 'cut' : 'smooth',
    bank: desk.bank === 'B' ? 'B' : 'A',
    padPage: (['drop', 'drum', 'chord', 'voc'] as const).includes(desk.padPage as DeskState['padPage']) ? desk.padPage as DeskState['padPage'] : 'drop',
    macros: mergeKnown(base.macros, desk.macros),
    channels, fx, scenes,
  };
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

const db2g = (d: number) => Math.pow(10, d / 20);
/** Crossfader-Anteil je Seite: weich = gleiche Leistung, hart = Schnitt. */
function xfGain(side: Xf, x: number, curve: DeskState['curve']): number {
  if (side === 'T') return 1;
  const v = side === 'A' ? 1 - x : x;
  if (curve === 'cut') return v > 0.02 ? 1 : 0;
  return Math.sin((v * Math.PI) / 2);
}
function effectiveGain(s: DeskState, i: number): number {
  const c = s.channels[i];
  const soloOn = s.channels.some((x) => x.solo);
  if (c.mute || (soloOn && !c.solo)) return 0;
  return Math.min(1.5, c.fader * db2g(c.trim) * xfGain(c.xf, s.xfd, s.curve));
}
function pushChannel(s: DeskState, i: number): void {
  const c = s.channels[i];
  const t = TRACKS[i];
  audioEngine.setChannelGain(t, effectiveGain(s, i));
  audioEngine.setChannelEQ(t, 'high', c.hi);
  audioEngine.setChannelEQ(t, 'mid', c.mid);
  audioEngine.setChannelEQ(t, 'low', c.low);
  audioEngine.setChannelPan(t, c.pan);
}
function pushAll(s: DeskState): void {
  for (let i = 0; i < 8; i += 1) pushChannel(s, i);
}

/* ------------------------------------------------------------------ */
/* Live-Anzeigen (Pegel, Wellenform, Jog)                              */
/* ------------------------------------------------------------------ */

/** Main-Pegel aus dem Analyser am Ausgang (0..1), etwa alle 50 ms. */
function useMainLevel(): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let analyser: AnalyserNode | null = null;
    let buf: Float32Array | null = null;
    const id = window.setInterval(() => {
      if (!analyser) {
        try { analyser = audioEngine.createVisualAnalyser(1024); } catch { analyser = null; }
        if (analyser) buf = new Float32Array(analyser.fftSize);
      }
      if (!analyser || !buf) return;
      analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
      let peak = 0;
      for (let i = 0; i < buf.length; i += 4) peak = Math.max(peak, Math.abs(buf[i]));
      const dbv = 20 * Math.log10(Math.max(peak, 1e-5));
      setLevel(Math.max(0, Math.min(1, (dbv + 48) / 48)));
    }, 50);
    return () => {
      window.clearInterval(id);
      if (analyser) try { audioEngine.disconnectVisualAnalyser(analyser); } catch { /* noop */ }
    };
  }, []);
  return level;
}

function DeckScope({ playing }: { playing: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let analyser: AnalyserNode | null = null;
    try { analyser = audioEngine.createVisualAnalyser(1024); } catch { analyser = null; }
    const buf = new Float32Array(analyser?.fftSize ?? 1024);
    let raf = 0;
    const draw = () => {
      if (cv.clientWidth < 2) { if (playing) raf = requestAnimationFrame(draw); return; }
      const w = (cv.width = cv.clientWidth * devicePixelRatio);
      const h = (cv.height = cv.clientHeight * devicePixelRatio);
      const g = cv.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, w, h);
      g.strokeStyle = 'rgba(76,201,240,.18)';
      g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
      if (analyser) analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
      g.strokeStyle = '#ff8a3d';
      g.lineWidth = 1.5 * devicePixelRatio;
      g.beginPath();
      for (let x = 0; x < w; x += 1) {
        const v = analyser ? buf[Math.floor((x / w) * buf.length)] : 0;
        const y = h / 2 - v * h * 0.45;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      if (playing) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      if (analyser) try { audioEngine.disconnectVisualAnalyser(analyser); } catch { /* noop */ }
    };
  }, [playing]);
  return <canvas ref={ref} aria-hidden="true" />;
}

/** Jogwheel: dreht mit dem Transport, Ziehen schiebt das Tempo kurz an (Nudge). */
function Jog({ bpm, playing, disabled }: { bpm: number; playing: boolean; disabled: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const nudge = useRef<{ x: number } | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let raf = 0;
    let retry = 0;
    const draw = () => {
      // Eingeklappt (bei Nicht-Haltern) hat der Canvas keine Größe: später erneut.
      if (cv.clientWidth < 20) { retry = window.setTimeout(draw, 500); return; }
      const s = (cv.width = cv.clientWidth * devicePixelRatio);
      cv.height = s;
      const g = cv.getContext('2d');
      if (!g) return;
      const c = s / 2;
      const ang = (audioEngine.getTransportSeconds() * (33.3 / 60)) * Math.PI * 2;
      g.clearRect(0, 0, s, s);
      const ring = g.createRadialGradient(c, c, c * 0.2, c, c, c);
      ring.addColorStop(0, '#1d2638'); ring.addColorStop(0.75, '#0b101a'); ring.addColorStop(1, '#2a3446');
      g.fillStyle = ring; g.beginPath(); g.arc(c, c, c - 2, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(76,201,240,.55)'; g.lineWidth = 2 * devicePixelRatio;
      g.beginPath(); g.arc(c, c, c - 6 * devicePixelRatio, 0, Math.PI * 2); g.stroke();
      for (let i = 0; i < 48; i += 1) {
        const a = ang + (i / 48) * Math.PI * 2;
        g.strokeStyle = i % 4 === 0 ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.08)';
        g.beginPath();
        g.moveTo(c + Math.cos(a) * c * 0.62, c + Math.sin(a) * c * 0.62);
        g.lineTo(c + Math.cos(a) * c * 0.8, c + Math.sin(a) * c * 0.8);
        g.stroke();
      }
      g.fillStyle = '#ff8a3d';
      g.beginPath(); g.arc(c + Math.cos(ang) * c * 0.72, c + Math.sin(ang) * c * 0.72, 5 * devicePixelRatio, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#05080e'; g.beginPath(); g.arc(c, c, c * 0.32, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#d5e2fb'; g.font = `600 ${12 * devicePixelRatio}px "JetBrains Mono", monospace`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(bpm.toFixed(1), c, c);
      if (playing) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); window.clearTimeout(retry); };
  }, [bpm, playing]);
  return (
    <div
      className="am-jog"
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

const goTo = (id: string) => document.getElementById(`rack-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

/* ------------------------------------------------------------------ */
/* Kanalzug                                                            */
/* ------------------------------------------------------------------ */

function ChannelStrip({ i, c, level, src, owner, mode, synced, onPatch, onCue, onPlay, disabled }: {
  i: number; c: DeskChannel; level: number; src: string; owner: string; mode: string; synced: boolean;
  onPatch: (p: Partial<DeskChannel>) => void; onCue: () => void; onPlay: () => void; disabled: boolean;
}) {
  const m = AM_MODULE[src];
  const n = i + 1;
  return (
    <div className="am-cs" style={{ ['--c' as string]: amColor(src) }} data-channel={n}>
      <div className="am-chd">{n}</div>
      <div className="am-cnm">{CHANNEL_NAMES[i]}</div>
      <span className="am-own">{m?.name ?? src}<br /><b>{owner}</b> · {mode}</span>
      <div className="am-k2">
        <AmKnob size="s" gold value={c.hi} min={-26} max={6} def={0} unit="db" label="Hi" title={`Höhen Kanal ${n}`} onChange={(v) => onPatch({ hi: v })} disabled={disabled} />
        <AmKnob size="s" value={c.trim} min={-12} max={12} def={0} unit="db" label="Trim" title={`Trim Kanal ${n}`} onChange={(v) => onPatch({ trim: v })} disabled={disabled} />
        <AmKnob size="s" gold value={c.mid} min={-26} max={6} def={0} unit="db" label="Mid" title={`Mitten Kanal ${n}`} onChange={(v) => onPatch({ mid: v })} disabled={disabled} />
        <AmKnob size="s" value={c.filter} min={-1} max={1} def={0} unit="flt" label="Filter" title={`Filter Kanal ${n}: links Tiefpass, rechts Hochpass`} onChange={(v) => onPatch({ filter: v })} disabled={disabled} />
        <AmKnob size="s" gold value={c.low} min={-26} max={6} def={0} unit="db" label="Low" title={`Bässe Kanal ${n}`} onChange={(v) => onPatch({ low: v })} disabled={disabled} />
        <AmKnob size="s" value={c.send} min={0} max={1} def={0} unit="pct" label="FX Send" title={`Effekt-Send Kanal ${n}`} onChange={(v) => onPatch({ send: v })} disabled={disabled} />
        <span />
        <AmKnob size="s" value={c.pan} min={-1} max={1} def={0} unit="bi" label="Pan" title={`Panorama Kanal ${n}`} onChange={(v) => onPatch({ pan: v })} disabled={disabled} />
      </div>
      <div className="am-r3">
        <AmToggle kind="m" on={c.mute} onClick={() => onPatch({ mute: !c.mute })} title="Stumm" ariaLabel={`Mute Kanal ${n}`} disabled={disabled}>M</AmToggle>
        <AmToggle kind="s" on={c.solo} onClick={() => onPatch({ solo: !c.solo })} title="Solo" ariaLabel={`Solo Kanal ${n}`} disabled={disabled}>S</AmToggle>
      </div>
      <div className="am-fz">
        <AmMeter level={level} />
        <AmFader value={c.fader} def={0.75} label={`Kanalfader ${n}`} onChange={(v) => onPatch({ fader: v })} disabled={disabled} />
      </div>
      <div className="am-xf" role="group" aria-label={`Crossfader-Zuweisung Kanal ${n}`}>
        {([['A', 'A'], ['T', 'THRU'], ['B', 'B']] as [Xf, string][]).map(([v, l]) => (
          <button key={v} type="button" className={c.xf === v ? 'am-on' : ''} aria-pressed={c.xf === v} disabled={disabled} onClick={() => onPatch({ xf: v })}>{l}</button>
        ))}
      </div>
      <span className={`am-syncb ${synced ? 'am-on' : ''}`} title={synced ? 'Synchron zu Main: Start auf dem nächsten Takt' : 'Frei: startet sofort'}>
        {synced ? '⟲ SYNC' : 'FREI'}
      </span>
      <button type="button" className={`am-cuebtn ${c.cue ? 'am-on' : ''}`} aria-pressed={c.cue} aria-label={`CUE Kanal ${n}${c.cue ? ' aktiv' : ''}`} title="Vorhören (Kopfhörer)" disabled={disabled} onClick={onCue}>CUE</button>
      <div className="am-pp">
        <button type="button" className="am-play" aria-label={`Kanal ${n} auf Main spielen`} title={mode === 'OFF' ? `Quelle ${m?.name ?? src} ist OFF` : 'Auf Main spielen'} disabled={disabled || c.mute} onClick={onPlay}>▶</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pult                                                                */
/* ------------------------------------------------------------------ */

export const MixerDesk = React.memo(function MixerDesk() {
  const [s, setS] = useState<DeskState>(() => restoreState(readPluginSettings('mixer')));
  const sRef = useRef(s);
  const people = useSessionPeople();
  const { pluginLocks } = usePluginManager();
  const { moduleStates } = useModuleState();
  useSyncExternalStore(subscribePluginSync, pluginSyncVersion, pluginSyncVersion);

  const [isHolder, setIsHolder] = useState(() => webRTCManager.isMainOutOwner);
  const [playing, setPlaying] = useState(() => audioEngine.getIsPlaying());
  const [bpm, setBpmState] = useState(() => audioEngine.getBpm());
  const [sceneSave, setSceneSave] = useState(false);
  const [scene, setScene] = useState(0);
  const mainLevel = useMainLevel();
  const tapTimes = useRef<number[]>([]);

  // Autoload Kanal 1 und Titel je Kanal (Titel brauchen Audiodaten – nicht im Stand).
  const autoloadSong = useMemo(() => loadAutoloadSong(), []);
  const autoloadTrack = useMemo<MusicTrack | null>(
    () => (autoloadSong ? SORTED_MUSIC_LIBRARY.find((t) => t.url === autoloadSong.url) ?? null : null),
    [autoloadSong],
  );
  const [autoload, setAutoload] = useState<AutoloadSong | null>(() => autoloadSong);
  const [titles, setTitles] = useState<(MusicTrack | null)[]>(() => [autoloadTrack, null, null, null, null, null, null, null]);
  const [analysis, setAnalysis] = useState<Record<number, string>>({});

  /* ---- Stand ändern: Engine + Session ---- */
  const update = (fn: (prev: DeskState) => DeskState, push: 'all' | number | 'none' = 'none') => {
    const next = fn(sRef.current);
    sRef.current = next;
    setS(next);
    if (push === 'all') pushAll(next);
    else if (typeof push === 'number') pushChannel(next, push);
  };
  const patchChannel = (i: number, p: Partial<DeskChannel>) => {
    const soloChange = p.solo !== undefined;
    update((prev) => ({ ...prev, channels: prev.channels.map((c, k) => (k === i ? { ...c, ...p } : c)) }), soloChange ? 'all' : i);
  };

  useEffect(() => {
    writePluginSettings('mixer', { desk: s });
  }, [s]);

  // Wer übernimmt, startet mit dem Stand aus der Session – auch in der Engine.
  const holderRef = useRef(false);
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = webRTCManager.isMainOutOwner;
      if (now && !holderRef.current) {
        const restored = restoreState(readPluginSettings('mixer'));
        sRef.current = restored;
        setS(restored);
        pushAll(restored);
        audioEngine.setMasterVolume(restored.master);
      }
      holderRef.current = now;
      setIsHolder(now);
      setPlaying(audioEngine.getIsPlaying());
      setBpmState(audioEngine.getBpm());
    }, 500);
    return () => window.clearInterval(t);
  }, []);

  // Main-Out anderer Clients auf den Fader spiegeln (nicht zurücksenden).
  useEffect(() => webRTCManager.addMainOutUpdateListener((msg: { param?: unknown; value?: unknown }) => {
    if (String(msg?.param ?? '') !== 'masterVolume') return;
    const v = Number(msg?.value);
    if (Number.isFinite(v)) update((prev) => ({ ...prev, master: v }));
  }), []);

  // Autoload: Kanal 1 liegt bereit und startet nach der ersten Geste.
  useEffect(() => {
    if (!autoloadTrack) return;
    audioEngine.loadTrackSample(TRACKS[0], autoloadTrack.url);
    void analyzeMusic(autoloadTrack.url).then((a) => {
      if (a) setAnalysis((p) => ({ ...p, 0: `${a.bpm ?? '–'} BPM · ${a.key ?? a.camelot ?? '–'}` }));
    });
  }, [autoloadTrack]);
  useEffect(() => {
    if (!autoload) return;
    const start = () => { if (webRTCManager.isMainOutOwner) void audioEngine.play(); };
    window.addEventListener('pointerdown', start, { once: true });
    window.addEventListener('keydown', start, { once: true });
    return () => {
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
    };
  }, [autoload]);

  const disabled = !isHolder;
  const idx = s.bank === 'A' ? [0, 1, 2, 3] : [4, 5, 6, 7];
  const levels = s.channels.map((_, i) => (playing ? effectiveGain(s, i) / 1.5 : 0));
  const sel = s.sel;
  const selSrc = CH_SRC[sel];

  /* ---- Aktionen ---- */
  const setBpm = (v: number) => {
    const b = Math.max(30, Math.min(300, Math.round(v * 10) / 10));
    audioEngine.setBpm(b);
    setBpmState(b);
  };
  const tap = () => {
    const now = performance.now();
    const t = tapTimes.current.filter((x) => now - x < 2500);
    t.push(now);
    tapTimes.current = t;
    if (t.length >= 3) {
      const gaps = t.slice(1).map((x, k) => x - t[k]);
      setBpm(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
    }
  };
  const loadTitle = (i: number, t: MusicTrack) => {
    setTitles((p) => p.map((x, k) => (k === i ? t : x)));
    audioEngine.loadTrackSample(TRACKS[i], t.url);
    void analyzeMusic(t.url).then((a) => {
      if (a) setAnalysis((p) => ({ ...p, [i]: `${a.bpm ?? '–'} BPM · ${a.key ?? a.camelot ?? '–'}` }));
    });
  };
  const fireScene = (n: number) => {
    if (sceneSave) {
      update((prev) => ({ ...prev, scenes: { ...prev.scenes, [n]: prev.channels.map((c) => ({ ...c })) } }));
      setSceneSave(false);
      setScene(n);
      return;
    }
    const sc = s.scenes[n];
    if (!sc) return;
    update((prev) => ({ ...prev, channels: sc.map((c) => ({ ...c })) }), 'all');
    setScene(n);
  };
  const firePad = (k: number) => {
    const page = PAD_PAGES[s.padPage];
    audioEngine.triggerEvent(TRACKS[page.ch], k > 7 ? 1 : 0.8);
  };
  const applyMaster = (v: number) => {
    update((prev) => ({ ...prev, master: v }));
    audioEngine.setMasterVolume(v);
    webRTCManager.sendMainOutUpdate('masterVolume', v);
  };

  const ownerOf = (src: string) => pluginOwnerOf(pluginLocks[src]);
  const modeOfSrc = (src: string) => pluginModeOf(src, moduleStates[src], pluginLocks[src]);
  const bankLevel = (bank: number[]) => Math.max(0, ...bank.map((i) => levels[i]));

  return (
    <div className="am-mixer" data-testid="mixer-desk">
      {/* Kopfleiste: Tempo, Tonart, Transport, Autoload */}
      <div className="am-mxbar">
        <span className="am-lbl">Tempo</span>
        <div className="am-bpm">
          <button type="button" aria-label="Tempo minus" disabled={disabled} onClick={() => setBpm(bpm - 1)}>−</button>
          <output className="am-mono" aria-label="Tempo">{bpm.toFixed(1)}</output>
          <button type="button" aria-label="Tempo plus" disabled={disabled} onClick={() => setBpm(bpm + 1)}>+</button>
        </div>
        <button type="button" className="am-btn" disabled={disabled} onClick={tap} title="Im Takt tippen">TAP</button>
        <span className="am-lbl">Tonart</span>
        <select className="am-sel" aria-label="Tonart" value={s.key} disabled={disabled || s.keyLock}
          title={s.keyLock ? 'KEY LOCK ist an' : 'Tonart des Projekts'}
          onChange={(e) => update((prev) => ({ ...prev, key: e.target.value }))}>
          {KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <span className="am-hint">mixerMONK · 8 CH · 2 Bänke</span>
        <div role="group" aria-label="Transport" style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          <button type="button" className={`am-btn ${playing ? 'am-pri' : ''}`} style={{ ['--c' as string]: 'var(--ok)' }} disabled={disabled}
            title={disabled ? 'Nur der mixerMONK-Halter steuert den Transport' : 'Transport starten'}
            onClick={() => { if (webRTCManager.isMainOutOwner) void audioEngine.play(); }}>▶ PLAY</button>
          <button type="button" className="am-btn" disabled={disabled}
            title={disabled ? 'Nur der mixerMONK-Halter steuert den Transport' : 'Transport stoppen'}
            onClick={() => { if (webRTCManager.isMainOutOwner) audioEngine.stop(); }}>■ STOP</button>
          <span aria-live="polite" className="am-mono" style={{ fontSize: 11, color: playing ? 'var(--ok)' : 'var(--dm)' }}>{playing ? 'LÄUFT' : 'HALT'}</span>
          {autoload ? (
            <>
              <span className="am-hint" title={`Autoload Kanal 1: ${autoload.name}`}>AUTOLOAD · {autoload.artist}</span>
              <button type="button" className="am-btn" title="Autoload entfernen" onClick={() => { clearAutoloadSong(); setAutoload(null); }}>✕</button>
            </>
          ) : (
            <button type="button" className="am-btn" disabled={!titles[0]}
              title={titles[0] ? `Kanal 1 als Autoload pinnen: ${titles[0].name}` : 'Erst ein Lied auf Kanal 1 laden'}
              onClick={() => {
                const t = titles[0];
                if (!t) return;
                const song: AutoloadSong = { url: t.url, name: t.name, artist: t.artist };
                saveAutoloadSong(song);
                setAutoload(song);
              }}>AUTOLOAD</button>
          )}
        </div>
      </div>

      {/* Signalweg (Verkabelung) – Tippen springt zum Plugin */}
      <div className="am-chain" aria-label="Signalweg (Verkabelung)">
        <span className="am-lbl">Signalweg</span>
        {SIGNAL_CHAIN.filter((st) => st.plugins.length > 0).map((st) => (
          <React.Fragment key={st.id}>
            <span className="am-stg">{st.label}</span>
            {st.plugins.map((id) => (
              <button key={id} type="button" className={modeOfSrc(id) !== 'OFF' ? 'am-on' : ''} style={{ ['--c' as string]: amColor(id) }} onClick={() => goTo(id)}>
                {AM_MODULE[id]?.short ?? id}
              </button>
            ))}
            <span className="am-arrow">→</span>
          </React.Fragment>
        ))}
        <span className="am-stg" style={{ color: 'var(--tx)' }}>Main Out</span>
      </div>

      <div className="am-desk">
        {/* Sprungleiste + Locks */}
        <div className="am-unit am-rail">
          {([['EQ', 'eq'], ['DYN', 'dsp'], ['FX', 'effect'], ['PAN', 'spatial'], ['REC', 'record']] as const).map(([n, id]) => (
            <button key={id} type="button" className="am-rb" onClick={() => goTo(id)} title={`Zu ${id}MONK`}>{n}</button>
          ))}
          <button type="button" className={`am-ring ${s.fxLock ? '' : 'am-off'}`} style={{ ['--rc' as string]: '#ff9f43' }} aria-pressed={s.fxLock} disabled={disabled}
            title="FX LOCK: Makros und Szenen ändern die Effekte nicht" onClick={() => update((p) => ({ ...p, fxLock: !p.fxLock }))}>FX<br />LOCK</button>
          <span className="am-ring" style={{ ['--rc' as string]: personColor(webRTCManager.mainOutOwnerId, people), display: 'grid', placeItems: 'center' }}
            title={`MIX LOCK: ${personLabel(webRTCManager.mainOutOwnerId, people)} hält den Mixer`}>MIX<br />LOCK</span>
        </div>

        {/* Deck: gewählter Kanal */}
        <div className="am-unit am-deck">
          <div className="am-screen">
            <div className="am-ttl">
              <span>{sel + 1} · {CHANNEL_NAMES[sel]} — {AM_MODULE[selSrc]?.name ?? selSrc}</span>
              <span>{playing ? '▶ LÄUFT' : '■ HALT'}</span>
            </div>
            <DeckScope playing={playing} />
            <div className="am-inf"><span>{bpm.toFixed(2)}</span><span>{analysis[sel] ?? titles[sel]?.name ?? 'kein Titel'}</span></div>
          </div>
          <select className="am-sel" value={titles[sel]?.name ?? ''} disabled={disabled}
            aria-label={`Track laden auf Kanal ${sel + 1} (${CHANNEL_NAMES[sel]})`}
            onChange={(e) => { const t = SORTED_MUSIC_LIBRARY.find((x) => x.name === e.target.value); if (t) loadTitle(sel, t); }}>
            <option value="">{titles[sel] ? titles[sel]?.name : '+ Titel auf das Deck laden'}</option>
            {SORTED_MUSIC_LIBRARY.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
          <div className="am-dbtns">
            <button type="button" disabled={disabled} title="Kanal anspielen" onClick={() => audioEngine.triggerEvent(TRACKS[sel], 0.9)}>CUE</button>
            <button type="button" className={s.channels[sel].cue ? 'am-on' : ''} disabled={disabled} title="Vorhören" onClick={() => {
              const next = !s.channels[sel].cue;
              patchChannel(sel, { cue: next });
              audioEngine.setChannelPfl(TRACKS[sel], next);
            }}>PFL</button>
            <button type="button" className={isPluginSynced(selSrc) ? 'am-on' : ''} title="SYNC des Kanals (stellt der Halter der Quelle)" disabled>SYNC</button>
          </div>
          <Jog bpm={bpm} playing={playing} disabled={disabled} />
          <div className="am-deckfoot">
            <button type="button" className="am-db" style={{ ['--bk' as string]: s.bank === 'A' ? 'var(--cue)' : 'var(--warn)' }} disabled={disabled}
              aria-label={`Bank wechseln, jetzt ${s.bank}`} title="Bank wechseln" onClick={() => update((p) => ({ ...p, bank: p.bank === 'A' ? 'B' : 'A' }))}>
              {s.bank === 'A' ? 'A/B' : 'B/A'}
            </button>
            <AmToggle on={s.keyLock} disabled={disabled} onClick={() => update((p) => ({ ...p, keyLock: !p.keyLock }))}>KEY LOCK</AmToggle>
          </div>
        </div>

        {/* Master */}
        <div className="am-unit am-mcol">
          <span className="am-lbl">Master</span>
          <div className="am-mf">
            <AmFader big value={s.master} def={0.8} label="Main-Out LEVEL" onChange={applyMaster} disabled={disabled} />
            <AmMeter level={mainLevel} />
            <AmMeter level={mainLevel} />
          </div>
          <span className="am-hint am-mono">{Math.round(s.master * 100)} %</span>
          <div className="am-ab">
            <button type="button" disabled={disabled} title="Crossfader ganz auf A" onClick={() => update((p) => ({ ...p, xfd: 0 }), 'all')}>A</button>
            <button type="button" disabled={disabled} title="Crossfader ganz auf B" onClick={() => update((p) => ({ ...p, xfd: 1 }), 'all')}>B</button>
          </div>
        </div>

        {/* Kanalzüge der Bank */}
        <div className="am-chans">
          {idx.map((i) => {
            const src = CH_SRC[i];
            const owner = ownerOf(src);
            return (
              <ChannelStrip
                key={i}
                i={i}
                c={s.channels[i]}
                level={levels[i]}
                src={src}
                owner={personLabel(owner, people)}
                mode={modeOfSrc(src)}
                synced={isPluginSynced(src)}
                disabled={disabled}
                onPatch={(p) => patchChannel(i, p)}
                onCue={() => {
                  const next = !s.channels[i].cue;
                  patchChannel(i, { cue: next });
                  audioEngine.setChannelPfl(TRACKS[i], next);
                }}
                onPlay={() => audioEngine.triggerEvent(TRACKS[i], 0.9)}
              />
            );
          })}
        </div>

        {/* Effekte, Pads, Makros, Szenen */}
        <div className="am-rsec">
          <div className="am-unit">
            <table className="am-fxt">
              <thead><tr><th>Effekte</th><th>An</th><th>Amount</th><th>Time</th><th>Feedback</th><th>Mix</th></tr></thead>
              <tbody>
                {FX_LIST.map(([id, name]) => {
                  const r = s.fx[id];
                  const set = (p: Partial<FxRow>) => update((prev) => ({ ...prev, fx: { ...prev.fx, [id]: { ...prev.fx[id], ...p } } }));
                  return (
                    <tr key={id}>
                      <td>{name}</td>
                      <td><AmToggle on={r.on} disabled={disabled} ariaLabel={`${name} an/aus`} onClick={() => set({ on: !r.on })}>●</AmToggle></td>
                      <td><AmBar value={r.amt} color="#4cc9f0" label={`${name} Amount`} disabled={disabled} onChange={(v) => set({ amt: v })} /></td>
                      <td><AmBar value={r.time} color="#a3e635" label={`${name} Time`} disabled={disabled} onChange={(v) => set({ time: v })} /></td>
                      <td><AmBar value={r.fb} color="#ffd166" label={`${name} Feedback`} disabled={disabled} onChange={(v) => set({ fb: v })} /></td>
                      <td><AmBar value={r.mix} color="#ff8fab" label={`${name} Mix`} disabled={disabled} onChange={(v) => set({ mix: v })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="am-unit am-padsec">
            <div className="am-pads" aria-label={`Pads: ${s.padPage}`}>
              {PAD_PAGES[s.padPage].labels.map((l, k) => (
                <button key={k} type="button" className="am-pad" style={{ ['--pc' as string]: PADCOL[k] }} disabled={disabled}
                  title={`Pad ${k + 1} spielt Kanal ${PAD_PAGES[s.padPage].ch + 1}`} onClick={() => firePad(k)}>{l}</button>
              ))}
            </div>
            <div className="am-pgs">
              {([['drop', 'Drops'], ['drum', 'Drums'], ['chord', 'Akkord'], ['voc', 'Vox']] as const).map(([k, n]) => (
                <button key={k} type="button" className={s.padPage === k ? 'am-on' : ''} aria-pressed={s.padPage === k} onClick={() => update((p) => ({ ...p, padPage: k }))}>{n}</button>
              ))}
            </div>
            <div className="am-macros">
              <AmKnob size="l" gold value={s.macros.flt} min={-1} max={1} def={0} unit="flt" label="Macro 1" title="Macro 1: Filter über die Summe" disabled={disabled} onChange={(v) => update((p) => ({ ...p, macros: { ...p.macros, flt: v } }))} />
              <AmKnob size="l" gold value={s.macros.fx} def={0} unit="pct" label="Macro 2" title="Macro 2: alle Effekt-Returns lauter" disabled={disabled} onChange={(v) => update((p) => ({ ...p, macros: { ...p.macros, fx: v } }))} />
              <AmKnob size="l" value={s.macros.build} def={0} unit="pct" label="Macro 3" title="Macro 3: Build-up (Hochpass + Hall)" disabled={disabled} onChange={(v) => update((p) => ({ ...p, macros: { ...p.macros, build: v } }))} />
            </div>
          </div>
          <div className="am-unit" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="am-rowbtns">
              <span className="am-rl">Deck</span>
              {CH_SRC.map((src, k) => (
                <button key={k} type="button" style={{ ['--pc' as string]: amColor(src) }} className={sel === k ? 'am-on' : ''} aria-pressed={sel === k}
                  title={`Kanal ${k + 1} aufs Deck`} onClick={() => update((p) => ({ ...p, sel: k }))}>{k + 1}</button>
              ))}
              <button type="button" style={{ ['--pc' as string]: '#666', width: 40 }} title="Plugin des gewählten Kanals öffnen" onClick={() => goTo(selSrc)}>EDIT</button>
            </div>
            <div className="am-rowbtns">
              <span className="am-rl">Szene</span>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <button key={n} type="button" style={{ ['--pc' as string]: PADCOL[n * 2 - 1] }} className={`${s.scenes[n] ? 'am-has' : ''} ${scene === n ? 'am-on' : ''}`}
                  disabled={disabled} title={sceneSave ? `Szene ${n} sichern` : s.scenes[n] ? `Szene ${n} laden` : `Szene ${n} ist leer`} onClick={() => fireScene(n)}>{n}</button>
              ))}
              <button type="button" style={{ ['--pc' as string]: sceneSave ? '#ff4d4d' : '#666', width: 40 }} className={sceneSave ? 'am-on' : ''} disabled={disabled}
                title="Szene sichern: danach Szene tippen" onClick={() => setSceneSave((v) => !v)}>SAVE</button>
            </div>
          </div>
        </div>
      </div>

      {/* Crossfader */}
      <div className="am-xbar">
        <span className="am-lbl">Crossfader</span>
        <span className="am-ab">A</span>
        <AmHFader value={s.xfd} def={0.5} label="Crossfader A–B" disabled={disabled} onChange={(v) => update((p) => ({ ...p, xfd: v }), 'all')} />
        <span className="am-ab">B</span>
        {([['I', [0, 1, 2, 3], 'var(--cue)'], ['II', [4, 5, 6, 7], 'var(--warn)']] as const).map(([n, bank, col]) => {
          const lit = Math.round(bankLevel([...bank]) * 10);
          return (
            <div key={n} className="am-bankm" style={{ ['--bk' as string]: col }}>
              <div className="am-hm">{Array.from({ length: 10 }, (_, k) => <i key={k} className={k < lit ? 'am-on' : ''} />)}</div>
              <b>{n}</b>
            </div>
          );
        })}
        <AmSeg value={s.curve} label="Crossfader-Kurve" disabled={disabled} options={[['smooth', 'Weich'], ['cut', 'Hart']] as const}
          onChange={(v) => update((p) => ({ ...p, curve: v }), 'all')} />
        <span className="am-hint">I = Bank A (1–4), II = Bank B (5–8). ▶ im Kanal ist der einzige Weg auf Main.</span>
      </div>
    </div>
  );
});
