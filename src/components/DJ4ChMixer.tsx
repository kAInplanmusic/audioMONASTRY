import React, { useEffect, useMemo, useState } from 'react';
import { audioEngine } from '../utils/audioEngine';
import { analyzeMusic } from '../utils/audioAnalyzer';
import { ALL_TRACKS, TrackRole, TrackType, TRACK_ROLE_MAP } from '../types';
import { SORTED_MUSIC_LIBRARY, MusicTrack } from '../data/musicLibrary';
import { DeckPanel, loadDeckSkins, saveDeckSkins, type MixerSkinId } from './mixer/DeckSkins';

/**
 * audioMONASTRY mixerMONK – 6-Kanal-Hardware-Mischpult.
 *
 * Layout exakt nach Vorlage `uimixerMONK.PNG` (Breitbild ~2:1):
 *   - Links:  Controller Deck A (3 Skins: TURNTABLE · PAD · LIBRARY)
 *   - Mitte:  6-Kanal-Mischpult (Utility-Spalte | 6 Kanalzüge | Master-Sektion)
 *   - Rechts: Controller Deck B (3 Skins)
 *   - Unten:  Crossfader-Leiste (A / THRU / B + Gruppenfader 1·2 / 5·6)
 *
 * Kanalzug je Kanal (von oben nach unten, wie Vorlage):
 *   Input-Select · TRIM (Kupfer) · Kanalnummer · HI/MID/LOW · FILTER (Kupfer)
 *   · SEND (Kupfer) · CUE (Orangering) · LED-Meter · Fader
 * Alle Regler wirken REAL auf die AudioEngine. Größere Schrift, Breitbild-first.
 */

type DeckSide = 'A' | 'B';
type XfMode = 'A' | 'THRU' | 'B';

const COPPER = '#b98a78';
const ORANGE = '#f97316';
const CHASSIS = '#1b1b1e';
const PANEL = '#222226';
const GAP = '#26262a';

interface StripConfig {
  index: number;
  track: TrackType;
  deck: DeckSide;
  label: string;
  role: TrackRole;
  accent: string;
}

interface ChannelState {
  trim: number;
  low: number;
  mid: number;
  high: number;
  gain: number;
  pan: number;
  mute: boolean;
  cue: boolean;
  filter: number;
  send: number;
  loadName: string;
  loaded: boolean;
  bpm?: number;
  key?: string;
  analyzing: boolean;
}

const CHANNEL_COUNT = 6;

const ACCENTS = [
  '#f43f5e', // CH1
  '#fb923c', // CH2
  '#22d3ee', // CH3
  '#a78bfa', // CH4
  '#34d399', // CH5
  '#fbbf24', // CH6
];

const ROLE_LABELS: Record<TrackRole, string> = {
  kick: 'KICK',
  hat: 'HAT',
  clap: 'CLAP',
  perc: 'PERC',
  snare: 'SNARE',
  tom: 'TOM',
  bass: 'BASS',
  lead: 'LEAD',
};

/** Feste 6-Kanal-Belegung: CH1–CH3 = Deck A (Crossfader links), CH4–CH6 = Deck B. */
function buildStrips(): StripConfig[] {
  return ALL_TRACKS.slice(0, CHANNEL_COUNT).map((track, i) => ({
    index: i,
    track,
    deck: (i < 3 ? 'A' : 'B') as DeckSide,
    label: `CH ${i + 1}`,
    role: TRACK_ROLE_MAP[track],
    accent: ACCENTS[i % ACCENTS.length],
  }));
}

function freshChannel(): ChannelState {
  return {
    trim: 1, low: 1, mid: 1, high: 1, gain: 0.85, pan: 0.5, mute: false, cue: false,
    filter: 0.5, send: 0, loadName: '', loaded: false, analyzing: false,
  };
}

/** Equal-Power-Crossfader: Mitte = beide Seiten -3 dB statt Lautstärke-Delle. */
const xfGain = (deck: DeckSide, x: number) =>
  deck === 'A' ? Math.cos((x * Math.PI) / 2) : Math.sin((x * Math.PI) / 2);

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/* ------------------------------------------------------------------ */
/* Hardware-Bausteine                                                  */
/* ------------------------------------------------------------------ */

