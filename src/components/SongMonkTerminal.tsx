import React, { useCallback, useState } from 'react';
import { Music, Sparkles } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { useSamples } from '../context/SampleContext';
import type { AudioSample } from '../data/samples';

/**
 * songMONK – AI-Song-Generator (Suno-artig)
 * =========================================
 * Eigenständiges Terminal, vorbereitet für die Plugin-Registry.
 * Aktuell wird es noch nicht als 22. Plugin registriert (das würde die
 * hart verdrahteten 21-Plugin-Invarianten vieler Module/Tests anfassen);
 * die Komponente kann aber direkt gemountet werden und nutzt den neuen
 * Server-Endpoint `POST /api/song/generate` (Runtime-first, HF-Fallback).
 */
export const SongMonkTerminal = React.memo(function SongMonkTerminal() {
  const { state, updateState } = usePluginState('song', 'PRO');
  const { addSample } = useSamples();

  const [prompt, setPrompt] = useState('Dark warehouse techno mit treibendem Bass und hypnotischen Vocals');
  const [style, setStyle] = useState('dark techno');
  const [bpm, setBpm] = useState(128);
  const [duration, setDuration] = useState(8);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const pushLog = useCallback((line: string) => {
    setLog(prev => [...prev.slice(-9), line]);
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
      try {
        const audio = new Audio(url);
        audio.volume = 0.9;
        void audio.play().catch(() => { /* Autoplay-Block ignorieren */ });
      } catch { /* Audio nur im Browser verfügbar */ }
      pushLog(`✓ Song erzeugt (${duration}s @ ${bpm} BPM) → biblioMONK (${sample.name})`);
    } catch (err) {
      pushLog(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [addSample, bpm, duration, prompt, pushLog, style]);

  return (
    <div className="w-full h-full flex flex-col bg-[#111] rounded-xl border border-neutral-800 overflow-hidden text-neutral-300 font-sans">
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Music className="w-4 h-4 text-amber-400" />
          <span className="text-[10px] font-bold tracking-[0.25em] text-neutral-400 uppercase">AI Song Generator</span>
        </div>
        <select value={state} onChange={(e) => updateState(e.target.value as never)} className="bg-black text-white text-xs p-1 rounded">
          <option value="OFF">OFF</option>
          <option value="AUTO_AI">AI</option>
          <option value="PRO">ACTIVE</option>
        </select>
      </div>

      <div className="flex-1 p-6 overflow-y-auto space-y-5">
        <div className="flex items-center gap-3 border-b border-amber-900/30 pb-3">
          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center border border-amber-500/50">
            <Music className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase">songMONK</h2>
            <p className="text-[10px] text-neutral-500">Text → Song · Runtime-first (MusicGen, später ACE-Step/DiffRhythm)</p>
          </div>
        </div>

        <label className="block text-xs text-neutral-400">
          Song-Prompt
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="mt-1 w-full bg-black border border-neutral-800 rounded p-2 text-sm text-neutral-200"
            placeholder="Beschreibe Stil, Energie, Instrumente, Vocals …"
          />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label className="text-xs text-neutral-400">
            Style
            <input value={style} onChange={(e) => setStyle(e.target.value)} className="mt-1 w-full bg-black border border-neutral-800 rounded px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-neutral-400">
            BPM
            <input type="number" min={40} max={220} value={bpm} onChange={(e) => setBpm(Number(e.target.value))} className="mt-1 w-full bg-black border border-neutral-800 rounded px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-neutral-400">
            Dauer (s)
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="mt-1 w-full bg-black border border-neutral-800 rounded px-2 py-1.5 text-sm">
              {[4, 6, 8, 12, 16, 20, 30].map(sec => <option key={sec} value={sec}>{sec} s</option>)}
            </select>
          </label>
        </div>

        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-amber-600/20 border border-amber-500/50 text-amber-200 font-bold text-sm hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-wait transition-all"
        >
          <Sparkles className={`w-4 h-4 ${busy ? 'animate-pulse' : ''}`} />
          {busy ? 'Generiere Song …' : 'Song generieren'}
        </button>

        <div className="bg-black/40 border border-neutral-800 rounded-xl p-4 min-h-[90px]">
          <h3 className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-2">Generator-Log</h3>
          <div className="space-y-1 font-mono text-[11px]">
            {log.length === 0 && <div className="text-neutral-600">Noch keine Generierung.</div>}
            {log.map((line, i) => <div key={i} className={line.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}>{line}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
});
