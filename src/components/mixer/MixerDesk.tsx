/**
 * mixerMONK · Pult nach den Vorlagen des Betreibers
 * =================================================
 * Vorlagen: public/uidesign/uimixerMONKdigital.png (Aufbau des Pults),
 * uimixerMONKechtbild.PNG (CDJ · DJM · DJS nebeneinander) und
 * uimixercontroller1–3 (die drei Controller-Skins).
 *
 *   [Controller links] [Sprungleiste · Master · 4 Kanalzüge · Bank/Makros] [Controller rechts]
 *   Crossfader mit Bank-Pegeln I/II darunter.
 *
 * - 8 Kanäle in 2 Bänken (A = 1–4, B = 5–8) – Quellen aus dem Audio-Vertrag
 *   (src/plugins/pluginContract.ts): Drops · Song · Drums · Synth · Instru ·
 *   Vox · Sound · Stems. Jeder Kanal hat ▶ und SYNC.
 * - Controller links/rechts ein-/ausblendbar (0–2), Skins CDJ · Pads · Bibliothek.
 * - Nicht übernommen (Betreiber 2026-10-07: selten benutzt): Effekt-Tabelle,
 *   Szenen, Booth/Kopfhörer/Mic-Regler.
 * - Nur der Halter bedient das Pult. Der ganze Stand liegt in der Session
 *   (`writePluginSettings('mixer', …)`); wer übernimmt, startet damit – auch in
 *   der Audio-Engine. Wo die Engine eine Schnittstelle hat, wirkt der Regler
 *   sofort (Kanal-Gain/EQ/Pan/PFL, Master, Tempo, Transport, Pads, Steps).
 * - ▶/■ der Plugin-Streifen (Session, `pluginTransport.ts`) setzt dieses Gerät
 *   um: ■ = Kanal stumm, ▶ = Kanal offen und einmal anspielen.
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { webRTCManager } from '../../utils/WebRTCManager';
import { audioEngine } from '../../utils/audioEngine';
import { analyzeMusic } from '../../utils/audioAnalyzer';
import { ALL_TRACKS, type TrackType } from '../../types';
import { SORTED_MUSIC_LIBRARY, type MusicTrack } from '../../data/musicLibrary';
import { type AutoloadSong, clearAutoloadSong, loadAutoloadSong, saveAutoloadSong } from '../../core/session/autoloadSong';
import { channelMapFromContract } from '../../plugins/pluginContract';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { usePluginManager } from '../../context/PluginManagerContext';
import { useModuleState } from '../../context/ModuleStateContext';
import { pluginModeOf, pluginOwnerOf } from '../../core/session/pluginMode';
import { isPluginSynced, pluginSyncVersion, setPluginSync, subscribePluginSync } from '../../core/session/pluginSync';
import { readPluginTransport } from '../../core/session/pluginTransport';
import { personColor, personLabel, useSessionPeople } from '../../core/session/sessionPeople';
import { useMainLevel } from '../../core/audio/mainLevel';
import { AM_MODULE, AmFader, AmHFader, AmKnob, AmMeter, AmSeg, AmToggle, amColor } from '../am/amUi';
import { CHANNEL_NAMES, DeckController, freshSide, type DeckSide, type DeckSkin, type PadPage } from './DeckControllers';

/* ------------------------------------------------------------------ */
/* Stand                                                               */
/* ------------------------------------------------------------------ */

type Xf = 'A' | 'T' | 'B';
interface DeskChannel {
  trim: number; hi: number; mid: number; low: number; filter: number; send: number; pan: number;
  fader: number; mute: boolean; solo: boolean; cue: boolean; xf: Xf;
}
interface DeskState {
  channels: DeskChannel[];
  xfd: number; curve: 'smooth' | 'cut'; master: number;
  bank: 'A' | 'B'; fxLock: boolean; keyLock: boolean;
  key: string; macros: { flt: number; fx: number; build: number };
  left: DeckSide; right: DeckSide;
}