function Knob({
  value, onChange, label, size = 'md', color = COPPER, sub,
}: {
  value: number; onChange: (v: number) => void; label?: string;
  size?: 'sm' | 'md' | 'lg'; color?: string; sub?: string;
}) {
  const deg = -135 + value * 270;
  const w = size === 'lg' ? 'w-12 h-12' : size === 'sm' ? 'w-8 h-8' : 'w-10 h-10';
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const move = (ev: PointerEvent) => onChange(clamp01(1 - (ev.clientY - r.top) / r.height));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  };
  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        onPointerDown={drag}
        onDoubleClick={() => onChange(0.5)}
        className={`${w} relative rounded-full cursor-ns-resize border border-black touch-none bg-[radial-gradient(circle_at_35%_30%,#4a4a50,#2b2b30_60%,#141417)] shadow-[0_2px_6px_rgba(0,0,0,0.7)]`}
      >
        <div className="absolute inset-0 rounded-full" style={{ transform: `rotate(${deg}deg)` }}>
          <div className="absolute left-1/2 top-[6%] h-[28%] w-[2px] -translate-x-1/2 rounded-full"
            style={{ background: color, boxShadow: `0 0 5px ${color}88` }} />
        </div>
      </div>
      {label && <span className="text-[11px] font-bold tracking-[0.12em] text-zinc-400 whitespace-nowrap">{label}</span>}
      {sub && <span className="text-[9px] font-mono text-zinc-600 -mt-0.5">{sub}</span>}
    </div>
  );
}

function Fader({ value, onChange, tall = false, color = ORANGE }: {
  value: number; onChange: (v: number) => void; tall?: boolean; color?: string;
}) {
  const h = tall ? 'h-40' : 'h-36';
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const move = (ev: PointerEvent) => onChange(clamp01(1 - (ev.clientY - r.top) / r.height));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  };
  return (
    <div
      onPointerDown={drag}
      onDoubleClick={() => onChange(0.85)}
      className={`relative ${h} w-4 rounded-full bg-black border border-zinc-700 shadow-inner select-none touch-none cursor-ns-resize`}
    >
      {[0.2, 0.4, 0.6, 0.8].map((p) => (
        <div key={p} className="absolute left-1/2 w-2.5 h-px -translate-x-1/2 bg-zinc-700" style={{ bottom: `${p * 100}%` }} />
      ))}
      <div className="absolute left-1/2 w-8 h-4 -translate-x-1/2 rounded-[3px] bg-gradient-to-b from-[#d4d4d8] to-[#71717a] border border-zinc-500 shadow-[0_1px_4px_rgba(0,0,0,0.8)]"
        style={{ top: `calc(${(1 - value) * 100}% - 8px)` }}>
        <div className="absolute left-1/2 top-1/2 h-[3px] w-6 -translate-x-1/2 -translate-y-1/2 rounded"
          style={{ background: color, boxShadow: `0 0 5px ${color}88` }} />
      </div>
    </div>
  );
}

/** LED-Säule: 12 Segmente, unten grün → amber → rot (wie Vorlage). */
function Meter({ level, tall = true }: { level: number; tall?: boolean }) {
  const lit = Math.round(clamp01(level) * 12);
  return (
    <div className={`flex flex-col-reverse gap-[1px] ${tall ? 'h-36' : 'h-10'} w-2.5 rounded-sm bg-black/90 border border-zinc-800 p-[2px]`}>
      {Array.from({ length: 12 }, (_, i) => {
        const on = i < lit;
        const c = i >= 10 ? 'bg-red-500' : i >= 7 ? 'bg-amber-400' : 'bg-emerald-400';
        return <div key={i} className={`flex-1 rounded-[1px] ${on ? c : 'bg-zinc-900/80'}`} />;
      })}
    </div>
  );
}

