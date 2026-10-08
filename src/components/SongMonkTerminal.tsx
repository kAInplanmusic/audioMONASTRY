import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePluginState } from '../hooks/usePluginState';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { useSamples } from '../context/SampleContext';
import { webRTCManager } from '../utils/WebRTCManager';
import type { AudioSample } from '../data/samples';
import { AmCard, AmKnob } from './am/amUi';

const STYLE_PRESETS = ['dark techno', 'minimal techno', 'melodic techno', 'tech house', 'ambient', 'breaks', 'acid'];
const DURATIONS = [4, 6, 8, 12, 16, 20, 30];

/**
 * songMONK – AI-Song-Generator (Suno-artig) · Rack-Modul
 * =====================================================
 * Vorlage public/uidesign/uiübersichtapp, Zeile 03: links Stil, Mitte Prompt +
 * Spur mit Playhead, rechts Playlist (erzeugte Songs aus biblioMONK).
 * Server-Endpoint `POST /api/song/generate` (Runtime-first, HF-Fallback).
 */
export const SongMonkTerminal = React.memo(function SongMonkTerminal() {
  const { lockStatus } = usePluginState('song', 'PRO');
  const { samples, addSample } = useSamples();

  // Beständige Plugins: Einstiegsstand = letzter Prompt/Stil/Tempo/Länge.
  const [saved] = useState(() => mergeKnown({ prompt: 'Dark warehouse techno mit treibendem Bass und hypnotischen Vocals', style: 'dark techno', bpm: 128, duration: 8 }, readPluginSettings('song')));
  const [prompt, setPrompt] = useState(saved.prompt);
  const [style, setStyle] = useState(saved.style);
  const [bpm, setBpm] = useState(saved.bpm);
  const [duration, setDuration] = useState(saved.duration);
  useEffect(() => {
    writePluginSettings('song', { prompt, style, bpm, duration });
  }, [prompt, style, bpm, duration]);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  // Vorschau einer erzeugten Datei (Playhead in der Spur).
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const pushLog = useCallback((line: string) => {
    setLog(prev => [...prev.slice(-9), line]);
  }, []);

  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingId(null);
    setProgress(0);
  }, []);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const playUrl = useCallback((id: string, url: string) => {
    audioRef.current?.pause();
    try {
      const audio = new Audio(url);
      audio.volume = 0.9;
      audio.addEventListener('timeupdate', () => {
        if (audio.duration > 0) setProgress(audio.currentTime / audio.duration);
      });
      audio.addEventListener('ended', () => {
        if (audioRef.current === audio) { audioRef.current = null; setPlayingId(null); setProgress(0); }
      });
      audioRef.current = audio;
      setPlayingId(id);
      setProgress(0);
      void audio.play().catch(() => { /* Autoplay-Block ignorieren */ });
    } catch { /* Audio nur im Browser verfügbar */ }
  }, []);

  const generate = useCallback(async () => {
    if (!prompt.trim()) {
      pushLog('✗ Bitte zuerst einen Song-Prompt eingeben.');
      return;
    }
    setBusy(true);
    try {
      const resp = await fetch('/api/song/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          style,
          bpm: Number(bpm) || 128,
          durationSeconds: Math.min(30, Math.max(1, Number(duration) || 8)),
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`Song-API HTTP ${resp.status}: ${detail.slice(0, 160)}`);
      }
      const blob = await resp.blob();
      const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(blob)
        : undefined;
      if (!url) throw new Error('Blob-URL nicht verfügbar');

      const sample: AudioSample = {
        id: `song-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: `songMONK ${style || 'Track'} ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`,
        category: 'mids',
        type: 'Song',
        url,
        description: `AI-Song: ${prompt.trim()}`,
        tags: ['songmonk', 'ai', style.trim().slice(0, 20)],
        parameters: { frequency: 0 },
      };
      addSample(sample);
      playUrl(sample.id, url);
      pushLog(`✓ Song erzeugt (${duration}s @ ${bpm} BPM) → biblioMONK (${sample.name})`);
    } catch (err) {
      pushLog(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [addSample, bpm, duration, playUrl, prompt, pushLog, style]);

  const playlist = useMemo(
    () => samples.filter((s) => s.tags?.includes('songmonk') && s.url).slice(-8).reverse(),
    [samples],
  );
  const playing = playlist.find((s) => s.id === playingId);
  // Spur: Takte der eingestellten Länge (4/4), in 4-Takt-Phrasen gefärbt.
  const bars = Math.max(1, Math.round((Number(duration) * Number(bpm)) / 240));
  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  const lastLog = log.slice(-2);

  return (
    <div className="am-rackrow am-a-song" style={locked ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <AmCard title="Stil" style={{ width: 190 }}>
        <input className="am-libq" aria-label="Style" value={style} onChange={(e) => setStyle(e.target.value)} />
        <div className="am-list am-a-scroll" role="listbox" aria-label="Stil-Vorlagen">
          {STYLE_PRESETS.map((s) => (
            <button key={s} type="button" role="option" aria-selected={style === s} className={style === s ? 'am-on' : ''} onClick={() => setStyle(s)}>{s}</button>
          ))}
        </div>
      </AmCard>

      <AmCard title="Song" style={{ flex: 1, minWidth: 480 }} right={<span className="am-vb">{bars} Takte · {bpm} BPM</span>}>
        <div className="am-a-inline am-a-top">
          <textarea
            className="am-libq am-a-ta"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            aria-label="Song-Prompt"
            placeholder="Beschreibe Stil, Energie, Instrumente, Vocals …"
          />
          <AmKnob size="s" value={bpm} min={40} max={220} def={128} unit="int" label="BPM" title="Tempo" onChange={(v) => setBpm(Math.round(v))} />
          <label className="am-a-field">
            <span className="am-lbl">Dauer</span>
            <select className="am-sel" aria-label="Dauer (s)" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map(sec => <option key={sec} value={sec}>{sec} s</option>)}
            </select>
          </label>
          <button type="button" className="am-btn am-pri" onClick={generate} disabled={busy}>
            {busy ? 'Generiere Song …' : 'Song generieren'}
          </button>
        </div>
        <div className="am-a-lane" aria-label={playing ? `Vorschau ${playing.name}` : `Struktur ${bars} Takte`}>
          {Array.from({ length: Math.min(bars, 64) }, (_, i) => (
            <i key={i} style={{ ['--pc' as string]: `hsl(${(Math.floor(i / 4) * 52 + 30) % 360} 70% 58%)` }} />
          ))}
          {playing ? <b className="am-a-ph" style={{ left: `${progress * 100}%` }} /> : null}
          <span className="am-a-lanelbl am-mono">{playing ? playing.name : `${duration} s · ${bars} Takte`}</span>
        </div>
      </AmCard>

      <AmCard title="Playlist" style={{ width: 280 }} right={playingId ? <button type="button" className="am-tg am-on" onClick={stopPreview}>■</button> : null}>
        <div className="am-list am-a-scroll" role="listbox" aria-label="Erzeugte Songs">
          {playlist.length === 0 ? <span className="am-hint">Noch keine Songs – erzeugte Songs erscheinen hier.</span> : null}
          {playlist.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={playingId === s.id}
              className={playingId === s.id ? 'am-on' : ''}
              title={s.description}
              onClick={() => (playingId === s.id ? stopPreview() : s.url && playUrl(s.id, s.url))}
            >
              <span className="am-a-ell">{s.name}</span><i>{playingId === s.id ? '■' : '▶'}</i>
            </button>
          ))}
        </div>
        <div className="am-a-log am-mono" aria-live="polite">
          {lastLog.length === 0 && <div className="am-hint">Noch keine Generierung.</div>}
          {lastLog.map((line, i) => <div key={i} className={line.startsWith('✓') ? 'am-a-ok' : 'am-a-err'}>{line}</div>)}
        </div>
      </AmCard>
    </div>
  );
});
