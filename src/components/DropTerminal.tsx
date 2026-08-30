import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Zap } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { useSamples } from '../context/SampleContext';
import { MoaAssistant } from './MoaAssistant';
import { audioEngine } from '../utils/audioEngine';
import { analyzeMusic } from '../utils/audioAnalyzer';
import { MUSIC_LIBRARY } from '../data/musicLibrary';
import { PRESET_SAMPLE_DATABASE } from '../data/samples';
import { random } from '../utils/random';

interface DropLogEntry {
  at: string;
  sampleName: string;
  bpm: number | undefined;
}

/**
 * dropMONK – KI-gestützter Auto-Drop-Modus
 * ========================================
 * Analysiert einen geladenen Musik-Track (BPM/Key), wählt passende One-Shots
 * aus der Session-Bibliothek und setzt sie automatisch auf den nächsten Takt.
 */
export const DropTerminal = React.memo(function DropTerminal() {
  const { state, updateState } = usePluginState('drop', 'PRO');
  const { samples } = useSamples();
  const [trackUrl, setTrackUrl] = useState<string>(MUSIC_LIBRARY[0]?.url ?? '');
  const [bpm, setBpm] = useState<number | undefined>(undefined);
  const [key, setKey] = useState<string | undefined>(undefined);
  const [analyzing, setAnalyzing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [log, setLog] = useState<DropLogEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pushLog = useCallback((entry: DropLogEntry) => {
    setLog((prev) => [...prev.slice(-11), entry]);
  }, []);

  const analyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      const result = await analyzeMusic(trackUrl);
      setBpm(result?.bpm);
      setKey(result?.key ?? result?.camelot);
    } catch {
      setBpm(undefined);
      setKey(undefined);
    } finally {
      setAnalyzing(false);
    }
  }, [trackUrl]);

  const dropOnce = useCallback(() => {
    // Passende One-Shots bevorzugen: eigene Uploads, sonst Preset-Datenbank.
    const pool = samples.length > 0 ? samples : PRESET_SAMPLE_DATABASE;
    const picks = pool.filter((s) => s.category === 'mids' || s.category === 'highs');
    if (picks.length === 0) return;
    const pick = picks[Math.floor(random() * picks.length)];

    if (pick.url) {
      void audioEngine.loadTrackSample('channel5', pick.url);
      audioEngine.triggerEvent('channel5', 0.9);
    } else {
      audioEngine.previewSynthesizedSample(pick.parameters ?? {});
      audioEngine.triggerEvent('channel5', 0.9);
    }
    pushLog({ at: new Date().toLocaleTimeString('de-DE'), sampleName: pick.name, bpm });
  }, [samples, bpm, pushLog]);

  const toggleDrop = useCallback(() => {
    if (dropping) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      setDropping(false);
      return;
    }
    if (!bpm) return;
    const barMs = (60 / bpm) * 4000; // 1 Takt = 4 Schläge
    dropOnce();
    timerRef.current = setInterval(dropOnce, barMs);
    setDropping(true);
  }, [bpm, dropping, dropOnce]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  return (
    <div className="w-full h-full flex flex-col bg-[#111] rounded-xl border border-neutral-800 overflow-hidden text-neutral-300 font-sans">
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="drop" placeholder="MOA: z. B. 'Auto-Drop starten'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-rose-900/20 to-[#111] border-b border-rose-900/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-rose-500/20 flex items-center justify-center border border-rose-500/50">
            <Zap className="w-5 h-5 text-rose-400" />
          </div>
          <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase">dropMONK</h2>
        </div>
        <select value={state} onChange={(e) => updateState(e.target.value as never)} className="bg-black text-white text-xs p-1 rounded">
          <option value="OFF">OFF</option>
          <option value="AUTO_AI">AI</option>
          <option value="PRO">ACTIVE</option>
        </select>
      </div>

      <div className="flex-1 p-6 overflow-y-auto space-y-6">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex-1 min-w-[200px]">
            <span className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase">Musik-Track</span>
            <select value={trackUrl} onChange={(e) => { setTrackUrl(e.target.value); setBpm(undefined); setKey(undefined); }} className="mt-1 w-full bg-[#1a1a1a] border border-neutral-800 rounded-lg px-3 py-2 text-sm">
              {MUSIC_LIBRARY.map((t) => <option key={t.id} value={t.url}>{t.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={analyze} disabled={analyzing} className="px-4 py-2 rounded-lg border border-rose-500/50 bg-rose-500/10 text-rose-200 text-xs font-bold tracking-widest hover:bg-rose-500/20 disabled:opacity-40">
            {analyzing ? 'ANALYSIERE…' : 'ANALYSIEREN'}
          </button>
          <button type="button" onClick={toggleDrop} disabled={!bpm} className={`px-5 py-2 rounded-lg border text-xs font-black tracking-widest transition-all ${dropping ? 'border-red-500 bg-red-500/20 text-red-200 animate-pulse' : 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'} disabled:opacity-40`}>
            {dropping ? '■ AUTO-DROP STOPP' : '▶ AUTO-DROP START'}
          </button>
        </div>

        <div className="flex gap-4 font-mono text-[11px]">
          <div className="flex-1 bg-[#161616] border border-neutral-800 rounded-xl p-4">
            <span className="text-neutral-500">BPM</span>
            <div className="text-2xl font-black text-rose-300">{bpm ?? (analyzing ? '…' : '—')}</div>
          </div>
          <div className="flex-1 bg-[#161616] border border-neutral-800 rounded-xl p-4">
            <span className="text-neutral-500">KEY</span>
            <div className="text-2xl font-black text-rose-300">{key ?? '—'}</div>
          </div>
          <div className="flex-1 bg-[#161616] border border-neutral-800 rounded-xl p-4">
            <span className="text-neutral-500">DROP-QUELLE</span>
            <div className="text-2xl font-black text-rose-300">{samples.length > 0 ? 'SESSION' : 'PRESETS'}</div>
          </div>
        </div>

        <div className="bg-black/40 border border-neutral-800 rounded-xl p-4 min-h-[140px]">
          <h3 className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-2">Drop-Log</h3>
          <div className="space-y-1 font-mono text-[11px]">
            {log.length === 0 && <div className="text-neutral-600">Noch keine Drops – Track analysieren und AUTO-DROP starten.</div>}
            {log.map((entry, i) => (
              <div key={i} className="text-rose-200/80">[{entry.at}] → {entry.sampleName} {entry.bpm ? `· ${Math.round(entry.bpm)} BPM` : ''}</div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 text-[10px] font-mono text-neutral-500">
          <AudioLines className="w-3 h-3" /> AUTO-DROP setzt One-Shots automatisch auf Kanal 5 (Sampler-Bus) im Takt-Raster.
        </div>
      </div>
    </div>
  );
});
