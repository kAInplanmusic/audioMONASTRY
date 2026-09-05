import React, { useMemo, useRef, useState } from 'react';
import { Disc3, Library, LayoutGrid } from 'lucide-react';
import { audioEngine } from '../../utils/audioEngine';
import { SORTED_MUSIC_LIBRARY } from '../../data/musicLibrary';
import type { TrackType } from '../../types';

/**
 * mixerMONK Deck-Skins (Deck A/B im festen DJ-Mixer)
 * ====================================================
 * Jedes Deck kann unabhängig einen von drei Skins anzeigen:
 *   TURNTABLE · PAD · LIBRARY
 * Die Auswahl wird pro Deck in localStorage persistiert.
 */

export type MixerSkinId = 'TURNTABLE' | 'PAD' | 'LIBRARY';

export const DECK_SKIN_STORAGE_KEY = 'audiomonastry_deck_skins';

const SKIN_OPTIONS: { id: MixerSkinId; label: string; icon: React.ReactNode }[] = [
  { id: 'TURNTABLE', label: 'TURNTABLE', icon: <Disc3 className="w-3 h-3" /> },
  { id: 'PAD', label: 'PADS', icon: <LayoutGrid className="w-3 h-3" /> },
  { id: 'LIBRARY', label: 'LIBRARY', icon: <Library className="w-3 h-3" /> },
];

interface DeckPanelProps {
  deck: 'A' | 'B';
  channels: TrackType[];
  skin: MixerSkinId;
  onSkinChange: (deck: 'A' | 'B', skin: MixerSkinId) => void;
  loadedLabel?: string;
  onLoad?: (label: string) => void;
}

const PAD_COLORS = [
  '#f43f5e', '#fb7185', '#f97316', '#fbbf24',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#a855f7',
  '#d946ef', '#ec4899', '#f472b6', '#fb923c',
];

function TurntableSkin({ channels, loadedLabel }: { channels: TrackType[]; loadedLabel?: string }) {
  const [rotation, setRotation] = useState(0);
  const [pitch, setPitch] = useState(0);
  const lastYRef = useRef<number | null>(null);

  const handleJog = (e: React.PointerEvent<HTMLDivElement>) => {
    const move = (ev: PointerEvent) => {
      if (lastYRef.current !== null) {
        setRotation((r) => r + (ev.clientY - lastYRef.current) * 2);
      }
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
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="flex items-center gap-4">
        <div
          onPointerDown={handleJog}
          className="w-28 h-28 short-landscape:w-20 short-landscape:h-20 rounded-full cursor-ns-resize select-none touch-none relative border-4 border-zinc-800 shadow-[inset_0_0_25px_rgba(0,0,0,0.9),0_0_15px_rgba(0,0,0,0.6)]"
          style={{ background: 'radial-gradient(circle at 35% 30%, #3f3f46, #18181b 60%, #09090b)' }}
        >
          <div className="absolute inset-2 rounded-full border border-zinc-700/60" />
          <div className="absolute inset-6 rounded-full bg-black/80" />
          <div
            className="absolute inset-8 rounded-full bg-zinc-900"
            style={{ transform: `rotate(${rotation}deg)` }}
          >
            <div className="absolute left-1/2 top-0 h-2 w-0.5 -translate-x-1/2 rounded-full bg-orange-500 shadow-[0_0_6px_#f97316]" />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-zinc-600 border border-zinc-500" />
          </div>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-mono text-zinc-500">PITCH</span>
          <input
            type="range"
            min={-100}
            max={100}
            value={pitch}
            onChange={(e) => setPitch(Number(e.target.value))}
            className="h-1 w-20 accent-orange-500"
          />
          <span className="text-[11px] font-mono text-orange-400">{pitch > 0 ? '+' : ''}{pitch / 10}%</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => audioEngine.triggerEvent(channels[0], 0.9)}
          className="px-3 py-1.5 rounded border border-orange-500/50 bg-orange-500/10 text-orange-300 text-[11px] font-bold tracking-widest hover:bg-orange-500/20 cursor-pointer"
        >
          ▶ PLAY
        </button>
        <span className="text-[11px] font-mono text-zinc-400 max-w-[160px] truncate">{loadedLabel ?? 'DECK OHNE TRACK'}</span>
      </div>
    </div>
  );
}

function PadSkin({ channels }: { channels: TrackType[] }) {
  const [flash, setFlash] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <div className="grid grid-cols-4 gap-1.5 p-2">
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
            borderColor: flash === i ? '#fff' : '#26262b',
            background: flash === i ? `${color}cc` : `${color}22`,
            boxShadow: flash === i ? `0 0 12px -2px ${color}` : 'none',
          }}
        >
          <span className="w-2 h-2 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
        </button>
      ))}
    </div>
  );
}

function LibrarySkin({ channels, loadedLabel, onLoad }: { channels: TrackType[]; loadedLabel?: string; onLoad: (label: string) => void }) {
  const [query, setQuery] = useState('');
  const tracks = useMemo(
    () => SORTED_MUSIC_LIBRARY.filter((t) => !query || `${t.name} ${t.artist}`.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  return (
    <div className="flex flex-col gap-2 p-2 max-h-56">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Track suchen…"
        className="w-full bg-black/70 border border-zinc-800 rounded px-2 py-1 text-[12px] text-zinc-300 focus:outline-none focus:border-orange-500/60"
      />
      <div className="flex-1 overflow-y-auto flex flex-col gap-1">
        {tracks.slice(0, 20).map((t) => (
          <div key={t.id} className="flex items-center gap-2 rounded bg-black/40 border border-zinc-800 px-2 py-1">
            <span className="text-[11px] font-mono text-zinc-300 truncate flex-1">{t.name}</span>
            <span className="text-[10px] font-mono text-zinc-600 uppercase">{t.artist}</span>
            <button
              type="button"
              onClick={() => audioEngine.previewSample('channel5', undefined, t.url)}
              className="text-[10px] font-bold text-zinc-400 hover:text-orange-300 cursor-pointer"
            >
              ▶
            </button>
            <button
              type="button"
              onClick={() => {
                audioEngine.loadTrackSample(channels[0], t.url);
                onLoad(t.name);
              }}
              className="text-[10px] font-bold text-orange-400 hover:text-orange-200 cursor-pointer"
            >
              LOAD
            </button>
          </div>
        ))}
      </div>
      <div className="text-[10px] font-mono text-zinc-600 truncate">{loadedLabel ? `GELADEN: ${loadedLabel}` : 'KEIN TRACK GELADEN'}</div>
    </div>
  );
}

export const DeckPanel: React.FC<DeckPanelProps> = ({ deck, channels, skin, onSkinChange, loadedLabel, onLoad }) => {
  return (
    <div className="bg-[#17171a] rounded-md border border-zinc-800 flex flex-col">
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
        {skin === 'TURNTABLE' && <TurntableSkin channels={channels} loadedLabel={loadedLabel} />}
        {skin === 'PAD' && <PadSkin channels={channels} />}
        {skin === 'LIBRARY' && <LibrarySkin channels={channels} loadedLabel={loadedLabel} onLoad={(label) => onLoad?.(label)} />}
      </div>
    </div>
  );
};

/** Lädt die persistierten Deck-Skins (Default: A = TURNTABLE, B = LIBRARY). */
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
  return { A: 'TURNTABLE', B: 'LIBRARY' };
}

export function saveDeckSkins(skins: Record<'A' | 'B', MixerSkinId>): void {
  try {
    globalThis.localStorage?.setItem(DECK_SKIN_STORAGE_KEY, JSON.stringify(skins));
  } catch { /* ignore */ }
}
