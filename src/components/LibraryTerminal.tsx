import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Database, Play, Download, Clipboard, GripVertical, ChevronLeft, ChevronRight, Cloud, CloudOff, Upload } from 'lucide-react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { SORTED_MUSIC_LIBRARY, MusicTrack } from '../data/musicLibrary';
import { fetchCloudMusic, CloudMusicRow, pushMusicToCloud } from '../lib/supabaseClient';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { analyzeMusic } from '../utils/audioAnalyzer';
import { SemanticSampleSearch } from './SemanticSampleSearch';
import { Scratchpad } from './Scratchpad';
import { CloudStatusBadge } from './CloudStatusBadge';
import { SampleUploadPanel } from './SampleUploadPanel';

const ITEMS_PER_PAGE = 9;

function cloudRowToTrack(row: CloudMusicRow): MusicTrack {
  return { id: row.id, name: row.name, artist: row.artist, url: row.url, bpm: row.bpm ?? undefined };
}

export const LibraryTerminal = React.memo(function LibraryTerminal() {
  const { samples, addSample, cloudEnabled, pushSampleToCloud, syncCloudDatabase, pendingSample, setPendingSample } = useSamples();
  const [category, setCategory] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  // Cloud-Schreibpfad-Status (einzelner Push / Sync), für Mini-Feedback im Header.
  const [cloudStatus, setCloudStatus] = useState<string>('');
  const [cloudBusy, setCloudBusy] = useState(false);

  // Musik-Bibliothek: lokal vorbefüllt aus den eingebauten Tracks, nach dem
  // Mount um Cloud-Tracks von Supabase ergänzt (falls verfügbar).
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>(SORTED_MUSIC_LIBRARY);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchCloudMusic();
      if (cancelled || !result.ok || result.data.length === 0) return;
      const merged = new Map<string, MusicTrack>();
      SORTED_MUSIC_LIBRARY.forEach((t) => merged.set(t.id, t));
      result.data.forEach((t) => merged.set(t.id, cloudRowToTrack(t)));
      setMusicTracks(Array.from(merged.values()));
    })();
    return () => { cancelled = true; };
  }, []);

  const filteredSamples = useMemo(() =>
    samples.filter(sample => category === 'all' || sample.category === category),
    [samples, category]
  );

  const totalPages = Math.max(1, Math.ceil(filteredSamples.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedSamples = filteredSamples.slice(
    (safePage - 1) * ITEMS_PER_PAGE,
    safePage * ITEMS_PER_PAGE
  );

  const handleCopy = (sample: AudioSample) => {
    navigator.clipboard.writeText(JSON.stringify(sample, null, 2));
  };

  const handleDragStart = (e: React.DragEvent, sample: AudioSample) => {
    e.dataTransfer.setData('application/json', JSON.stringify(sample));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const changePage = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setCurrentPage(newPage);
    }
  };

  // --- Cloud-Schreibpfad: eingebaute Presets in die externe Datenbank syncen ---
  const handleCloudSync = async () => {
    setCloudBusy(true);
    setCloudStatus('SYNC …');
    const result = await syncCloudDatabase();
    setCloudStatus(result.ok ? 'SYNC OK' : 'SYNC: ' + (result.error ?? 'fehlgeschlagen'));
    setCloudBusy(false);
  };

  // --- Cloud-Schreibpfad: einzelnes Sample in die externe Datenbank pushen ---
  const handlePushSample = async (sample: AudioSample) => {
    setCloudBusy(true);
    setCloudStatus('PUSH ' + sample.id + ' …');
    const result = await pushSampleToCloud(sample);
    setCloudStatus(result.ok ? 'PUSH OK: ' + sample.id : 'PUSH: ' + (result.error ?? 'fehlgeschlagen'));
    setCloudBusy(false);
  };

  // --- Cloud-Schreibpfad: einzelnen Musik-Track in die externe Datenbank pushen ---
  const handlePushMusic = async (track: MusicTrack) => {
    setCloudBusy(true);
    setCloudStatus('PUSH ' + track.name + ' …');
    const result = await pushMusicToCloud({ id: track.id, name: track.name, artist: track.artist, url: track.url, bpm: track.bpm ?? null });
    setCloudStatus(result.ok ? 'PUSH OK: ' + track.name : 'PUSH: ' + (result.error ?? 'fehlgeschlagen'));
    setCloudBusy(false);
  };

  // --- Automatische Musik-Analyse (BPM/Key, offline) – mit Ergebnis-Cache, ---
  // --- damit Tracks nicht bei jedem musicTracks-Update erneut analysiert werden.
  const [analysis, setAnalysis] = useState<Record<string, { bpm?: number; key?: string }>>({});
  const analysisCache = useRef<Map<string, { bpm?: number; key?: string } | null>>(new Map());
  useEffect(() => {
    if (category !== 'music') return;
    let cancelled = false;

    const apply = (url: string, a: { bpm?: number; key?: string } | null) => {
      if (cancelled || !a) return;
      setAnalysis((prev) => ({ ...prev, [url]: { bpm: a.bpm, key: a.key } }));
    };

    musicTracks.forEach((t) => {
      if (analysisCache.current.has(t.url)) {
        apply(t.url, analysisCache.current.get(t.url) ?? null);
        return;
      }
      analysisCache.current.set(t.url, null); // reserviert (verhindert Doppel-Analyse)
      analyzeMusic(t.url).then((a) => {
        analysisCache.current.set(t.url, a ?? null);
        apply(t.url, a);
      });
    });
    return () => { cancelled = true; };

  }, [category, musicTracks]);

  return (
    <div className="w-full h-full flex flex-col bg-[#111] rounded-xl border border-neutral-800 overflow-hidden text-neutral-300 font-sans shadow-2xl">
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <div className="flex items-center gap-2">
          <MoaAssistant pluginId="library" placeholder="MOA: z. B. 'Cloud-Sync starten'" />
          <CloudStatusBadge />
        </div>
      </div>
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-fuchsia-900/20 to-[#111] border-b border-fuchsia-900/30 gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-fuchsia-500/20 flex items-center justify-center border border-fuchsia-500/50 shadow-[0_0_15px_rgba(192,38,211,0.3)]">
            <Database className="w-5 h-5 text-fuchsia-400" />
          </div>
          <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase">Sample Library</h2>
        </div>

        <div className="flex items-center gap-2 flex-1 max-w-sm">
            <SampleUploadPanel />
            <SemanticSampleSearch onSelect={addSample} />
            <Scratchpad />
        </div>

        <div className="flex items-center gap-2">
            <span
              title="Externe Sample-/Musik-Datenbank (Supabase, Lesen via anon-key)"
              className={`flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded border ${
                cloudEnabled
                  ? 'text-emerald-400 border-emerald-900/60 bg-emerald-950/30'
                  : 'text-neutral-600 border-neutral-800 bg-black'
              }`}
            >
              {cloudEnabled ? <Cloud className="w-3 h-3" /> : <CloudOff className="w-3 h-3" />}
              CLOUD {cloudEnabled ? 'READ' : 'OFF'}
            </span>
            <button type="button"
              onClick={handleCloudSync}
              disabled={cloudBusy}
              className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded bg-fuchsia-900/30 border border-fuchsia-800/50 text-fuchsia-300 hover:bg-fuchsia-800/40 disabled:opacity-40"
            >
              <Upload className="w-3 h-3" /> SYNC
            </button>
            {cloudStatus && (
              <span className="text-[9px] font-mono text-neutral-500 max-w-[140px] truncate" title={cloudStatus}>
                {cloudStatus}
              </span>
            )}
        </div>

        <select
            className="bg-[#1a1a1a] border border-neutral-800 rounded-lg px-4 py-2 text-sm focus:outline-none"
            onChange={(e) => {
                setCategory(e.target.value);
                setCurrentPage(1);
            }}
        >
            <option value="all">All Categories</option>
            <option value="bass">Bass</option>
            <option value="mids">Mids</option>
            <option value="highs">Highs</option>
            <option value="music">🎵 Musik</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {category === 'music' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {musicTracks.map((t: MusicTrack) => (
              <div key={t.id} className="bg-[#161616] border border-neutral-800 rounded-lg p-4 flex flex-col gap-2 hover:border-amber-500/50 transition-colors group">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_#fbbf24]" />
                    <div>
                      <h4 className="font-bold text-sm text-neutral-200 line-clamp-1">{t.name}</h4>
                      <span className="text-[10px] font-mono text-amber-400 uppercase">{t.artist}</span>
                    </div>
                  </div>
                  <button type="button"
                    onClick={() => audioEngine.previewSample('channel5', undefined, t.url)}
                    className="w-8 h-8 rounded-full bg-[#111] flex items-center justify-center hover:bg-amber-600 transition-colors"
                  >
                    <Play className="w-4 h-4 text-neutral-400 hover:text-white fill-current" />
                  </button>
                </div>
                <p className="text-[11px] text-neutral-500 font-mono">Track aus deiner Musik-Bibliothek</p>
                <div className="flex gap-3 text-[9px] font-mono">
                  <span className="flex items-center gap-1"><span className="text-amber-500">BPM</span>
                    {analysis[t.url]?.bpm ?? <span className="text-neutral-600 animate-pulse">…</span>}
                  </span>
                  <span className="flex items-center gap-1"><span className="text-amber-500">KEY</span>
                    {analysis[t.url]?.key ?? <span className="text-neutral-600">--</span>}
                  </span>
                </div>
                <div className="mt-auto pt-4 flex justify-between items-center">
                  <span className="text-[9px] font-mono text-neutral-600 bg-black px-2 py-1 rounded truncate">{t.url}</span>
                  <div className="flex gap-2">
                    <button type="button"
                      onClick={() => audioEngine.previewSample('channel5', undefined, t.url)}
                      className="text-[10px] font-bold text-neutral-400 hover:text-white"
                    >LOAD</button>
                    <button type="button"
                      onClick={() => handlePushMusic(t)}
                      disabled={cloudBusy}
                      title="In externe Musik-Datenbank (Supabase) pushen"
                      className="text-[10px] font-bold text-neutral-400 hover:text-emerald-300 disabled:opacity-40"
                    >PUSH</button>
                    <button type="button"
                      onClick={() => audioEngine.loadTrackSample('channel1', t.url)}
                      title="In Mischpult-Kanal 1 laden"
                      className="text-[10px] font-bold text-neutral-400 hover:text-amber-300"
                    >ADD</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {paginatedSamples.map((sample: AudioSample) => (
            <div
              key={sample.id}
              role="button"
              tabIndex={0}
              draggable
              onDragStart={(e) => handleDragStart(e, sample)}
              onClick={() => {
                // Touch-Fallback: Sample "armieren" – danach Drop-Zone antippen.
                if (pendingSample?.id === sample.id) setPendingSample(null);
                else setPendingSample(sample);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (pendingSample?.id === sample.id) setPendingSample(null);
                  else setPendingSample(sample);
                }
              }}
              className={`bg-[#161616] border rounded-lg p-4 flex flex-col gap-2 transition-colors group cursor-grab active:cursor-grabbing ${
                pendingSample?.id === sample.id
                  ? 'border-fuchsia-500 ring-2 ring-fuchsia-500/50 shadow-[0_0_18px_-4px_rgba(217,70,239,0.5)]'
                  : 'border-neutral-800 hover:border-fuchsia-500/50'
              }`}
            >
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-2">
                  <GripVertical className="w-4 h-4 text-neutral-700 group-hover:text-fuchsia-500" />
                  <div>
                    <h4 className="font-bold text-sm text-neutral-200">{sample.name}</h4>
                    <span className="text-[10px] font-mono text-fuchsia-400 uppercase">{sample.type}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (sample.url) audioEngine.previewSample('channel5', undefined, sample.url);
                    else audioEngine.previewSynthesizedSample(sample.parameters ?? {});
                  }}
                  title={sample.url ? 'Sample-Vorschau abspielen' : 'Synthetische Vorschau abspielen'}
                  aria-label={`${sample.name} Vorschau`}
                  className="w-8 h-8 rounded-full bg-[#111] flex items-center justify-center hover:bg-fuchsia-600 transition-colors cursor-pointer"
                >
                  <Play className="w-4 h-4 text-neutral-400 hover:text-white fill-current" />
                </button>
              </div>
              <p className="text-[11px] text-neutral-500 font-mono line-clamp-2">{sample.description}</p>
              <div className="mt-auto pt-4 flex justify-between items-center">
                <span className="text-[9px] font-mono text-neutral-600 bg-black px-2 py-1 rounded">ID: {sample.id}</span>
                <div className="flex gap-2">
                    <button type="button"
                        onClick={() => handleCopy(sample)}
                        className="flex items-center gap-1 text-[10px] font-bold text-neutral-400 hover:text-fuchsia-300"
                    >
                        <Clipboard className="w-3 h-3" /> COPY
                    </button>
                    <button type="button"
                        onClick={() => handlePushSample(sample)}
                        disabled={cloudBusy}
                        title="In externe Sample-Datenbank (Supabase) pushen"
                        className="flex items-center gap-1 text-[10px] font-bold text-neutral-400 hover:text-emerald-300 disabled:opacity-40"
                    >
                        <Upload className="w-3 h-3" /> PUSH
                    </button>
                    <button type="button"
                        onClick={() => { if (sample.url) audioEngine.loadTrackSample('channel5', sample.url); }}
                        title={sample.url ? 'Sample in Mischpult-Kanal 5 laden' : 'Synthetisches Sample – über Instrumente spielbar'}
                        className="flex items-center gap-1 text-[10px] font-bold text-neutral-400 hover:text-white"
                    >
                        <Download className="w-3 h-3" /> ADD
                    </button>
                </div>
              </div>
            </div>
          ))}
        </div>
        )}
      </div>

      {/* Pagination Controls */}
      <div className="px-6 py-4 bg-[#111] border-t border-neutral-800 flex justify-between items-center">
        <div className="text-[10px] text-neutral-500 font-mono">
            {category === 'music'
              ? `SHOWING ${musicTracks.length} MUSIC TRACKS`
              : `SHOWING ${paginatedSamples.length} OF ${filteredSamples.length} SAMPLES`}
        </div>
        <div className="flex items-center gap-4">
            {category !== 'music' && (<>
            <button type="button"
                onClick={() => changePage(currentPage - 1)}
                disabled={currentPage === 1}
                className={`p-1 rounded ${currentPage === 1 ? 'text-neutral-700' : 'text-fuchsia-400 hover:bg-fuchsia-900/20'}`}
            >
                <ChevronLeft className="w-5 h-5" />
            </button>
            <span className="text-xs font-bold font-mono">
                PAGE <span className="text-fuchsia-400">{currentPage}</span> / {totalPages}
            </span>
            <button type="button"
                onClick={() => changePage(currentPage + 1)}
                disabled={currentPage === totalPages}
                className={`p-1 rounded ${currentPage === totalPages ? 'text-neutral-700' : 'text-fuchsia-400 hover:bg-fuchsia-900/20'}`}
            >
                <ChevronRight className="w-5 h-5" />
            </button>
            </>)}
        </div>
      </div>
    </div>
  );
});
