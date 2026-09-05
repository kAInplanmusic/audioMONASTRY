import React, { useMemo, useState } from 'react';
import { audioEngine } from '../utils/audioEngine';
import { analyzeMusic } from '../utils/audioAnalyzer';
import { ALL_TRACKS, TrackRole, TrackType, TRACK_ROLE_MAP } from '../types';
import { SORTED_MUSIC_LIBRARY, MusicTrack } from '../data/musicLibrary';
import { DeckPanel, loadDeckSkins, saveDeckSkins, type MixerSkinId } from './mixer/DeckSkins';

/**
 * audioMONASTRY mixerMONK – 6-Kanal-Hardware-Mischpult (Optik: DJM-A9).
 *
 * Festes Layout laut Vorlage `uimixerMONK.PNG`:
 *   - 6 Kanalzüge CH1–CH6 (links CH1+2 · Mitte CH3+4 · rechts CH5+6)
 *   - 3 Fader:   links = Gruppe CH1+2 ·  Mitte = Crossfader 1-2-3 ↔ 4-5-6
 *                rechts = Gruppe CH5+6
 *   - Controller links + rechts (je 3 austauschbare Skins: TURNTABLE/PAD/LIBRARY)
 *   - Pro Kanal: TRIM, 3-Band-EQ, CUE (PFL), Meter, MUTE, PLAY, LOAD-SLOT
 * Alle Regler wirken REAL auf die AudioEngine.
 */

type DeckSide = 'A' | 'B';
type XfMode = 'A' | 'THRU' | 'B';

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

const ORANGE = '#f97316';

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
    loadName: '', loaded: false, analyzing: false,
  };
}

/** Equal-Power-Crossfader: Mitte = beide Seiten -3 dB statt Lautstärke-Delle. */
const xfGain = (deck: DeckSide, x: number) =>
  deck === 'A' ? Math.cos((x * Math.PI) / 2) : Math.sin((x * Math.PI) / 2);

/** Pioneer-DJM-A9-Drehpoti (schwarzer Knopf, farbige Indikator-Linie). */
function A9Knob({ value, onChange, label, size = 'md', indicator = ORANGE }: {
  value: number; onChange: (v: number) => void; label?: string;
  size?: 'sm' | 'md' | 'lg'; indicator?: string;
}) {
  const deg = (value - 0.5) * 300;
  const w = size === 'lg' ? 'w-10 h-10' : size === 'sm' ? 'w-6 h-6' : 'w-8 h-8';
  return (
    <div className="flex flex-col items-center gap-0.5 select-none">
      <div
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const move = (ev: PointerEvent) => {
            const dx = ev.clientX - (r.left + r.width / 2);
            onChange(Math.max(0, Math.min(1, 0.5 + dx / 120)));
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
        }}
        onDoubleClick={() => onChange(0.5)}
        className={`${w} relative rounded-full cursor-ns-resize border border-black bg-[radial-gradient(circle_at_35%_30%,#4a4a50,#2b2b30_60%,#141417)] shadow-[0_2px_5px_rgba(0,0,0,0.7)] touch-none`}
      >
        <div className="absolute inset-0 rounded-full" style={{ transform: `rotate(${deg}deg)` }}>
          <div className="absolute left-1/2 top-[7%] h-[26%] w-[2px] -translate-x-1/2 rounded-full" style={{ background: indicator, boxShadow: `0 0 4px ${indicator}88` }} />
        </div>
      </div>
      {label && <span className="text-[6px] font-mono tracking-widest text-zinc-500">{label}</span>}
    </div>
  );
}

/** DJM-A9-Kanalfader (schmale Schiene, dunkle Kappe mit Orangelinie). */
function A9Fader({ value, onChange, tall = false }: { value: number; onChange: (v: number) => void; tall?: boolean }) {
  return (
    <div className={`relative ${tall ? 'h-36 short-landscape:h-24' : 'h-32 short-landscape:h-20'} w-3 rounded-full bg-black border border-zinc-800 shadow-inner select-none touch-none`}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          onChange(Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height)));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
      }}>
      {[0.2, 0.4, 0.6, 0.8].map((p) => (
        <div key={p} className="absolute left-1/2 w-2 h-px -translate-x-1/2 bg-zinc-700" style={{ bottom: `${p * 100}%` }} />
      ))}
      <div className="absolute left-1/2 w-6 h-3.5 -translate-x-1/2 rounded-[2px] bg-gradient-to-b from-[#3c3c42] to-[#1c1c1f] border border-zinc-600 shadow-[0_1px_3px_rgba(0,0,0,0.8)]"
        style={{ top: `calc(${(1 - value) * 100}% - 7px)` }}>
        <div className="absolute left-1/2 top-1/2 h-[2px] w-4 -translate-x-1/2 -translate-y-1/2 rounded" style={{ background: ORANGE, boxShadow: `0 0 4px ${ORANGE}88` }} />
      </div>
    </div>
  );
}

