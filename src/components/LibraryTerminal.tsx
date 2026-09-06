import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Database, Download, Clipboard, GripVertical, ChevronLeft, ChevronRight, Cloud, CloudOff, Upload, Heart, Folder, FolderOpen, Search } from 'lucide-react';
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
import { QuickImportPanel } from './QuickImportPanel';
import { loadFavorites, saveFavorites, toggleFavoriteId, type FavoritesState } from '../utils/libraryFavorites';
import { openAudioActionMenu } from './AudioActionMenuHost';
import { musicToContent, sampleToContent } from '../core/audio/audioContent';

const ITEMS_PER_PAGE = 9;

type FolderId = 'all' | 'favorites' | 'bass' | 'mids' | 'highs' | 'music';

function cloudRowToTrack(row: CloudMusicRow): MusicTrack {
  return { id: row.id, name: row.name, artist: row.artist, url: row.url, bpm: row.bpm ?? undefined };
}

const FOLDERS: { id: FolderId; label: string; group: string }[] = [
  { id: 'favorites', label: 'Favoriten', group: 'FAVORITEN' },
  { id: 'all', label: 'Alle Samples', group: 'SAMPLES' },
  { id: 'bass', label: 'Bass', group: 'SAMPLES' },
  { id: 'mids', label: 'Mids', group: 'SAMPLES' },
  { id: 'highs', label: 'Highs', group: 'SAMPLES' },
  { id: 'music', label: 'Musik', group: 'MUSIK' },
];

