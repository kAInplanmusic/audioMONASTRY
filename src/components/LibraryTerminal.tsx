/**
 * biblioMONK · Rack-Modul (Vorlagen public/uidesign/uibiblioMONK.jpg und
 * uiübersichtapp.jpg, Zeile 08): links Suche + Ordner, Mitte Liste als Tabelle,
 * rechts Vorschau des gewählten Eintrags (Hüllkurve + Preset-Werte + Aktionen),
 * ganz rechts Upload / USB-Import / Cloud – alles in einer Zeile.
 */
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Heart } from 'lucide-react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { SORTED_MUSIC_LIBRARY, MusicTrack } from '../data/musicLibrary';
import { fetchCloudMusic, CloudMusicRow, pushMusicToCloud } from '../lib/supabaseClient';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { analyzeMusic } from '../utils/audioAnalyzer';
import { AmCard, AmKnob } from './am/amUi';
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

type Osc = (frac: number) => number;
const OSC: Record<string, Osc> = {
  sine: (f) => Math.sin(2 * Math.PI * f),
  square: (f) => (f < 0.5 ? 1 : -1),
  sawtooth: (f) => 2 * f - 1,
  triangle: (f) => 1 - 4 * Math.abs(f - 0.5),
};

/**
 * Zeichnet die Hüllkurve eines Synth-Presets (Frequenz, Decay, Pitch-Decay,
 * Oszillator) – rein rechnerisch aus den Preset-Werten, kein Audio-Pfad.
 * Ohne Parameter (Datei-Sample, Musik) bleibt nur die Mittellinie.
 */
function drawPresetShape(cv: HTMLCanvasElement, p: AudioSample['parameters'] | null): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth || 220;
  const h = cv.clientHeight || 58;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const mid = h / 2;
  g.fillStyle = 'rgba(110,140,200,.28)';
  g.fillRect(0, mid, w, 1);
  if (!p?.frequency) return;
  const color = getComputedStyle(cv).getPropertyValue('--c').trim() || '#4cc9f0';
  const osc = OSC[p.oscillatorType ?? 'sine'] ?? OSC.sine;
  const decay = Math.max(0.02, p.decay ?? 0.3);
  const pd = p.pitchDecay ?? 0;
  const span = Math.min(2, decay * 1.2);
  const sub = 6;
  const dt = span / (Math.ceil(w) * sub);
  let phase = 0;
  g.fillStyle = color;
  for (let x = 0; x < w; x++) {
    let lo = 1;
    let hi = -1;
    for (let k = 0; k < sub; k++) {
      const t = (x * sub + k) * dt;
      const f = p.frequency * (pd > 0 ? 1 + 3 * Math.exp(-t / pd) : 1);
      phase = (phase + f * dt) % 1;
      const v = osc(phase) * Math.exp((-4 * t) / decay);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    g.fillRect(x, mid - hi * (mid - 2), 1, Math.max(1, (hi - lo) * (mid - 2)));
  }
}

const PresetShape = React.memo(function PresetShape({ params }: { params: AudioSample['parameters'] | null }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => { if (ref.current) drawPresetShape(ref.current, params); }, [params]);
  return <canvas ref={ref} className="am-disp" aria-label="Hüllkurve des Presets" />;
});