const CH_MAP = channelMapFromContract();
const CH_SRC: string[] = Array.from({ length: 8 }, (_, i) => CH_MAP[i + 1] ?? '');
const TRACKS: TrackType[] = ALL_TRACKS.slice(0, 8);
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'H'];
const KEYS = NOTES.flatMap((n) => [`${n}-Dur`, `${n}-Moll`]);
const SKINS: DeckSkin[] = ['cdj', 'pads', 'lib'];
const PAGES: PadPage[] = ['drop', 'drum', 'chord', 'voc'];

const freshChannel = (): DeskChannel => ({
  trim: 0, hi: 0, mid: 0, low: 0, filter: 0, send: 0, pan: 0, fader: 0.75, mute: false, solo: false, cue: false, xf: 'T',
});
const freshState = (): DeskState => ({
  channels: Array.from({ length: 8 }, freshChannel),
  xfd: 0.5, curve: 'smooth', master: 0.8, bank: 'A', fxLock: false, keyLock: false, key: 'A-Moll',
  macros: { flt: 0, fx: 0, build: 0 },
  left: freshSide('cdj', 0), right: freshSide('pads', 2),
});

function restoreSide(base: DeckSide, saved: unknown): DeckSide {
  const s = mergeKnown(base, saved);
  const fix = (arr: unknown[], len: number, ok: (v: unknown) => boolean, def: unknown) =>
    Array.from({ length: len }, (_, i) => (ok(arr[i]) ? arr[i] : def));
  return {
    ...s,
    skin: SKINS.includes(s.skin) ? s.skin : base.skin,
    page: PAGES.includes(s.page) ? s.page : base.page,
    ch: Math.max(0, Math.min(7, Math.round(s.ch))),
    pitch: Math.max(-1, Math.min(1, s.pitch)),
    cues: fix(s.cues, 8, (v) => typeof v === 'number' && Number.isFinite(v), -1) as number[],
    steps: fix(s.steps, 16, (v) => typeof v === 'boolean', false) as boolean[],
    knobs: fix(s.knobs, 6, (v) => typeof v === 'number' && Number.isFinite(v), 0.5) as number[],
  };
}

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
  const flat = mergeKnown({ xfd: base.xfd, master: base.master, fxLock: base.fxLock, keyLock: base.keyLock, key: base.key }, desk);
  return {
    ...base,
    ...flat,
    key: KEYS.includes(flat.key) ? flat.key : base.key,
    curve: desk.curve === 'cut' ? 'cut' : 'smooth',
    bank: desk.bank === 'B' ? 'B' : 'A',
    macros: mergeKnown(base.macros, desk.macros),
    left: restoreSide(base.left, desk.left),
    right: restoreSide(base.right, desk.right),
    channels,
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
function effectiveGain(s: DeskState, i: number, stopped: boolean[]): number {
  const c = s.channels[i];
  const soloOn = s.channels.some((x) => x.solo);
  if (c.mute || stopped[i] || (soloOn && !c.solo)) return 0;
  return Math.min(1.5, c.fader * db2g(c.trim) * xfGain(c.xf, s.xfd, s.curve));
}
function pushChannel(s: DeskState, i: number, stopped: boolean[]): void {
  const c = s.channels[i];
  const t = TRACKS[i];
  audioEngine.setChannelGain(t, effectiveGain(s, i, stopped));
  audioEngine.setChannelEQ(t, 'high', c.hi);
  audioEngine.setChannelEQ(t, 'mid', c.mid);
  audioEngine.setChannelEQ(t, 'low', c.low);
  audioEngine.setChannelPan(t, c.pan);
}
function pushAll(s: DeskState, stopped: boolean[]): void {
  for (let i = 0; i < 8; i += 1) pushChannel(s, i, stopped);
}

const goTo = (id: string) => document.getElementById(`rack-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

/* ------------------------------------------------------------------ */
/* Kanalzug                                                            */
/* ------------------------------------------------------------------ */

function ChannelStrip({ i, c, level, src, owner, mode, synced, canSync, stopped, onPatch, onCue, onPlay, onSync, disabled }: {
  i: number; c: DeskChannel; level: number; src: string; owner: string; mode: string; synced: boolean; canSync: boolean; stopped: boolean;
  onPatch: (p: Partial<DeskChannel>) => void; onCue: () => void; onPlay: () => void; onSync: () => void; disabled: boolean;
}) {
  const m = AM_MODULE[src];
  const n = i + 1;
  return (
    <div className="am-cs" style={{ ['--c' as string]: amColor(src) }} data-channel={n}>
      <div className="am-chd">{n}</div>
      <div className="am-cnm">{CHANNEL_NAMES[i]}</div>
      <span className="am-own">{m?.name ?? src}<br /><b>{owner}</b> · {mode}{stopped ? ' · ■' : ''}</span>
      <div className="am-k2">
        <AmKnob size="s" gold value={c.hi} min={-26} max={6} def={0} unit="db" label="Hi" title={`Höhen Kanal ${n}`} onChange={(v) => onPatch({ hi: v })} disabled={disabled} />
        <AmKnob size="s" value={c.trim} min={-12} max={12} def={0} unit="db" label="Trim" title={`Trim Kanal ${n}`} onChange={(v) => onPatch({ trim: v })} disabled={disabled} />
        <AmKnob size="s" gold value={c.mid} min={-26} max={6} def={0} unit="db" label="Mid" title={`Mitten Kanal ${n}`} onChange={(v) => onPatch({ mid: v })} disabled={disabled} />
        <AmKnob size="s" value={c.filter} min={-1} max={1} def={0} unit="flt" label="Filter" title={`Filter Kanal ${n}: links Tiefpass, rechts Hochpass`} onChange={(v) => onPatch({ filter: v })} disabled={disabled} />
        <AmKnob size="s" gold value={c.low} min={-26} max={6} def={0} unit="db" label="Low" title={`Bässe Kanal ${n}`} onChange={(v) => onPatch({ low: v })} disabled={disabled} />
        <AmKnob size="s" value={c.send} min={0} max={1} def={0} unit="pct" label="Send" title={`Effekt-Send Kanal ${n}`} onChange={(v) => onPatch({ send: v })} disabled={disabled} />
        <AmKnob size="s" value={c.pan} min={-1} max={1} def={0} unit="bi" label="Pan" title={`Panorama Kanal ${n}`} onChange={(v) => onPatch({ pan: v })} disabled={disabled} />
        <div className="am-r3" style={{ alignSelf: 'center' }}>
          <AmToggle kind="m" on={c.mute} onClick={() => onPatch({ mute: !c.mute })} title="Stumm" ariaLabel={`Mute Kanal ${n}`} disabled={disabled}>M</AmToggle>
          <AmToggle kind="s" on={c.solo} onClick={() => onPatch({ solo: !c.solo })} title="Solo" ariaLabel={`Solo Kanal ${n}`} disabled={disabled}>S</AmToggle>
        </div>
      </div>
      <button type="button" className={`am-cuebtn ${c.cue ? 'am-on' : ''}`} aria-pressed={c.cue} aria-label={`CUE Kanal ${n}${c.cue ? ' aktiv' : ''}`} title="Vorhören (Kopfhörer)" disabled={disabled} onClick={onCue}>CUE</button>
      <div className="am-fz">
        <AmMeter level={level} />
        <AmFader value={c.fader} def={0.75} label={`Kanalfader ${n}`} onChange={(v) => onPatch({ fader: v })} disabled={disabled} />
      </div>
      <div className="am-xf" role="group" aria-label={`Crossfader-Zuweisung Kanal ${n}`}>
        {([['A', 'A'], ['T', 'THRU'], ['B', 'B']] as [Xf, string][]).map(([v, l]) => (
          <button key={v} type="button" className={c.xf === v ? 'am-on' : ''} aria-pressed={c.xf === v} disabled={disabled} onClick={() => onPatch({ xf: v })}>{l}</button>
        ))}
      </div>
      <div className="am-pp">
        <button type="button" className={`am-syncb ${synced ? 'am-on' : ''}`} aria-pressed={synced} aria-label={`SYNC Kanal ${n}`}
          title={canSync ? 'SYNC gegen Main: Start auf dem nächsten Takt' : 'SYNC stellt der Halter der Quelle'} disabled={!canSync} onClick={onSync}>
          ⟲ SYNC
        </button>
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
  const main = useMainLevel();
  const tapTimes = useRef<number[]>([]);
  // ▶/■ der Plugin-Streifen (Session) – dieses Gerät setzt sie um, wenn es den Main-Ton hat.
  const [stopped, setStopped] = useState<boolean[]>(() => CH_SRC.map((src) => !readPluginTransport(src).playing));
  const stoppedRef = useRef(stopped);
  const lastPlayAt = useRef<number[]>(CH_SRC.map((src) => readPluginTransport(src).at));

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
    if (push === 'all') pushAll(next, stoppedRef.current);
    else if (typeof push === 'number') pushChannel(next, push, stoppedRef.current);
  };
  const patchChannel = (i: number, p: Partial<DeskChannel>) => {
    update((prev) => ({ ...prev, channels: prev.channels.map((c, k) => (k === i ? { ...c, ...p } : c)) }), p.solo !== undefined ? 'all' : i);
  };
  const patchSide = (side: 'left' | 'right', p: Partial<DeckSide>) => update((prev) => ({ ...prev, [side]: { ...prev[side], ...p } }));

  useEffect(() => {
    writePluginSettings('mixer', { desk: s });
  }, [s]);

  // Halterwechsel, Transport, Tempo und ▶/■ der Plugins im UI-Takt nachziehen.
  const holderRef = useRef(false);
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = webRTCManager.isMainOutOwner;
      if (now && !holderRef.current) {
        const restored = restoreState(readPluginSettings('mixer'));
        sRef.current = restored;
        setS(restored);
        pushAll(restored, stoppedRef.current);
        audioEngine.setMasterVolume(restored.master);
      }
      holderRef.current = now;
      setIsHolder(now);
      setPlaying(audioEngine.getIsPlaying());
      setBpmState(audioEngine.getBpm());
      const tr = CH_SRC.map((src) => readPluginTransport(src));
      const nextStopped = tr.map((x) => !x.playing);
      if (nextStopped.some((v, i) => v !== stoppedRef.current[i])) {
        stoppedRef.current = nextStopped;
        setStopped(nextStopped);
        if (now) pushAll(sRef.current, nextStopped);
      }
      tr.forEach((x, i) => {
        if (x.playing && x.at > lastPlayAt.current[i]) {
          lastPlayAt.current[i] = x.at;
          if (now) audioEngine.triggerEvent(TRACKS[i], 0.9);
        }
      });
    }, 300);
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
  // Kanalpegel: Main-Pegel × Kanal-Anteil (bis die v2-Kette eigene Kanalpegel liefert).
  const levels = s.channels.map((_, i) => (playing ? Math.min(1, main.level * (effectiveGain(s, i, stopped) / 1)) : 0));

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
      {/* Kopfleiste: Tempo, Tonart, Transport, Autoload, Controller ein/aus */}
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
        <AmToggle on={s.keyLock} disabled={disabled} onClick={() => update((p) => ({ ...p, keyLock: !p.keyLock }))} title="Tonart sperren">KEY LOCK</AmToggle>
        <span className="am-hint">mixerMONK · 8 CH · 2 Bänke</span>
        <div className="am-ctltoggles" role="group" aria-label="Controller ein-/ausblenden">
          <AmToggle on={s.left.on} onClick={() => patchSide('left', { on: !s.left.on })} ariaLabel="Controller links" title="Controller links ein/aus">◧ L</AmToggle>
          <AmToggle on={s.right.on} onClick={() => patchSide('right', { on: !s.right.on })} ariaLabel="Controller rechts" title="Controller rechts ein/aus">R ◨</AmToggle>
        </div>
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

      <div className="am-desk am-desk3">
        {s.left.on && <DeckController side="L" s={s.left} set={(p) => patchSide('left', p)} sources={CH_SRC} tracks={TRACKS} titles={titles} info={analysis} onLoad={loadTitle} bpm={bpm} setBpm={setBpm} playing={playing} disabled={disabled} />}

        <div className="am-center">
          {/* Sprungleiste + Locks */}
          <div className="am-unit am-rail">
            {([['EQ', 'eq'], ['DYN', 'dsp'], ['FX', 'effect'], ['PAN', 'spatial'], ['REC', 'record']] as const).map(([n, id]) => (
              <button key={id} type="button" className="am-rb" onClick={() => goTo(id)} title={`Zu ${id}MONK`}>{n}</button>
            ))}
            <button type="button" className={`am-ring ${s.fxLock ? '' : 'am-off'}`} style={{ ['--rc' as string]: '#ff9f43' }} aria-pressed={s.fxLock} disabled={disabled}
              title="FX LOCK: Makros ändern die Effekte nicht" onClick={() => update((p) => ({ ...p, fxLock: !p.fxLock }))}>FX<br />LOCK</button>
            <span className="am-ring" style={{ ['--rc' as string]: personColor(webRTCManager.mainOutOwnerId, people), display: 'grid', placeItems: 'center' }}
              title={`MIX LOCK: ${personLabel(webRTCManager.mainOutOwnerId, people)} hält den Mixer`}>MIX<br />LOCK</span>
          </div>

          {/* Master */}
          <div className="am-unit am-mcol">
            <span className="am-lbl">Master</span>
            <div className="am-mf">
              <AmFader big value={s.master} def={0.8} label="Main-Out LEVEL" onChange={applyMaster} disabled={disabled} />
              <AmMeter level={main.level} peak={main.peak} />
              <AmMeter level={main.level} peak={main.peak} />
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
              const canSync = !!owner && owner === webRTCManager.userId;
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
                  canSync={canSync}
                  stopped={stopped[i]}
                  disabled={disabled}
                  onPatch={(p) => patchChannel(i, p)}
                  onCue={() => {
                    const next = !s.channels[i].cue;
                    patchChannel(i, { cue: next });
                    audioEngine.setChannelPfl(TRACKS[i], next);
                  }}
                  onPlay={() => audioEngine.triggerEvent(TRACKS[i], 0.9)}
                  onSync={() => setPluginSync(src, !isPluginSynced(src))}
                />
              );
            })}
          </div>

          {/* Bank + Makros */}
          <div className="am-unit am-bankcol">
            <span className="am-lbl">Bank</span>
            <div className="am-banksw" role="group" aria-label="Bank wählen">
              {(['A', 'B'] as const).map((b) => (
                <button key={b} type="button" className={s.bank === b ? 'am-on' : ''} aria-pressed={s.bank === b}
                  style={{ ['--bk' as string]: b === 'A' ? 'var(--cue)' : 'var(--warn)' }}
                  onClick={() => update((p) => ({ ...p, bank: b }))}>{b}<small>{b === 'A' ? '1–4' : '5–8'}</small></button>
              ))}
            </div>
            <div className="am-rowbtns am-chjump" aria-label="Kanäle 1–8">
              {CH_SRC.map((src, k) => (
                <button key={k} type="button" style={{ ['--pc' as string]: amColor(src) }} className={idx.includes(k) ? 'am-on' : ''}
                  title={`Kanal ${k + 1} (${CHANNEL_NAMES[k]}) – Plugin öffnen`} onClick={() => goTo(src)}>{k + 1}</button>
              ))}
            </div>
            <span className="am-lbl" style={{ marginTop: 4 }}>Makros</span>
            <div className="am-macros">
              <AmKnob size="l" gold value={s.macros.flt} min={-1} max={1} def={0} unit="flt" label="Macro 1" title="Macro 1: Filter über die Summe" disabled={disabled} onChange={(v) => update((p) => ({ ...p, macros: { ...p.macros, flt: v } }))} />
              <AmKnob size="l" gold value={s.macros.fx} def={0} unit="pct" label="Macro 2" title="Macro 2: alle Effekt-Returns lauter" disabled={disabled} onChange={(v) => update((p) => ({ ...p, macros: { ...p.macros, fx: v } }))} />
              <AmKnob size="l" value={s.macros.build} def={0} unit="pct" label="Macro 3" title="Macro 3: Build-up (Hochpass + Hall)" disabled={disabled} onChange={(v) => update((p) => ({ ...p, macros: { ...p.macros, build: v } }))} />
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
          </div>
        </div>

        {s.right.on && <DeckController side="R" s={s.right} set={(p) => patchSide('right', p)} sources={CH_SRC} tracks={TRACKS} titles={titles} info={analysis} onLoad={loadTitle} bpm={bpm} setBpm={setBpm} playing={playing} disabled={disabled} />}
      </div>
    </div>
  );
});