export const LibraryTerminal = React.memo(function LibraryTerminal() {
  const { samples, addSample, cloudEnabled, pushSampleToCloud, syncCloudDatabase, pendingSample } = useSamples();
  const [folder, setFolder] = useState<FolderId>('all');
  const [query, setQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [musicPage, setMusicPage] = useState(1);
  // Cloud-Schreibpfad-Status (einzelner Push / Sync), für Mini-Feedback im Header.
  const [cloudStatus, setCloudStatus] = useState<string>('');
  const [cloudBusy, setCloudBusy] = useState(false);

  // Favoriten (Sample-IDs + Musik-IDs), persistiert im Browser.
  const [favorites, setFavorites] = useState<FavoritesState>(() => loadFavorites());
  useEffect(() => {
    saveFavorites(favorites);
  }, [favorites]);

  const toggleFavoriteSample = (id: string) => {
    setFavorites((prev) => ({ ...prev, samples: toggleFavoriteId(prev.samples, id) }));
  };

  const toggleFavoriteMusic = (id: string) => {
    setFavorites((prev) => ({ ...prev, music: toggleFavoriteId(prev.music, id) }));
  };

  // Musik-Bibliothek: lokal vorbefüllt aus den eingebauten Tracks, nach dem
  // Mount um Cloud-Tracks von Supabase ergänzt (falls verfügbar).
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>(SORTED_MUSIC_LIBRARY);
  // #5: Cloud-/DB-Musik laden und nach lokalen Imports (QuickImport) aktualisieren.
  const refreshCloudMusic = React.useCallback(async () => {
    const result = await fetchCloudMusic();
    if (!result.ok || result.data.length === 0) return;
    const merged = new Map<string, MusicTrack>();
    SORTED_MUSIC_LIBRARY.forEach((t) => merged.set(t.id, t));
    result.data.forEach((t) => merged.set(t.id, cloudRowToTrack(t)));
    setMusicTracks(Array.from(merged.values()));
  }, []);
  useEffect(() => {
    let cancelled = false;
    void refreshCloudMusic();
    const onLibraryChanged = () => { if (!cancelled) void refreshCloudMusic(); };
    window.addEventListener('monk:library-changed', onLibraryChanged);
    return () => { cancelled = true; window.removeEventListener('monk:library-changed', onLibraryChanged); };
  }, [refreshCloudMusic]);

  const filteredSamples = useMemo(() => {
    let list = samples;
    if (folder === 'bass' || folder === 'mids' || folder === 'highs') {
      list = list.filter((s) => s.category === folder);
    }
    if (folder === 'favorites') {
      list = list.filter((s) => favorites.samples.includes(s.id));
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        s.type.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [samples, folder, favorites.samples, query]);

  const filteredMusic = useMemo(() => {
    let list = musicTracks;
    if (folder === 'favorites') {
      list = list.filter((t) => favorites.music.includes(t.id));
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((t) => t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
    }
    return list;
  }, [musicTracks, folder, favorites.music, query]);

  const showMusic = folder === 'music';
  const showFavorites = folder === 'favorites';

  const totalPages = Math.max(1, Math.ceil(filteredSamples.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedSamples = filteredSamples.slice(
    (safePage - 1) * ITEMS_PER_PAGE,
    safePage * ITEMS_PER_PAGE,
  );

  // Musik ebenfalls paginieren (48+ Tracks → deutlich schnelleres Rendering).
  const musicTotalPages = Math.max(1, Math.ceil(filteredMusic.length / ITEMS_PER_PAGE));
  const safeMusicPage = Math.min(musicPage, musicTotalPages);
  const paginatedMusic = filteredMusic.slice(
    (safeMusicPage - 1) * ITEMS_PER_PAGE,
    safeMusicPage * ITEMS_PER_PAGE,
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
    if (!showMusic && !showFavorites) return;
    let cancelled = false;

    const apply = (url: string, a: { bpm?: number; key?: string } | null) => {
      if (cancelled || !a) return;
      setAnalysis((prev) => ({ ...prev, [url]: { bpm: a.bpm, key: a.key } }));
    };

    paginatedMusic.forEach((t) => {
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

  }, [paginatedMusic, showMusic, showFavorites]);

  const renderMusicCard = (t: MusicTrack) => {
    const isFav = favorites.music.includes(t.id);
    return (
      <div
        key={t.id}
        role="button"
        tabIndex={0}
        onClick={(e) => openAudioActionMenu(musicToContent(t), e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openAudioActionMenu(musicToContent(t), e.currentTarget as HTMLElement);
          }
        }}
        className="bg-[#161616] border border-neutral-800 rounded-lg p-4 flex flex-col gap-2 hover:border-amber-500/50 transition-colors group cursor-pointer"
      >
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_#fbbf24]" />
            <div>
              <h4 className="font-bold text-sm text-neutral-200 line-clamp-1">{t.name}</h4>
              <span className="text-[11px] font-mono text-amber-400 uppercase">{t.artist}</span>
            </div>
          </div>
          <button type="button"
            onClick={(e) => { e.stopPropagation(); toggleFavoriteMusic(t.id); }}
            title={isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors cursor-pointer ${isFav ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40' : 'bg-[#111] text-neutral-500 hover:text-rose-400 border border-neutral-800'}`}
          >
            <Heart className="w-4 h-4" fill={isFav ? 'currentColor' : 'none'} />
          </button>
        </div>
        <p className="text-[11px] text-neutral-500 font-mono">Track aus deiner Musik-Bibliothek</p>
        <div className="flex gap-3 text-[11px] font-mono">
          <span className="flex items-center gap-1"><span className="text-amber-500">BPM</span>
            {analysis[t.url]?.bpm ?? <span className="text-neutral-600 animate-pulse">…</span>}
          </span>
          <span className="flex items-center gap-1"><span className="text-amber-500">KEY</span>
            {analysis[t.url]?.key ?? <span className="text-neutral-600">--</span>}
          </span>
        </div>
        <div className="mt-auto pt-4 flex justify-between items-center">
          <span className="text-[11px] font-mono text-neutral-600 bg-black px-2 py-1 rounded truncate">{t.url}</span>
          <div className="flex gap-2">
            <button type="button"
              onClick={(e) => { e.stopPropagation(); openAudioActionMenu(musicToContent(t), e.currentTarget); }}
              title="Aktionen öffnen"
              className="text-[11px] font-bold text-neutral-400 hover:text-cyan-300 cursor-pointer"
            >⋮</button>
            <button type="button"
              onClick={(e) => { e.stopPropagation(); audioEngine.previewSample('channel5', undefined, t.url); }}
              className="text-[11px] font-bold text-neutral-400 hover:text-white cursor-pointer"
            >LOAD</button>
            <button type="button"
              onClick={(e) => { e.stopPropagation(); handlePushMusic(t); }}
              disabled={cloudBusy}
              title="In externe Musik-Datenbank (Supabase) pushen"
              className="text-[11px] font-bold text-neutral-400 hover:text-emerald-300 disabled:opacity-40 cursor-pointer"
            >PUSH</button>
            <button type="button"
              onClick={(e) => { e.stopPropagation(); audioEngine.loadTrackSample('channel1', t.url); }}
              title="In Mischpult-Kanal 1 laden"
              className="text-[11px] font-bold text-neutral-400 hover:text-amber-300 cursor-pointer"
            >ADD</button>
          </div>
        </div>
      </div>
    );
  };

  const renderSampleCard = (sample: AudioSample) => {
    const isFav = favorites.samples.includes(sample.id);
    return (
      <div
        key={sample.id}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => handleDragStart(e, sample)}
        onClick={(e) => openAudioActionMenu(sampleToContent(sample, 'library'), e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openAudioActionMenu(sampleToContent(sample, 'library'), e.currentTarget as HTMLElement);
          }
        }}
        className={`bg-[#161616] border rounded-lg p-4 flex flex-col gap-2 transition-colors group cursor-pointer ${
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
              <span className="text-[11px] font-mono text-fuchsia-400 uppercase">{sample.type}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleFavoriteSample(sample.id); }}
            title={isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors cursor-pointer ${isFav ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40' : 'bg-[#111] text-neutral-500 hover:text-rose-400 border border-neutral-800'}`}
          >
            <Heart className="w-4 h-4" fill={isFav ? 'currentColor' : 'none'} />
          </button>
        </div>
        <p className="text-[11px] text-neutral-500 font-mono line-clamp-2">{sample.description}</p>
        <div className="mt-auto pt-4 flex justify-between items-center">
          <span className="text-[11px] font-mono text-neutral-600 bg-black px-2 py-1 rounded">ID: {sample.id}</span>
          <div className="flex gap-2">
            <button type="button"
              onClick={(e) => { e.stopPropagation(); openAudioActionMenu(sampleToContent(sample, 'library'), e.currentTarget); }}
              title="Aktionen öffnen"
              className="flex items-center gap-1 text-[11px] font-bold text-neutral-400 hover:text-cyan-300 cursor-pointer"
            >
              ⋮
            </button>
            <button type="button"
              onClick={(e) => { e.stopPropagation(); handleCopy(sample); }}
              className="flex items-center gap-1 text-[11px] font-bold text-neutral-400 hover:text-fuchsia-300 cursor-pointer"
            >
              <Clipboard className="w-3 h-3" /> COPY
            </button>
            <button type="button"
              onClick={(e) => { e.stopPropagation(); handlePushSample(sample); }}
              disabled={cloudBusy}
              title="In externe Sample-Datenbank (Supabase) pushen"
              className="flex items-center gap-1 text-[11px] font-bold text-neutral-400 hover:text-emerald-300 disabled:opacity-40 cursor-pointer"
            >
              <Upload className="w-3 h-3" /> PUSH
            </button>
            <button type="button"
              onClick={(e) => { e.stopPropagation(); if (sample.url) audioEngine.loadTrackSample('channel5', sample.url); }}
              title={sample.url ? 'Sample in Mischpult-Kanal 5 laden' : 'Synthetisches Sample – über Instrumente spielbar'}
              className="flex items-center gap-1 text-[11px] font-bold text-neutral-400 hover:text-white cursor-pointer"
            >
              <Download className="w-3 h-3" /> ADD
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#111] rounded-xl border border-neutral-800 overflow-hidden text-neutral-300 font-sans shadow-2xl">
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <div className="flex items-center gap-2">
          <MoaAssistant pluginId="library" placeholder="MOA: z. B. 'Cloud-Sync starten'" />
          <CloudStatusBadge />
        </div>
      </div>

      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-fuchsia-900/20 to-[#111] border-b border-fuchsia-900/30 gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-fuchsia-500/20 flex items-center justify-center border border-fuchsia-500/50 shadow-[0_0_15px_rgba(192,38,211,0.3)]">
            <Database className="w-5 h-5 text-fuchsia-400" />
          </div>
          <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase">biblioMONK</h2>
        </div>

        <div className="flex items-center gap-2 flex-1 max-w-md">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-fuchsia-400/70" />
            <input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setCurrentPage(1); }}
              placeholder="Suche Samples & Musik…"
              aria-label="Bibliothek durchsuchen"
              className="w-full bg-black/60 border border-neutral-800 rounded-lg pl-9 pr-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-fuchsia-500/60 placeholder:text-neutral-600"
            />
          </div>
          <SemanticSampleSearch onSelect={addSample} />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <SampleUploadPanel />
          <QuickImportPanel />
          <Scratchpad />
          <span
            title="Externe Sample-/Musik-Datenbank (Supabase, Lesen via anon-key)"
            className={`flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded border ${
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
            className="flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded bg-fuchsia-900/30 border border-fuchsia-800/50 text-fuchsia-300 hover:bg-fuchsia-800/40 disabled:opacity-40 cursor-pointer"
          >
            <Upload className="w-3 h-3" /> SYNC
          </button>
          {cloudStatus && (
            <span className="text-[11px] font-mono text-neutral-500 max-w-[140px] truncate" title={cloudStatus}>
              {cloudStatus}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Ordnerstruktur */}
        <aside className="w-44 short-landscape:w-36 shrink-0 border-r border-neutral-800 bg-[#0c0c0e] p-3 flex flex-col gap-1.5 overflow-y-auto">
          {(['FAVORITEN', 'SAMPLES', 'MUSIK'] as const).map((group) => (
            <div key={group}>
              <div className="text-[10px] font-mono tracking-[0.25em] text-neutral-600 uppercase mb-1">{group}</div>
              {FOLDERS.filter((f) => f.group === group).map((f) => {
                const active = folder === f.id;
                return (
                  <button
                    type="button"
                    key={f.id}
                    onClick={() => { setFolder(f.id); setCurrentPage(1); }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm transition-colors cursor-pointer ${
                      active ? 'bg-fuchsia-900/30 border border-fuchsia-500/40 text-fuchsia-300' : 'border border-transparent text-neutral-400 hover:bg-[#161616] hover:text-neutral-200'
                    }`}
                  >
                    {active ? <FolderOpen className="w-4 h-4 text-fuchsia-400" /> : <Folder className="w-4 h-4 text-neutral-600" />}
                    <span className="text-[11px] font-medium">{f.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="mt-auto pt-2 text-[10px] font-mono text-neutral-600 leading-relaxed">
            {favorites.samples.length + favorites.music.length} Favoriten
          </div>
        </aside>

        {/* Inhalt */}
        <div className="flex-1 overflow-y-auto p-6">
          {showFavorites && (
            <div className="mb-6">
              <h3 className="text-[11px] font-bold tracking-[0.3em] text-rose-400 uppercase mb-3">Favorisierte Musik</h3>
              {filteredMusic.length === 0 ? (
                <div className="text-[11px] font-mono text-neutral-600">Keine favorisierten Tracks …</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{filteredMusic.map(renderMusicCard)}</div>
              )}
            </div>
          )}

          {showMusic ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {paginatedMusic.map(renderMusicCard)}
            </div>
          ) : (
            <>
              {showFavorites && <h3 className="text-[11px] font-bold tracking-[0.3em] text-rose-400 uppercase mb-3">Favorisierte Samples</h3>}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {paginatedSamples.map(renderSampleCard)}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Pagination Controls */}
      <div className="px-6 py-4 bg-[#111] border-t border-neutral-800 flex justify-between items-center">
        <div className="text-[11px] text-neutral-500 font-mono">
          {showMusic
            ? `SHOWING ${paginatedMusic.length} OF ${filteredMusic.length} MUSIC TRACKS`
            : `SHOWING ${paginatedSamples.length} OF ${filteredSamples.length} SAMPLES`}
        </div>
        <div className="flex items-center gap-4">
          {showMusic ? (
            <>
              <button type="button"
                onClick={() => setMusicPage((p) => Math.max(1, p - 1))}
                disabled={safeMusicPage === 1}
                className={`p-1 rounded ${safeMusicPage === 1 ? 'text-neutral-700' : 'text-amber-400 hover:bg-amber-900/20 cursor-pointer'}`}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-xs font-bold font-mono">
                PAGE <span className="text-amber-400">{safeMusicPage}</span> / {musicTotalPages}
              </span>
              <button type="button"
                onClick={() => setMusicPage((p) => Math.min(musicTotalPages, p + 1))}
                disabled={safeMusicPage === musicTotalPages}
                className={`p-1 rounded ${safeMusicPage === musicTotalPages ? 'text-neutral-700' : 'text-amber-400 hover:bg-amber-900/20 cursor-pointer'}`}
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </>
          ) : (
            <>
              <button type="button"
                onClick={() => changePage(currentPage - 1)}
                disabled={currentPage === 1}
                className={`p-1 rounded ${currentPage === 1 ? 'text-neutral-700' : 'text-fuchsia-400 hover:bg-fuchsia-900/20 cursor-pointer'}`}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-xs font-bold font-mono">
                PAGE <span className="text-fuchsia-400">{currentPage}</span> / {totalPages}
              </span>
              <button type="button"
                onClick={() => changePage(currentPage + 1)}
                disabled={currentPage === totalPages}
                className={`p-1 rounded ${currentPage === totalPages ? 'text-neutral-700' : 'text-fuchsia-400 hover:bg-fuchsia-900/20 cursor-pointer'}`}
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