const noop = () => { /* nur Anzeige */ };

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

  // --- Auswahl für die Vorschau (nur Ansicht; fällt auf den ersten Eintrag zurück) ---
  const [selId, setSelId] = useState<string | null>(null);
  const selSample = useMemo(() => samples.find((s) => s.id === selId) ?? null, [samples, selId]);
  const selMusic = useMemo(() => musicTracks.find((t) => t.id === selId) ?? null, [musicTracks, selId]);
  const previewSample = selSample ?? (!selMusic && !showMusic ? paginatedSamples[0] ?? null : null);
  const previewMusic = selMusic ?? (!selSample && showMusic ? paginatedMusic[0] ?? null : null);

  const counts = useMemo(() => {
    const c: Record<FolderId, number> = { all: samples.length, favorites: favorites.samples.length + favorites.music.length, bass: 0, mids: 0, highs: 0, music: musicTracks.length };
    samples.forEach((s) => { c[s.category] += 1; });
    return c;
  }, [samples, musicTracks.length, favorites]);

  const openMusic = (t: MusicTrack, el: HTMLElement) => { setSelId(t.id); openAudioActionMenu(musicToContent(t), el); };
  const openSample = (sample: AudioSample, el: HTMLElement) => { setSelId(sample.id); openAudioActionMenu(sampleToContent(sample, 'library'), el); };
  const onRowKey = (e: React.KeyboardEvent<HTMLTableRowElement>, open: (el: HTMLElement) => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(e.currentTarget);
    }
  };

  const favButton = (isFav: boolean, toggle: () => void) => (
    <button type="button"
      onClick={(e) => { e.stopPropagation(); toggle(); }}
      title={isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
      aria-label={isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
      className={`am-bibfav ${isFav ? 'am-on' : ''}`}
    >
      <Heart fill={isFav ? 'currentColor' : 'none'} />
    </button>
  );

  const renderMusicRow = (t: MusicTrack) => (
    <tr
      key={t.id}
      tabIndex={0}
      className={previewMusic?.id === t.id ? 'am-on' : ''}
      onClick={(e) => openMusic(t, e.currentTarget)}
      onKeyDown={(e) => onRowKey(e, (el) => openMusic(t, el))}
    >
      <td>{favButton(favorites.music.includes(t.id), () => toggleFavoriteMusic(t.id))}</td>
      <td className="am-n"><h4>{t.name}</h4></td>
      <td className="am-bibt">{t.artist}</td>
      <td className="am-mono">
        {analysis[t.url]?.bpm ?? '…'} BPM · {analysis[t.url]?.key ?? '--'}
      </td>
    </tr>
  );

  const renderSampleRow = (sample: AudioSample) => (
    <tr
      key={sample.id}
      tabIndex={0}
      draggable
      onDragStart={(e) => handleDragStart(e, sample)}
      className={`${previewSample?.id === sample.id ? 'am-on' : ''} ${pendingSample?.id === sample.id ? 'am-pend' : ''}`}
      onClick={(e) => openSample(sample, e.currentTarget)}
      onKeyDown={(e) => onRowKey(e, (el) => openSample(sample, el))}
    >
      <td>{favButton(favorites.samples.includes(sample.id), () => toggleFavoriteSample(sample.id))}</td>
      <td className="am-n"><h4>{sample.name}</h4></td>
      <td className="am-bibt">{sample.type}</td>
      <td className="am-mono" title={sample.description}>{sample.id}</td>
    </tr>
  );

  const pager = showMusic
    ? { page: safeMusicPage, total: musicTotalPages, prev: () => setMusicPage((p) => Math.max(1, p - 1)), next: () => setMusicPage((p) => Math.min(musicTotalPages, p + 1)), shown: paginatedMusic.length, of: filteredMusic.length, unit: 'Tracks' }
    : { page: safePage, total: totalPages, prev: () => changePage(currentPage - 1), next: () => changePage(currentPage + 1), shown: paginatedSamples.length, of: filteredSamples.length, unit: 'Samples' };

  const params = previewSample?.parameters?.frequency ? previewSample.parameters : null;

  return (
    <div className="am-rackrow am-bib">
      <MoaAssistant pluginId="library" />
      <AmCard title="Suche" style={{ width: 200 }}>
        <input
          type="text"
          className="am-libq"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCurrentPage(1); }}
          placeholder="Suche Samples & Musik…"
          aria-label="Bibliothek durchsuchen"
        />
        <SemanticSampleSearch onSelect={addSample} />
        <div className="am-list" role="group" aria-label="Ordner">
          {FOLDERS.map((f) => (
            <button
              type="button"
              key={f.id}
              className={folder === f.id ? 'am-on' : ''}
              aria-pressed={folder === f.id}
              onClick={() => { setFolder(f.id); setCurrentPage(1); }}
            >
              <span>{f.label}</span><i>{counts[f.id]}</i>
            </button>
          ))}
        </div>
      </AmCard>

      <AmCard
        title={showFavorites ? 'Favoriten' : FOLDERS.find((f) => f.id === folder)?.label ?? 'Liste'}
        style={{ flex: 1, minWidth: 380 }}
        right={(
          <span className="am-bibpg">
            <span className="am-hint">{pager.shown} / {pager.of} {pager.unit}</span>
            <button type="button" className="am-tg" onClick={pager.prev} disabled={pager.page === 1} aria-label="Vorherige Seite">‹</button>
            <span className="am-mono">{pager.page}/{pager.total}</span>
            <button type="button" className="am-tg" onClick={pager.next} disabled={pager.page === pager.total} aria-label="Nächste Seite">›</button>
          </span>
        )}
      >
        <div className="am-bibscroll">
          <table className="am-tbl">
            <thead>
              <tr>
                <th aria-label="Favorit" />
                <th>Name</th>
                <th>{showMusic ? 'Artist' : 'Typ'}</th>
                <th>{showMusic ? 'Tempo · Key' : 'ID'}</th>
              </tr>
            </thead>
            <tbody>
              {showFavorites && (
                <tr className="am-bibsec"><td colSpan={4}>Favorisierte Musik</td></tr>
              )}
              {showFavorites && (filteredMusic.length === 0
                ? <tr className="am-bibsec"><td colSpan={4} className="am-hint">Keine favorisierten Tracks …</td></tr>
                : filteredMusic.map(renderMusicRow))}
              {showFavorites && <tr className="am-bibsec"><td colSpan={4}>Favorisierte Samples</td></tr>}
              {showMusic ? paginatedMusic.map(renderMusicRow) : paginatedSamples.map(renderSampleRow)}
            </tbody>
          </table>
        </div>
      </AmCard>

      <AmCard title="Vorschau" style={{ width: 250 }}>
        {previewMusic ? (
          <>
            <div className="am-bibname"><b>{previewMusic.name}</b><span className="am-hint">{previewMusic.artist}</span></div>
            <PresetShape params={null} />
            <div className="am-bibkv am-mono">
              <span>BPM <b>{analysis[previewMusic.url]?.bpm ?? '…'}</b></span>
              <span>KEY <b>{analysis[previewMusic.url]?.key ?? '--'}</b></span>
            </div>
            <div className="am-bibact">
              <button type="button" className="am-btn" onClick={(e) => openAudioActionMenu(musicToContent(previewMusic), e.currentTarget)} title="Aktionen öffnen">⋮</button>
              <button type="button" className="am-btn" onClick={() => audioEngine.previewSample('channel5', undefined, previewMusic.url)} title="Vorhören (Kanal 5)">LOAD</button>
              <button type="button" className="am-btn" onClick={() => { void handlePushMusic(previewMusic); }} disabled={cloudBusy} title="In externe Musik-Datenbank (Supabase) pushen">PUSH</button>
              <button type="button" className="am-btn am-pri" onClick={() => audioEngine.loadTrackSample('channel1', previewMusic.url)} title="In Mischpult-Kanal 1 laden">ADD</button>
            </div>
          </>
        ) : previewSample ? (
          <>
            <div className="am-bibname"><b>{previewSample.name}</b><span className="am-hint">{previewSample.type}</span></div>
            <PresetShape params={params} />
            {params ? (
              <div className="am-knobs">
                <AmKnob size="xs" disabled value={params.frequency ?? 0} min={20} max={12000} log unit="hz" label="Freq" title="Frequenz (Preset-Wert)" onChange={noop} />
                <AmKnob size="xs" disabled value={params.decay ?? 0} min={0} max={2} unit="ms" label="Decay" title="Decay (Preset-Wert)" onChange={noop} />
                <AmKnob size="xs" disabled value={params.pitchDecay ?? 0} min={0} max={0.5} unit="ms" label="P-Dec" title="Pitch-Decay (Preset-Wert)" onChange={noop} />
                <span className="am-vb" title="Oszillator">{params.oscillatorType ?? 'sine'}</span>
              </div>
            ) : (
              <span className="am-hint am-bibdesc">{previewSample.description}</span>
            )}
            <div className="am-bibact">
              <button type="button" className="am-btn" onClick={(e) => openAudioActionMenu(sampleToContent(previewSample, 'library'), e.currentTarget)} title="Aktionen öffnen">⋮</button>
              <button type="button" className="am-btn" onClick={() => handleCopy(previewSample)} title="Als JSON kopieren">COPY</button>
              <button type="button" className="am-btn" onClick={() => { void handlePushSample(previewSample); }} disabled={cloudBusy} title="In externe Sample-Datenbank (Supabase) pushen">PUSH</button>
              <button type="button" className="am-btn am-pri"
                onClick={() => { if (previewSample.url) audioEngine.loadTrackSample('channel5', previewSample.url); }}
                title={previewSample.url ? 'Sample in Mischpult-Kanal 5 laden' : 'Synthetisches Sample – über Instrumente spielbar'}
              >ADD</button>
            </div>
          </>
        ) : (
          <span className="am-hint">Eintrag in der Liste anklicken.</span>
        )}
      </AmCard>

      <AmCard
        title="Import · Cloud"
        className="am-bibimp"
        style={{ width: 270 }}
        right={<Scratchpad />}
      >
        <SampleUploadPanel />
        <QuickImportPanel />
        <div className="am-bibcloud">
          <CloudStatusBadge />
          <span className={`am-vb ${cloudEnabled ? 'am-on' : ''}`} title="Externe Sample-/Musik-Datenbank (Supabase, Lesen via anon-key)">
            CLOUD {cloudEnabled ? 'READ' : 'OFF'}
          </span>
          <button type="button" className="am-tg" onClick={() => { void handleCloudSync(); }} disabled={cloudBusy} title="Eingebaute Presets in die externe Datenbank syncen">SYNC</button>
        </div>
        {cloudStatus && <span className="am-hint am-mono am-bibst" title={cloudStatus}>{cloudStatus}</span>}
      </AmCard>
    </div>
  );
});