/** DJM-A9-Kanal-Meter (LED-Säule: grün → amber → rot, von unten). */
function A9Meter({ level }: { level: number }) {
  const lvl = Math.max(0, Math.min(1, level));
  const total = 12;
  const lit = Math.round(lvl * total);
  return (
    <div className="flex flex-col-reverse gap-[1px] h-32 short-landscape:h-20 w-2 rounded-sm bg-black/90 border border-zinc-800 p-[2px]">
      {Array.from({ length: total }, (_, i) => {
        const on = i < lit;
        const c = i >= 10 ? 'bg-red-500' : i >= 8 ? 'bg-amber-400' : 'bg-emerald-400';
        return <div key={i} className={`flex-1 rounded-[1px] ${on ? c : 'bg-zinc-900/80'}`} />;
      })}
    </div>
  );
}

/** Horizontales Master-LED-Meter. */
function A9MasterMeter({ level }: { level: number }) {
  const lvl = Math.max(0, Math.min(1, level));
  const total = 14;
  const lit = Math.round(lvl * total);
  return (
    <div className="flex gap-[1px] w-full h-3 rounded-sm bg-black/90 border border-zinc-800 p-[2px]">
      {Array.from({ length: total }, (_, i) => {
        const on = i < lit;
        const c = i >= 11 ? 'bg-red-500' : i >= 9 ? 'bg-amber-400' : 'bg-emerald-400';
        return <div key={i} className={`flex-1 rounded-[1px] ${on ? c : 'bg-zinc-900/80'}`} />;
      })}
    </div>
  );
}

