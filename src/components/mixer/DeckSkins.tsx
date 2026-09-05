import React, { useMemo, useRef, useState } from 'react';
import { Disc3, Library, LayoutGrid } from 'lucide-react';
import { audioEngine } from '../../utils/audioEngine';
import { SORTED_MUSIC_LIBRARY } from '../../data/musicLibrary';
import type { TrackType } from '../../types';

/**
 * mixerMONK Deck-Controller (links/rechts im festen DJ-Mixer).
 * ============================================================
 * Vorlagen:
 *   uimixercontroller1.jpg → ODJ-1500X  (CDJ-Player: Display, Hot-Cues, Jogwheel)
 *   uimixercontroller2.jpg → DJS-1000   (Sampler: Display-Haube, 4×4-Pads, Chrom-Transport)
 *   uimixercontroller3.jpg → LIBRARY    (Track-Browser)
 * Skins je Deck umschaltbar und in localStorage persistiert.
 */

export type MixerSkinId = 'TURNTABLE' | 'PAD' | 'LIBRARY';

export const DECK_SKIN_STORAGE_KEY = 'audiomonastry_deck_skins';

const SKIN_OPTIONS: { id: MixerSkinId; label: string; icon: React.ReactNode }[] = [
  { id: 'TURNTABLE', label: 'CDJ', icon: <Disc3 className="w-3.5 h-3.5" /> },
  { id: 'PAD', label: 'DJS', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
  { id: 'LIBRARY', label: 'LIB', icon: <Library className="w-3.5 h-3.5" /> },
];

interface DeckPanelProps {
  deck: 'A' | 'B';
  channels: TrackType[];
  skin: MixerSkinId;
  onSkinChange: (deck: 'A' | 'B', skin: MixerSkinId) => void;
  loadedLabel?: string;
  onLoad?: (label: string) => void;
}

/* ------------------------------------------------------------------ */
/* CDJ-1500X Skin (Controller 1)                                       */
/* ------------------------------------------------------------------ */

const ORANGE = '#ff7a15';
const GREEN = '#3ede63';

function useWaveform(seed: number, bars: number, spread = 0.9) {
  return useMemo(() => {
    const out: number[] = [];
    let x = seed;
    for (let i = 0; i < bars; i++) {
      x = (x * 16807) % 2147483647;
      out.push(0.15 + ((x / 2147483647) * spread));
    }
    return out;
  }, [seed, bars, spread]);
}

function CdjSkin({ channels, loadedLabel }: { channels: TrackType[]; loadedLabel?: string }) {
  const [rotation, setRotation] = useState(0);
  const [pitch, setPitch] = useState(0);
  const lastYRef = useRef<number | null>(null);
  const wave = useWaveform(channels.length + 3, 64);
  const waveTop = useWaveform(channels.length + 9, 96, 0.7);

  const handleJog = (e: React.PointerEvent<HTMLDivElement>) => {
    const move = (ev: PointerEvent) => {
      if (lastYRef.current !== null) setRotation((r) => r + (ev.clientY - lastYRef.current) * 2.5);
      lastYRef.current = ev.clientY;
    };
    const up = () => {
      lastYRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  return (
    <div className="flex flex-col gap-2 p-2 select-none">
      {/* Touch-Display */}
      <div className="rounded-[4px] border-2 border-black bg-[#0a0a0c] p-[3px] shadow-[inset_0_0_12px_rgba(0,0,0,0.9)]">
        <div className="rounded-[2px] bg-[#111214] overflow-hidden">
          {/* Kopfzeile */}
          <div className="flex items-center gap-1.5 bg-[#1b1c1f] px-2 py-1">
            <span className="w-4 h-4 rounded-sm bg-[#2f7ee0]/70" />
            <div className="min-w-0 flex-1 leading-none">
              <div className="text-[10px] font-bold text-white truncate">{loadedLabel ?? '7 Above The Cloud (Original Mix)'}</div>
              <div className="text-[8px] font-mono text-neutral-400 mt-0.5">07:56 · -05d · Cm</div>
            </div>
            <span className="text-[7px] font-mono text-neutral-400">04.9GHz</span>
          </div>
          {/* Wellenform */}
          <div className="h-10 flex items-end gap-[1px] px-1 py-1">
            {wave.map((v, i) => (
              <div key={i} className="flex-1 rounded-[1px]" style={{ height: `${v * 100}%`, background: i > 44 ? 'rgba(47,126,224,0.9)' : i % 5 === 0 ? 'rgba(240,162,74,0.95)' : 'rgba(242,242,242,0.85)' }} />
            ))}
          </div>
          {/* Info-Leiste */}
          <div className="grid grid-cols-4 gap-px bg-[#2b2c30] text-center">
            <div className="bg-[#111214] py-0.5"><div className="text-[7px] font-mono text-neutral-500">PLAYER</div><div className="text-[10px] font-black text-white">1</div></div>
            <div className="bg-[#111214] py-0.5"><div className="text-[7px] font-mono text-neutral-500">TEMPO</div><div className="text-[10px] font-black text-white">+{pitch / 10}%</div></div>
            <div className="bg-[#111214] py-0.5"><div className="text-[7px] font-mono text-neutral-500">BPM</div><div className="text-[10px] font-black text-white">126.0</div></div>
            <div className="bg-[#111214] py-0.5"><div className="text-[7px] font-mono text-neutral-500">REMAIN</div><div className="text-[10px] font-black text-white">07:21<span className="text-[7px] text-neutral-400">.327</span></div></div>
          </div>
          {/* Übersichts-Welle */}
          <div className="h-6 flex items-end gap-[1px] px-1 py-1 border-t border-[#2b2c30]">
            {waveTop.map((v, i) => (
              <div key={i} className="flex-1 rounded-[1px]" style={{ height: `${v * 100}%`, background: i % 7 === 0 ? 'rgba(255,215,0,0.8)' : i % 5 === 0 ? 'rgba(62,222,99,0.8)' : 'rgba(47,126,224,0.8)' }} />
            ))}
          </div>
        </div>
      </div>

      {/* HOT CUE Leiste */}
      <div>
        <div className="text-center text-[8px] font-bold tracking-[0.3em] text-neutral-500 mb-1">HOT CUE</div>
        <div className="flex items-center gap-1">
          <button type="button" className="px-2 py-1.5 rounded-full bg-[#2a2b2f] border border-[#3a3b40] text-[8px] font-bold text-neutral-400 cursor-pointer">DEL</button>
          <div className="flex-1 grid grid-cols-8 gap-1">
            {['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((h) => (
              <button key={h} type="button"
                onClick={() => audioEngine.triggerEvent(channels[0], 0.9)}
                className="aspect-[1.4] rounded-[3px] bg-[#26272b] border border-[#3a3b40] text-[9px] font-black cursor-pointer active:scale-95 transition-transform"
                style={{ color: ORANGE, textShadow: `0 0 6px ${ORANGE}88` }}
              >{h}</button>
            ))}
          </div>
          <button type="button" className="px-2 py-1.5 rounded-full bg-[#2a2b2f] border border-[#3a3b40] text-[8px] font-bold text-neutral-400 cursor-pointer">CUE</button>
        </div>
      </div>

      {/* Jogwheel + Seiten */}
      <div className="flex items-center gap-2">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col items-center">
            <span className="text-[8px] font-mono text-neutral-500">PITCH</span>
            <input type="range" min={-100} max={100} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} className="h-1.5 w-14 accent-orange-500" />
            <span className="text-[9px] font-mono text-orange-400">{pitch > 0 ? '+' : ''}{pitch / 10}%</span>
          </div>
          <button type="button" className="w-10 h-6 rounded-full border border-blue-400/60 bg-blue-500/15 text-[8px] font-bold text-blue-300 cursor-pointer">SYNC</button>
        </div>

        <div
          onPointerDown={handleJog}
          className="w-24 h-24 shrink-0 rounded-full cursor-ns-resize touch-none relative border-4 border-[#2a2b2f] shadow-[inset_0_0_20px_rgba(0,0,0,0.9),0_0_12px_rgba(0,0,0,0.6)]"
          style={{ background: 'radial-gradient(circle at 35% 30%, #3f3f46, #18181b 60%, #09090b)' }}
        >
          <div className="absolute inset-1.5 rounded-full border border-zinc-700/60" />
          <div className="absolute inset-4 rounded-full bg-black/80" />
          <div className="absolute inset-7 rounded-full bg-zinc-900" style={{ transform: `rotate(${rotation}deg)` }}>
            <div className="absolute left-1/2 top-0 h-2 w-0.5 -translate-x-1/2 rounded-full bg-orange-500 shadow-[0_0_6px_#ff7a15]" />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-zinc-600 border border-zinc-500" />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => audioEngine.triggerEvent(channels[0], 0.9)} className="w-10 h-10 rounded-full border-2 border-green-400/70 bg-green-500/15 text-[9px] font-black cursor-pointer active:scale-95" style={{ color: GREEN, textShadow: `0 0 8px ${GREEN}88` }}>▶</button>
          <button type="button" className="w-10 h-6 rounded-full border border-orange-400/60 bg-orange-500/15 text-[8px] font-bold cursor-pointer" style={{ color: ORANGE }}>CUE</button>
        </div>
      </div>

      <div className="text-center text-[7px] font-mono tracking-[0.4em] text-neutral-600">ODJ-1500X</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DJS-1000 Skin (Controller 2)                                        */
/* ------------------------------------------------------------------ */

const PAD_COLORS = [
  '#f43f5e', '#fb7185', '#f97316', '#fbbf24',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#a855f7',
  '#d946ef', '#ec4899', '#f472b6', '#fb923c',
];

function DjsSkin({ channels }: { channels: TrackType[] }) {
  const [flash, setFlash] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wave = useWaveform(channels.length + 5, 40, 0.8);

  return (
    <div className="flex flex-col gap-2 p-2 select-none">
      {/* Display-Haube */}
      <div className="rounded-[4px] bg-[#101012] border border-black p-2 shadow-[0_4px_10px_rgba(0,0,0,0.5)]">
        <div className="rounded-[2px] bg-[#0a0a0c] p-1.5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] font-black tracking-widest text-white">DJS-1000</span>
            <span className="text-[8px] font-mono text-[#c8e626]">PROJECT 01</span>
          </div>
          <div className="h-8 flex items-end gap-[1px]">
            {wave.map((v, i) => (
              <div key={i} className="flex-1 rounded-[1px]" style={{ height: `${v * 100}%`, background: i % 5 === 0 ? 'rgba(200,230,38,0.9)' : 'rgba(46,168,240,0.85)' }} />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-px bg-[#2b2c30] mt-1 text-center">
            <div className="bg-[#0a0a0c] py-0.5"><div className="text-[7px] font-mono text-neutral-500">BPM</div><div className="text-[9px] font-black text-white">126.0</div></div>
            <div className="bg-[#0a0a0c] py-0.5"><div className="text-[7px] font-mono text-neutral-500">STEP</div><div className="text-[9px] font-black text-white">16</div></div>
            <div className="bg-[#0a0a0c] py-0.5"><div className="text-[7px] font-mono text-neutral-500">BAR</div><div className="text-[9px] font-black text-white">01</div></div>
          </div>
        </div>
      </div>

      {/* 4×4 Pad-Matrix im Silberrahmen */}
      <div className="rounded-[5px] border-2 border-[#b9bdc2] bg-[#1c1c1f] p-1.5 shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
        <div className="grid grid-cols-4 gap-1.5">
          {PAD_COLORS.map((color, i) => (
            <button
              type="button"
              key={i}
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const velocity = Math.max(0.2, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
                audioEngine.triggerEvent(channels[i % channels.length], velocity);
                setFlash(i);
                if (timerRef.current) clearTimeout(timerRef.current);
                timerRef.current = setTimeout(() => setFlash(null), 160);
              }}
              className="aspect-square rounded-[4px] border flex items-center justify-center transition-all active:scale-95 cursor-pointer touch-none"
              style={{
                borderColor: flash === i ? '#fff' : '#0f0f10',
                background: flash === i ? `${color}cc` : `${color}22`,
                boxShadow: flash === i ? `0 0 12px -2px ${color}` : 'none',
              }}
            >
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
            </button>
          ))}
        </div>
      </div>

      {/* Chrom-Transport + Taster */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => audioEngine.triggerEvent(channels[0], 0.9)}
          className="flex-1 h-9 rounded-full text-[9px] font-black text-black cursor-pointer active:scale-95"
          style={{ background: 'linear-gradient(180deg,#f2f4f6,#8b8f95 55%,#d8dade)' }}
        >PLAY</button>
        <button type="button" className="flex-1 h-9 rounded-full text-[9px] font-black text-black cursor-pointer active:scale-95"
          style={{ background: 'linear-gradient(180deg,#f2f4f6,#8b8f95 55%,#d8dade)' }}
        >STOP</button>
      </div>
      <div className="flex gap-1.5">
        <button type="button" className="flex-1 h-7 rounded-[3px] border border-[#c8e626]/60 bg-[#c8e626]/10 text-[9px] font-bold text-[#c8e626] cursor-pointer">PROJECT</button>
        <button type="button" className="flex-1 h-7 rounded-[3px] border border-blue-400/60 bg-blue-500/10 text-[9px] font-bold text-blue-300 cursor-pointer">FX</button>
        <button type="button" className="flex-1 h-7 rounded-[3px] border border-red-500/60 bg-red-500/10 text-[9px] font-bold text-red-300 cursor-pointer">REC</button>
      </div>
      <div className="text-center text-[7px] font-mono tracking-[0.4em] text-neutral-600">DJS-1000</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LIBRARY Skin (Controller 3)                                         */
/* ------------------------------------------------------------------ */

function LibrarySkin({ channels, loadedLabel, onLoad }: { channels: TrackType[]; loadedLabel?: string; onLoad: (label: string) => void }) {
  const [query, setQuery] = useState('');
  const tracks = useMemo(
    () => SORTED_MUSIC_LIBRARY.filter((t) => !query || `${t.name} ${t.artist}`.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  return (
    <div className="flex flex-col gap-2 p-2 max-h-72">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Track suchen…"
        className="w-full bg-black/70 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-300 focus:outline-none focus:border-orange-500/60"
      />
      <div className="flex-1 overflow-y-auto flex flex-col gap-1">
        {tracks.slice(0, 24).map((t) => (
          <div key={t.id} className="flex items-center gap-2 rounded bg-black/40 border border-zinc-800 px-2 py-1.5">
            <span className="text-[11px] font-mono text-zinc-300 truncate flex-1">{t.name}</span>
            <span className="text-[10px] font-mono text-zinc-600 uppercase hidden sm:inline">{t.artist}</span>
            <button type="button" onClick={() => audioEngine.previewSample('channel5', undefined, t.url)} className="text-[11px] font-bold text-zinc-400 hover:text-orange-300 cursor-pointer">▶</button>
            <button type="button" onClick={() => { audioEngine.loadTrackSample(channels[0], t.url); onLoad(t.name); }} className="text-[11px] font-bold text-orange-400 hover:text-orange-200 cursor-pointer">LOAD</button>
          </div>
        ))}
      </div>
      <div className="text-[10px] font-mono text-zinc-600 truncate">{loadedLabel ? `GELADEN: ${loadedLabel}` : 'KEIN TRACK GELADEN'}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DeckPanel                                                           */
/* ------------------------------------------------------------------ */

export const DeckPanel: React.FC<DeckPanelProps> = ({ deck, channels, skin, onSkinChange, loadedLabel, onLoad }) => {
  return (
    <div className="bg-[#17171a] rounded-md border border-zinc-800 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-2 pt-1.5 pb-1 border-b border-zinc-800">
        <span className={`text-[11px] font-black tracking-[0.3em] ${deck === 'A' ? 'text-orange-400' : 'text-cyan-300'}`}>DECK {deck}</span>
        <div className="flex gap-1">
          {SKIN_OPTIONS.map((opt) => (
            <button
              type="button"
              key={opt.id}
              onClick={() => onSkinChange(deck, opt.id)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] border text-[9px] font-bold tracking-widest cursor-pointer transition-colors ${
                skin === opt.id
                  ? 'border-orange-500/70 bg-orange-500/10 text-orange-400'
                  : 'border-zinc-800 bg-black/40 text-zinc-500 hover:border-orange-500/40 hover:text-orange-300'
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1">
        {skin === 'TURNTABLE' && <CdjSkin channels={channels} loadedLabel={loadedLabel} />}
        {skin === 'PAD' && <DjsSkin channels={channels} />}
        {skin === 'LIBRARY' && <LibrarySkin channels={channels} loadedLabel={loadedLabel} onLoad={(label) => onLoad?.(label)} />}
      </div>
    </div>
  );
};

/** Lädt die persistierten Deck-Skins (Default: A = TURNTABLE/CDJ, B = PAD/DJS). */
export function loadDeckSkins(): Record<'A' | 'B', MixerSkinId> {
  try {
    const raw = globalThis.localStorage?.getItem(DECK_SKIN_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<'A' | 'B', MixerSkinId>>;
      if (parsed && (parsed.A === 'TURNTABLE' || parsed.A === 'PAD' || parsed.A === 'LIBRARY') && (parsed.B === 'TURNTABLE' || parsed.B === 'PAD' || parsed.B === 'LIBRARY')) {
        return { A: parsed.A, B: parsed.B };
      }
    }
  } catch { /* ignore */ }
  return { A: 'TURNTABLE', B: 'PAD' };
}

export function saveDeckSkins(skins: Record<'A' | 'B', MixerSkinId>): void {
  try {
    globalThis.localStorage?.setItem(DECK_SKIN_STORAGE_KEY, JSON.stringify(skins));
  } catch { /* ignore */ }
}