/** Horizontales Master-LED-Meter (Stereo: L/R). */
function MasterMeter({ level }: { level: number }) {
  const lit = Math.round(clamp01(level) * 14);
  return (
    <div className="flex flex-col gap-[2px] w-full">
      {['L', 'R'].map((ch) => (
        <div key={ch} className="flex items-center gap-1">
          <span className="text-[9px] font-mono text-zinc-500 w-2">{ch}</span>
          <div className="flex gap-[1px] flex-1 h-3 rounded-sm bg-black/90 border border-zinc-800 p-[2px]">
            {Array.from({ length: 14 }, (_, i) => {
              const on = i < lit;
              const c = i >= 11 ? 'bg-red-500' : i >= 8 ? 'bg-amber-400' : 'bg-emerald-400';
              return <div key={i} className={`flex-1 rounded-[1px] ${on ? c : 'bg-zinc-900/80'}`} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function LedButton({ active, onClick, label, color = ORANGE, round = false }: {
  active: boolean; onClick: () => void; label: string; color?: string; round?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${round ? 'w-9 h-9 rounded-full' : 'px-2 py-1 rounded-[3px] border'} text-[10px] font-black tracking-widest cursor-pointer transition-colors flex items-center justify-center ${
        active
          ? 'bg-black text-black border-transparent'
          : 'bg-black border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'
      }`}
      style={active ? { background: color, boxShadow: `0 0 10px ${color}66` } : undefined}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Sektionen                                                           */
/* ------------------------------------------------------------------ */

/** Linke Utility-Spalte (BEAT FX · USB/MIDI · MIC · PHONES A). */
function UtilityColumn() {
  const [fx, setFx] = useState<string | null>('SHORT DELAY');
  const [usb, setUsb] = useState<'A' | 'B'>('A');
  const [phones, setPhones] = useState({ mix: 0.5, level: 0.6 });
  const [mic, setMic] = useState({ m1: 0.5, m2: 0.5 });
  const fxList = ['SHORT DELAY', 'DUB ECHO', 'SHORT ECHO'];
  return (
    <div className="w-28 shrink-0 bg-[#17171a] rounded-md border border-black/70 p-2 flex flex-col gap-2 shadow-[0_10px_25px_rgba(0,0,0,0.55)]">
      <div className="text-[10px] font-black tracking-[0.25em] text-orange-400 border-b border-zinc-800 pb-1">BEAT FX</div>
      <div className="flex gap-1">
        <LedButton round={false} active={usb === 'A'} onClick={() => setUsb('A')} label="USB A" />
        <LedButton round={false} active={usb === 'B'} onClick={() => setUsb('B')} label="USB B" />
      </div>
      <div className="text-[9px] font-bold tracking-widest text-zinc-500">MIC</div>
      <div className="flex gap-1.5">
        <Knob size="sm" value={mic.m1} onChange={(v) => setMic((p) => ({ ...p, m1: v }))} label="MIC 1" />
        <Knob size="sm" value={mic.m2} onChange={(v) => setMic((p) => ({ ...p, m2: v }))} label="MIC 2" />
      </div>
      <div className="flex flex-col gap-1">
        {fxList.map((f) => (
          <LedButton key={f} active={fx === f} onClick={() => setFx(f)} label={f} />
        ))}
      </div>
      <div className="text-[9px] font-bold tracking-widest text-zinc-500">PHONES A</div>
      <div className="flex gap-1.5">
        <Knob size="sm" value={phones.mix} onChange={(v) => setPhones((p) => ({ ...p, mix: v }))} label="MIX" />
        <Knob size="sm" value={phones.level} onChange={(v) => setPhones((p) => ({ ...p, level: v }))} label="LEVEL" />
      </div>
      <div className="mt-auto text-[9px] font-mono text-zinc-600">BUILT-IN ✕ EXTERNAL</div>
    </div>
  );
}

/** Rechte Master-Sektion (MASTER · BOOTH · PHONES B · MULTI I/O). */
function MasterColumn({ master, onMaster }: { master: number; onMaster: (v: number) => void }) {
  const [booth, setBooth] = useState(0.7);
  const [phones, setPhones] = useState({ mix: 0.5, level: 0.6 });
  const [ioOn, setIoOn] = useState(true);
  return (
    <div className="w-32 shrink-0 bg-[#17171a] rounded-md border border-black/70 p-2.5 flex flex-col items-center gap-2 shadow-[0_10px_25px_rgba(0,0,0,0.55)]">
      <div className="text-[11px] font-black tracking-[0.3em] text-zinc-300">MASTER</div>
      <MasterMeter level={master} />
      <Knob size="lg" value={master} onChange={onMaster} label="LEVEL" color={COPPER} />
      <div className="w-full h-px bg-zinc-800" />
      <div className="text-[9px] font-bold tracking-widest text-zinc-500">BOOTH</div>
      <Knob size="sm" value={booth} onChange={setBooth} label="LEVEL" />
      <div className="w-full h-px bg-zinc-800" />
      <div className="text-[9px] font-bold tracking-widest text-zinc-500">PHONES B</div>
      <div className="flex gap-1.5">
        <Knob size="sm" value={phones.mix} onChange={(v) => setPhones((p) => ({ ...p, mix: v }))} label="MIX" />
        <Knob size="sm" value={phones.level} onChange={(v) => setPhones((p) => ({ ...p, level: v }))} label="LEVEL" />
      </div>
      <div className="w-full h-px bg-zinc-800" />
      <div className="text-[9px] font-bold tracking-widest text-zinc-500">MULTI I/O</div>
      <div className="flex items-center gap-2">
        <span className="w-14 h-6 rounded-[3px] bg-black/80 border border-zinc-800 flex items-center justify-center text-[8px] font-mono text-emerald-400">USB</span>
        <LedButton round active={ioOn} onClick={() => setIoOn((v) => !v)} label="ON" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Kanalzug                                                            */
/* ------------------------------------------------------------------ */

function ChannelStrip({
  s, c, level, onPatch, onCue, onTrigger, onLoad, onRelease, released,
}: {
  s: StripConfig; c: ChannelState; level: number;
  onPatch: (patch: Partial<ChannelState>) => void;
  onCue: () => void; onTrigger: () => void;
  onLoad: (t: MusicTrack) => void;
  onRelease: () => void; released: boolean;
}) {
  return (
    <div className="w-[92px] shrink-0 bg-[#222226] rounded-md border border-black/70 p-2 flex flex-col gap-1.5 shadow-[0_10px_25px_rgba(0,0,0,0.55)]">
      {/* Kopf: Input-Select + FREI */}
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[10px] font-black tracking-widest" style={{ color: s.accent }}>{s.label}</span>
        <span className="text-[8px] font-mono text-zinc-500">{ROLE_LABELS[s.role]}</span>
        <button type="button" onClick={onRelease}
          className={`px-1 py-0.5 rounded-[2px] border text-[8px] font-black tracking-wider cursor-pointer transition-colors ${
            released ? 'bg-cyan-500 border-cyan-400 text-black' : 'bg-black border-zinc-700 text-zinc-500 hover:border-cyan-500/50 hover:text-cyan-300'
          }`}
        >FREI</button>
      </div>

      {/* TRIM (Kupfer) */}
      <div className="flex justify-center">
        <Knob size="md" value={c.trim} onChange={(v) => onPatch({ trim: v })} label="TRIM" color={COPPER} />
      </div>

      {/* Kanalnummer – größte Ziffer des Pults */}
      <div className="text-center text-3xl font-black leading-none text-white/90 select-none">{s.index + 1}</div>

      {/* 3-Band-EQ */}
      <div className="flex justify-between px-0.5">
        <Knob size="sm" value={c.high} onChange={(v) => onPatch({ high: v })} label="HI" color="#e4e4e7" />
        <Knob size="sm" value={c.mid} onChange={(v) => onPatch({ mid: v })} label="MID" color="#e4e4e7" />
        <Knob size="sm" value={c.low} onChange={(v) => onPatch({ low: v })} label="LOW" color="#e4e4e7" />
      </div>

      {/* FILTER + SEND (Kupfer) */}
      <div className="flex justify-between px-1 gap-3">
        <Knob size="sm" value={c.filter} onChange={(v) => onPatch({ filter: v })} label="FILTER" color={COPPER} />
        <Knob size="sm" value={c.send} onChange={(v) => onPatch({ send: v })} label="SEND" color={COPPER} />
      </div>

      {/* CUE */}
      <div className="flex justify-center">
        <button type="button" onClick={onCue}
          className={`w-9 h-9 rounded-full border-2 text-[10px] font-black tracking-widest cursor-pointer transition-all ${
            c.cue ? 'border-orange-400 text-black bg-orange-500 shadow-[0_0_12px_rgba(249,115,22,0.6)]' : 'border-zinc-700 text-zinc-400 bg-black hover:border-orange-500/60'
          }`}
        >CUE</button>
      </div>

      {/* Meter + Fader */}
      <div className="flex items-end justify-center gap-2 pt-0.5">
        <Meter level={level} />
        <Fader value={c.gain} onChange={(v) => onPatch({ gain: v })} />
      </div>

      {/* Footer: LOAD · PLAY · MUTE */}
      <div className="flex flex-col gap-1 pt-0.5">
        <select
          value={c.loaded ? c.loadName : ''}
          onChange={(e) => {
            const t = SORTED_MUSIC_LIBRARY.find((x) => x.name === e.target.value);
            if (t) onLoad(t);
          }}
          className={`w-full text-[9px] rounded-[3px] border px-0.5 py-1 bg-black/70 ${
            c.loaded ? 'border-orange-500/60 text-orange-200' : 'border-zinc-700 text-zinc-400'
          } hover:border-orange-400/60`}
        >
          <option value="">{c.loaded ? c.loadName : '+ TRACK'}</option>
          <option disabled>── MUSIK ──</option>
          {SORTED_MUSIC_LIBRARY.map((t) => (
            <option key={t.id} value={t.name}>{t.name}</option>
          ))}
        </select>
        <div className="flex gap-1">
          <button type="button" onClick={onTrigger}
            className="flex-1 h-7 rounded-[3px] bg-orange-600 hover:bg-orange-500 text-black text-[10px] font-black tracking-widest active:scale-[0.98] cursor-pointer shadow-[0_0_10px_rgba(249,115,22,0.35)]"
          >▶ PLAY</button>
          <button type="button" onClick={() => onPatch({ mute: !c.mute })}
            className={`w-12 h-7 rounded-[3px] border text-[9px] font-black tracking-widest cursor-pointer transition-colors ${
              c.mute ? 'bg-red-600 border-red-500 text-white' : 'bg-black border-zinc-700 text-zinc-500 hover:border-red-500/50 hover:text-red-300'
            }`}
          >MUTE</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hauptkomponente                                                     */
/* ------------------------------------------------------------------ */

export const DJMixer = React.memo(function DJMixer() {
  const strips = useMemo(() => buildStrips(), []);
  const [vw, setVw] = useState(typeof window !== 'undefined' ? window.innerWidth : 1280);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const deckCol = vw >= 1500 ? '240px' : vw >= 1100 ? '200px' : '168px';
  const [ch, setCh] = useState<ChannelState[]>(() => buildStrips().map(freshChannel));
  const [xfd, setXfd] = useState(0.5);
  const [xfMode, setXfMode] = useState<XfMode>('THRU');
  const [master, setMaster] = useState(0.8);
  const [deckSkins, setDeckSkins] = useState<Record<'A' | 'B', MixerSkinId>>(loadDeckSkins);
  const [deckLabels, setDeckLabels] = useState<Record<'A' | 'B', string>>({ A: '', B: '' });
  const [group, setGroup] = useState({ left: 0.8, right: 0.8 });
  const [released, setReleased] = useState<Set<TrackType>>(new Set());

  const toggleRelease = (track: TrackType) => {
    const next = new Set(released);
    if (next.has(track)) next.delete(track);
    else next.add(track);
    setReleased(next);
    audioEngine.setTrackReleased(track, next.has(track));
  };

  const deckChannels = useMemo(() => ({
    A: strips.filter((s) => s.deck === 'A').map((s) => s.track),
    B: strips.filter((s) => s.deck === 'B').map((s) => s.track),
  }), [strips]);

  const handleDeckSkinChange = (deck: 'A' | 'B', skin: MixerSkinId) => {
    setDeckSkins((prev) => {
      const next = { ...prev, [deck]: skin };
      saveDeckSkins(next);
      return next;
    });
  };

  const handleDeckLoad = (deck: 'A' | 'B', label: string) => {
    setDeckLabels((prev) => ({ ...prev, [deck]: label }));
  };

  const db = (v: number) => (v - 1) * 18; // 0..2 -> -18 .. +18 dB (1 = neutral)

  const groupFactor = (s: StripConfig) =>
    s.index === 0 || s.index === 1 ? group.left : s.index === 4 || s.index === 5 ? group.right : 1;

  /** Schreibt den kompletten Kanalzug (Gain → EQ → Pan) in die AudioEngine. */
  const pushStrip = (s: StripConfig, c: ChannelState, xf: number, mode: XfMode = xfMode) => {
    const deckMix = mode === 'THRU' ? 1 : xfGain(s.deck, xf);
    const effective = c.mute ? 0 : c.trim * c.gain * deckMix * groupFactor(s);
    audioEngine.setChannelGain(s.track, effective);
    audioEngine.setChannelEQ(s.track, 'low', db(c.low));
    audioEngine.setChannelEQ(s.track, 'mid', db(c.mid));
    audioEngine.setChannelEQ(s.track, 'high', db(c.high));
    audioEngine.setChannelPan(s.track, (c.pan - 0.5) * 2);
  };

  const apply = (idx: number, patch: Partial<ChannelState>, xf = xfd, mode: XfMode = xfMode) => {
    const next = ch.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    setCh(next);
    const s = strips[idx];
    if (s) pushStrip(s, next[idx], xf, mode);
  };

  const applyMaster = (v: number) => { setMaster(v); audioEngine.setMasterVolume(v); };

  const applyCross = (v: number) => {
    setXfd(v);
    strips.forEach((s, i) => pushStrip(s, ch[i], v));
  };

  const applyXfMode = (m: XfMode) => {
    setXfMode(m);
    strips.forEach((s, i) => pushStrip(s, ch[i], xfd, m));
  };

  const applyGroup = (side: 'left' | 'right', v: number) => {
    const next = { ...group, [side]: v };
    setGroup(next);
    strips.forEach((s, i) => {
      if ((side === 'left' && (s.index === 0 || s.index === 1)) || (side === 'right' && (s.index === 4 || s.index === 5))) {
        pushStrip(s, { ...ch[i], gain: ch[i].gain }, xfd);
      }
    });
  };

  /** LOAD-SLOT: lädt einen Musik-Track, analysiert BPM/Key automatisch. */
  const loadSong = (idx: number, t: MusicTrack) => {
    const next = ch.map((c, i) => (i === idx ? { ...c, loadName: t.name, loaded: true, analyzing: true } : c));
    setCh(next);
    audioEngine.loadTrackSample(strips[idx].track, t.url);
    pushStrip(strips[idx], next[idx], xfd);

    analyzeMusic(t.url).then((a) => {
      setCh((prev) =>
        prev.map((c, i) =>
          i === idx ? { ...c, bpm: a?.bpm, key: a?.key ?? a?.camelot, analyzing: false } : c,
        ),
      );
    });
  };

  /** Play: triggert das geladene Sample / Standard-Material auf dem Kanal. */
  const trigger = (idx: number) => {
    const c = ch[idx];
    if (c.mute) return;
    audioEngine.triggerEvent(strips[idx].track, 0.9);
  };

  return (
    <div className="select-none shrink-0 bg-[#1b1b1e] text-white relative border-t-2 border-b border-zinc-700 rounded-md w-full">
      {/* Metallkante oben */}
      <div className="h-[3px] bg-gradient-to-r from-zinc-700 via-zinc-400 to-zinc-700" />

      {/* Kopfzeile */}
      <div className="flex items-center justify-between px-5 pt-2 pb-1">
        <div className="flex items-center gap-3">
          <span className="text-sm font-black tracking-[0.35em] text-zinc-200">audioMONASTRY</span>
          <span className="text-[11px] font-mono text-orange-400 border border-orange-500/40 px-2 py-0.5 rounded-sm tracking-widest">mixerMONK · 6 CH</span>
        </div>
        <span className="text-[10px] font-mono text-zinc-500 tracking-[0.3em]">DJM-A9</span>
      </div>

      {/* Controller links | 6 Kanalzüge + Utility + Master | Controller rechts */}
      <div className={`grid grid-cols-[${deckCol}_minmax(0,1fr)_${deckCol}] gap-3 px-4 pt-3`}>
        <div className="min-w-0 overflow-hidden">
          <DeckPanel
            deck="A"
            channels={deckChannels.A}
            skin={deckSkins.A}
            onSkinChange={handleDeckSkinChange}
            loadedLabel={deckLabels.A || ch[0]?.loadName || undefined}
            onLoad={(label) => handleDeckLoad('A', label)}
          />
        </div>

        {/* Mischpult-Konsole */}
        <div className="overflow-x-auto min-w-0">
          <div className="flex gap-1.5 min-w-max items-stretch">
            <UtilityColumn />

            {strips.map((s, i) => {
              const c = ch[i];
              const deckMix = xfMode === 'THRU' ? 1 : xfGain(s.deck, xfd);
              const level = c.mute ? 0 : c.trim * c.gain * deckMix * groupFactor(s);
              return (
                <ChannelStrip
                  key={s.track}
                  s={s}
                  c={c}
                  level={level}
                  onPatch={(patch) => apply(i, patch)}
                  onCue={() => {
                    const next = !c.cue;
                    apply(i, { cue: next });
                    audioEngine.setChannelPfl(s.track, next);
                  }}
                  onTrigger={() => trigger(i)}
                  onLoad={(t) => loadSong(i, t)}
                  onRelease={() => toggleRelease(s.track)}
                  released={released.has(s.track)}
                />
              );
            })}

            <MasterColumn master={master} onMaster={applyMaster} />
          </div>
        </div>

        <div className="min-w-0 overflow-hidden">
          <DeckPanel
            deck="B"
            channels={deckChannels.B}
            skin={deckSkins.B}
            onSkinChange={handleDeckSkinChange}
            loadedLabel={deckLabels.B || ch[3]?.loadName || undefined}
            onLoad={(label) => handleDeckLoad('B', label)}
          />
        </div>
      </div>

      {/* 3-Fader-Leiste: links CH1+2 · Mitte Crossfader 1-2-3 ↔ 4-5-6 · rechts CH5+6 */}
      <div className="mt-3 flex items-end justify-center gap-8 rounded-md bg-[#17171a] border border-black/70 px-5 py-3">
        <div className="flex flex-col items-center gap-1.5">
          <Fader tall value={group.left} onChange={(v) => applyGroup('left', v)} />
          <span className="text-[10px] font-mono tracking-widest text-zinc-400">1 · 2</span>
        </div>

        <div className="flex-1 max-w-3xl flex flex-col items-center gap-1.5">
          <div className="text-[10px] font-black tracking-[0.3em] text-zinc-500">CROSSFADER ASSIGN</div>
          <div className="relative w-full h-10 rounded-full bg-black border border-zinc-800 shadow-inner touch-none"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const move = (ev: PointerEvent) => applyCross(clamp01((ev.clientX - r.left) / r.width));
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
            }}>
            <div className="absolute top-0 bottom-0 left-0 w-[45%] rounded-l-full bg-orange-500/10" />
            <div className="absolute top-0 bottom-0 right-0 w-[45%] rounded-r-full bg-orange-500/10" />
            <div className="absolute left-1/2 top-1 bottom-1 w-px bg-zinc-700" />
            <div className="absolute top-1/2 w-10 h-8 -translate-x-1/2 -translate-y-1/2 rounded-[3px] bg-gradient-to-b from-[#d4d4d8] to-[#71717a] border border-zinc-500 shadow-[0_1px_4px_rgba(0,0,0,0.8)]"
              style={{ left: `${xfd * 100}%` }}>
              <div className="absolute left-1/2 top-1/2 h-6 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded"
                style={{ background: ORANGE, boxShadow: `0 0 6px ${ORANGE}` }} />
            </div>
          </div>
          <div className="flex w-full justify-between text-[11px] font-black tracking-widest text-zinc-500">
            <span className={xfMode === 'A' ? 'text-orange-400' : ''}>A · 1 2 3</span>
            <span className={xfMode === 'THRU' ? 'text-orange-400' : ''}>THRU</span>
            <span className={xfMode === 'B' ? 'text-orange-400' : ''}>4 5 6 · B</span>
          </div>
          <div className="flex gap-1.5">
            {(['A', 'THRU', 'B'] as XfMode[]).map((m) => (
              <button type="button" key={m} onClick={() => applyXfMode(m)}
                className={`px-2.5 py-1 rounded-[3px] border text-[10px] font-black tracking-widest cursor-pointer transition-colors ${
                  xfMode === m ? 'bg-orange-500 border-orange-400 text-black' : 'bg-black border-zinc-700 text-zinc-500 hover:border-orange-500/50 hover:text-orange-300'
                }`}
              >{m}</button>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <Fader tall value={group.right} onChange={(v) => applyGroup('right', v)} />
          <span className="text-[10px] font-mono tracking-widest text-zinc-400">5 · 6</span>
        </div>
      </div>

      <div className="h-[3px] bg-gradient-to-r from-zinc-700 via-zinc-400 to-zinc-700" />
    </div>
  );
});

/** Abwärtskompatibler Alias (bisheriger Name). */
export const DJ4ChMixer = DJMixer;