export const DJMixer = React.memo(function DJMixer() {
  const strips = useMemo(() => buildStrips(), []);
  const [ch, setCh] = useState<ChannelState[]>(() => buildStrips().map(freshChannel));
  const [xfd, setXfd] = useState(0.5);
  const [xfMode, setXfMode] = useState<XfMode>('THRU');
  const [master, setMaster] = useState(0.8);
  const [deckSkins, setDeckSkins] = useState<Record<'A' | 'B', MixerSkinId>>(loadDeckSkins);
  const [deckLabels, setDeckLabels] = useState<Record<'A' | 'B', string>>({ A: '', B: '' });
  // Gruppen-Fader: links CH1+2, rechts CH5+6 (CH3+4 laufen direkt).
  const [group, setGroup] = useState({ left: 0.8, right: 0.8 });
  // Vom DJ freigegebene MAIN-Kanäle (andere User dürfen hineinladen).
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

  /** Gruppen-Faktor: linker Fader = CH1+2, rechter Fader = CH5+6. */
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
    // Nur die betroffenen Kanäle neu anwenden.
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
    <div className="select-none shrink-0 bg-[#1b1b1e] text-white relative border-t-2 border-b border-zinc-700 rounded-md">
      {/* Metallkante oben */}
      <div className="h-[3px] bg-gradient-to-r from-zinc-700 via-zinc-400 to-zinc-700" />

      {/* Kopfzeile */}
      <div className="flex items-center justify-between px-4 pt-2 pb-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black tracking-[0.35em] text-zinc-300">audioMONASTRY</span>
          <span className="text-[8px] font-mono text-orange-500 border border-orange-500/40 px-1.5 py-0.5 rounded-sm tracking-widest">mixerMONK · 6 CH</span>
        </div>
        <span className="text-[8px] font-mono text-zinc-500 tracking-[0.3em]">DJM-A9</span>
      </div>

      {/* Controller links | 6 Kanalzüge | Controller rechts */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(200px,1fr)_auto_minmax(200px,1fr)] gap-3 px-3 pt-3">
        <DeckPanel
          deck="A"
          channels={deckChannels.A}
          skin={deckSkins.A}
          onSkinChange={handleDeckSkinChange}
          loadedLabel={deckLabels.A || ch[0]?.loadName || undefined}
          onLoad={(label) => handleDeckLoad('A', label)}
        />

        {/* Kanalzüge */}
        <div className="overflow-x-auto">
          <div className="flex gap-2 min-w-max items-stretch">
            {strips.map((s, i) => {
              const c = ch[i];
              const deckMix = xfMode === 'THRU' ? 1 : xfGain(s.deck, xfd);
              const level = c.mute ? 0 : c.trim * c.gain * deckMix * groupFactor(s);
              return (
                <div key={s.track} className="w-28 short-landscape:w-24 shrink-0 bg-[#222226] rounded-md border border-black/70 p-2 short-landscape:p-1.5 flex flex-col gap-1.5 shadow-[0_10px_25px_rgba(0,0,0,0.55)]">
                  {/* Kanal-Kopf mit CUE + FREI */}
                  <div className="flex items-center justify-between px-0.5 gap-1">
                    <span className="text-[9px] font-black tracking-widest text-zinc-200">{s.label}</span>
                    <span className="text-[6px] font-mono text-zinc-500">{ROLE_LABELS[s.role]}</span>
                    <button type="button"
                      onClick={() => toggleRelease(s.track)}
                      title={released.has(s.track) ? 'Kanal-Freigabe zurücknehmen' : 'Kanal für andere User freigeben (Laden erlaubt)'}
                      className={`w-7 h-4 rounded-[2px] border text-[5px] font-black tracking-wider cursor-pointer transition-colors ${
                        released.has(s.track) ? 'bg-cyan-500 border-cyan-400 text-black' : 'bg-black border-zinc-700 text-zinc-500 hover:border-cyan-500/50 hover:text-cyan-300'
                      }`}
                    >FREI</button>
                    <button type="button"
                      onClick={() => {
                        const next = !c.cue;
                        apply(i, { cue: next });
                        audioEngine.setChannelPfl(s.track, next);
                      }}
                      className={`w-6 h-4 rounded-[2px] border text-[6px] font-black tracking-widest cursor-pointer transition-colors ${
                        c.cue ? 'bg-orange-500 border-orange-400 text-black' : 'bg-black border-zinc-700 text-zinc-500 hover:border-orange-500/50 hover:text-orange-300'
                      }`}
                    >CUE</button>
                  </div>

                  <div className="flex gap-1.5">
                    <div className="flex-1 flex flex-col items-center gap-1">
                      <A9Knob size="md" value={c.trim} onChange={(v) => apply(i, { trim: v })} label="TRIM" />
                      <div className="flex gap-1">
                        <A9Knob size="sm" value={c.high} onChange={(v) => apply(i, { high: v })} label="HI" indicator={ORANGE} />
                        <A9Knob size="sm" value={c.mid} onChange={(v) => apply(i, { mid: v })} label="MID" indicator="#e4e4e7" />
                        <A9Knob size="sm" value={c.low} onChange={(v) => apply(i, { low: v })} label="LOW" indicator={ORANGE} />
                      </div>

                      {/* BPM / KEY */}
                      <div className="w-full flex justify-between text-[7px] font-mono px-0.5 rounded-sm bg-black/50 py-0.5">
                        <span className="text-emerald-400">{c.analyzing ? '…' : (c.bpm ?? '---')}</span>
                        <span className="text-zinc-400">{c.key ?? '--'}</span>
                      </div>

                      {/* LOAD-SLOT */}
                      <select
                        value={c.loaded ? c.loadName : ''}
                        onChange={(e) => {
                          const t = SORTED_MUSIC_LIBRARY.find((x) => x.name === e.target.value);
                          if (t) loadSong(i, t);
                        }}
                        className={`w-full text-[7px] rounded-sm border px-0.5 py-1 bg-black/70 ${
                          c.loaded ? 'border-orange-500/60 text-orange-200' : 'border-zinc-700 text-zinc-400'
                        } hover:border-orange-400/60`}
                      >
                        <option value="">{c.loaded ? c.loadName : '+ TRACK'}</option>
                        <option disabled>── MUSIK ──</option>
                        {SORTED_MUSIC_LIBRARY.map((t) => (
                          <option key={t.id} value={t.name} className="text-neutral-300">{t.name}</option>
                        ))}
                      </select>

                      <button type="button"
                        onClick={() => trigger(i)}
                        className="w-full h-6 rounded-sm bg-orange-600 hover:bg-orange-500 text-black text-[8px] font-black tracking-widest active:scale-[0.98] cursor-pointer shadow-[0_0_10px_rgba(249,115,22,0.35)]"
                      >▶ PLAY</button>

                      <button type="button"
                        onClick={() => apply(i, { mute: !c.mute })}
                        className={`w-full h-4 rounded-[2px] border text-[6px] font-black tracking-widest cursor-pointer transition-colors ${
                          c.mute ? 'bg-red-600 border-red-500 text-white' : 'bg-black border-zinc-700 text-zinc-500 hover:border-red-500/50 hover:text-red-300'
                        }`}
                      >MUTE</button>
                    </div>

                    <div className="flex items-end gap-1 pb-1">
                      <A9Meter level={level} />
                      <A9Fader value={c.gain} onChange={(v) => apply(i, { gain: v })} />
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Master-Sektion */}
            <div className="w-36 shrink-0 bg-[#222226] rounded-md border border-black/70 p-3 flex flex-col items-center gap-2 shadow-[0_10px_25px_rgba(0,0,0,0.55)]">
              <div className="text-[8px] font-black tracking-[0.25em] text-zinc-400">MASTER</div>
              <A9MasterMeter level={master} />
              <A9Knob size="lg" value={master} onChange={applyMaster} label="LEVEL" />
              <div className="text-[6px] font-mono text-zinc-600 tracking-widest mt-1">DJM-A9 · MONK</div>
            </div>
          </div>
        </div>

        <DeckPanel
          deck="B"
          channels={deckChannels.B}
          skin={deckSkins.B}
          onSkinChange={handleDeckSkinChange}
          loadedLabel={deckLabels.B || ch[3]?.loadName || undefined}
          onLoad={(label) => handleDeckLoad('B', label)}
        />
      </div>

      {/* 3-Fader-Leiste: links CH1+2 · Mitte Crossfader 1-2-3 ↔ 4-5-6 · rechts CH5+6 */}
      <div className="mt-3 flex items-end justify-center gap-6 rounded-md bg-[#17171a] border border-black/70 px-4 py-3">
        <div className="flex flex-col items-center gap-1">
          <A9Fader tall value={group.left} onChange={(v) => applyGroup('left', v)} />
          <span className="text-[7px] font-mono tracking-widest text-zinc-400">1 · 2</span>
        </div>

        <div className="flex-1 max-w-2xl flex flex-col items-center gap-1">
          <div className="relative w-full h-9 rounded-full bg-black border border-zinc-800 shadow-inner touch-none"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const move = (ev: PointerEvent) => applyCross(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)));
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
            }}>
            <div className="absolute top-0 bottom-0 left-0 w-[45%] rounded-l-full bg-orange-500/10" />
            <div className="absolute top-0 bottom-0 right-0 w-[45%] rounded-r-full bg-orange-500/10" />
            <div className="absolute left-1/2 top-1 bottom-1 w-px bg-zinc-700" />
            <div className="absolute top-1/2 w-8 h-7 -translate-x-1/2 -translate-y-1/2 rounded-[2px] bg-gradient-to-b from-[#3c3c42] to-[#1c1c1f] border border-zinc-600 shadow-[0_1px_3px_rgba(0,0,0,0.8)]"
              style={{ left: `${xfd * 100}%` }}>
              <div className="absolute left-1/2 top-1/2 h-5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded" style={{ background: ORANGE, boxShadow: `0 0 5px ${ORANGE}` }} />
            </div>
          </div>
          <div className="flex w-full justify-between text-[7px] font-mono tracking-widest text-zinc-500">
            <span className={xfMode === 'A' ? 'text-orange-400' : ''}>A · 1 2 3</span>
            <span className={xfMode === 'THRU' ? 'text-orange-400' : ''}>THRU</span>
            <span className={xfMode === 'B' ? 'text-orange-400' : ''}>4 5 6 · B</span>
          </div>
          <div className="flex gap-1">
            {(['A', 'THRU', 'B'] as XfMode[]).map((m) => (
              <button type="button"
                key={m}
                onClick={() => applyXfMode(m)}
                className={`px-1.5 py-0.5 rounded-[2px] border text-[7px] font-black tracking-widest cursor-pointer transition-colors ${
                  xfMode === m ? 'bg-orange-500 border-orange-400 text-black' : 'bg-black border-zinc-700 text-zinc-500 hover:border-orange-500/50 hover:text-orange-300'
                }`}
              >{m}</button>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-center gap-1">
          <A9Fader tall value={group.right} onChange={(v) => applyGroup('right', v)} />
          <span className="text-[7px] font-mono tracking-widest text-zinc-400">5 · 6</span>
        </div>
      </div>

      <div className="h-[3px] bg-gradient-to-r from-zinc-700 via-zinc-400 to-zinc-700" />
    </div>
  );
});

/** Abwärtskompatibler Alias (bisheriger Name). */
export const DJ4ChMixer = DJMixer;
