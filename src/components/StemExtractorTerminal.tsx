/**
 * stemMONK · Rack-Modul (Vorlage public/uidesign/uiübersichtapp.jpg, Zeile 11)
 * ==========================================================================
 * Eine Zeile: links Quelle/Track + Trenn-Anbieter, Mitte fünf farbige
 * Stem-Spuren (Fortschritt/Ergebnis als Balken), rechts Separate/Play-All und
 * Pegel. Logik (Server → ONNX → DSP, Routing in den Mixer, Bibliothek) wie bisher.
 */
import React, { useState, useRef, useEffect } from 'react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { useAudioAI } from '../hooks/useAudioAI';
import { routeStemToMixer, resolveStemChannel } from '../utils/StemRouter';
import { audioEngine } from '../utils/audioEngine';
import { useMainLevel } from '../core/audio/mainLevel';
import { AmCard, AmMeter } from './am/amUi';
import type { TrackType } from '../types';
import { splitStemsLocally, LocalStemUrls } from '../utils/stemSplitter';
import { separateStemsWithDemucs } from '../ai/localDemucs';
import { MoaAssistant } from './MoaAssistant';
import { loadStemUsage, recordStemExtraction, formatUsd, type StemProvider } from '../utils/stemUsage';
import { webRTCManager } from '../utils/WebRTCManager';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';

/** Fünf Stem-Spuren nach Spezifikation (#11) – Farbe je Spur. */
const STEM_LANES: { key: string; label: string; color: string }[] = [
  { key: 'vocals', label: 'Gesang', color: '#f472b6' },
  { key: 'lows', label: 'Bass', color: '#f97316' },
  { key: 'mids', label: 'Mitten', color: '#facc15' },
  { key: 'highs', label: 'Höhen', color: '#22d3ee' },
  { key: 'melody', label: 'Melodie', color: '#a78bfa' },
];
/** HTDemucs (4 Stems) – eigene Beschriftung, gleiche Spur-Ansicht. */
const DEMUCS_LANES: { key: string; label: string; color: string }[] = [
  { key: 'vocals', label: 'Gesang', color: '#f472b6' },
  { key: 'bass', label: 'Bass', color: '#f97316' },
  { key: 'drums', label: 'Drums', color: '#facc15' },
  { key: 'other', label: 'Rest', color: '#a78bfa' },
];
const SEGMENTS = 40;

const StemMeters = React.memo(function StemMeters() {
  const main = useMainLevel();
  return (
    <div className="am-stmvm" aria-label="Main-Pegel">
      <AmMeter level={main.level} peak={main.peak} />
      <AmMeter level={main.level} peak={main.peak} />
    </div>
  );
});

export const StemExtractorTerminal = React.memo(function StemExtractorTerminal() {
  const { addSample } = useSamples();
  const { streamStems } = useAudioAI();
  const { state, lockStatus, updateState } = usePluginState('stem', 'PRO');
  const [isExtracting, setIsExtracting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState(loadStemUsage);
  // Beständige Plugins: gewählter Trenn-Anbieter bleibt für den nächsten Halter.
  const [providerChoice, setProviderChoice] = useState<'auto' | 'local' | 'api'>(() => {
    const v = mergeKnown({ providerChoice: 'auto' }, readPluginSettings('stem')).providerChoice;
    return v === 'local' || v === 'api' ? v : 'auto';
  });
  useEffect(() => {
    writePluginSettings('stem', { providerChoice });
  }, [providerChoice]);
  const [stemStatus, setStemStatus] = useState<{ provider: string; serverActive: boolean; estimateUsdPerSong: number } | null>(null);
  /** Ergebnis der letzten Trennung (nur Anzeige: welche Spur liegt auf welchem Kanal). */
  const [result, setResult] = useState<{ demucs: boolean; channels: Record<string, TrackType> } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Stem-Provider-Status vom Server (eigener stem-ai-Dienst aktiv?).
  useEffect(() => {
    fetch('/api/stem/status')
      .then((r) => r.json())
      .then((d) => setStemStatus(d))
      .catch(() => { /* Server nicht erreichbar – lokaler Modus */ });
  }, []);

  // MOA-Kommando: Dateiauswahl öffnen.
  useEffect(() => {
    const openPicker = () => fileInputRef.current?.click();
    window.addEventListener('monk:stem-pick-file', openPicker);
    return () => window.removeEventListener('monk:stem-pick-file', openPicker);
  }, []);

  const ALLOWED_AUDIO_TYPES = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/ogg', 'audio/aiff'];
  const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      // Validate file type
      if (selected.type && !ALLOWED_AUDIO_TYPES.includes(selected.type)) {
        setError(`Unsupported file type: ${selected.type}. Please upload WAV, MP3, FLAC, OGG, or AIFF.`);
        return;
      }
      // Validate file size
      if (selected.size > MAX_FILE_SIZE) {
        setError(`File too large (${(selected.size / 1024 / 1024).toFixed(0)} MB). Maximum is 500 MB.`);
        return;
      }
      setFile(selected);
      setError(null);
    }
  };

  const cancelExtraction = () => {
    abortRef.current?.abort();
    setIsExtracting(false);
    setProgress(0);
  };

  const startExtraction = async () => { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    if (!file || (lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId)) return;

    abortRef.current = new AbortController();
    setIsExtracting(true);
    setProgress(0);
    setError(null);
    setResult(null);

    let stems: LocalStemUrls | null = null;
    let realStems: { drums: string; bass: string; other: string; vocals: string } | null = null;
    let usedProvider: StemProvider = 'fallback';

    // Provider-Priorität (RT-AUDIT-P1-014: nur eigene Wege, keine Cloud):
    //  - 'api' (UI: SERVER): eigener stem-ai-Dienst der Flotte zuerst, lokal als Fallback
    //  - 'auto': Server zuerst (wenn aktiv), sonst lokal
    //  - 'local': NUR lokal (ONNX → DSP)
    // Der gespeicherte Wert heißt aus Kompatibilität weiter 'api'.
    const apiFirst = providerChoice === 'api' || (providerChoice === 'auto' && !!stemStatus?.serverActive);

    const tryServer = async (): Promise<boolean> => {
      try {
        const stream = streamStems(file);
        let finalData: { stems?: Partial<LocalStemUrls>; provider?: string } | null = null;
        for await (const update of stream) {
          if (typeof update === 'number') setProgress(update);
          else finalData = update;
        }
        if (finalData?.provider === 'stem-ai' || finalData?.provider === 'fallback') {
          usedProvider = finalData.provider;
        }
        if (finalData?.stems && Object.values(finalData.stems).some((u) => typeof u === 'string' && u.length > 0)) {
          stems = finalData.stems as LocalStemUrls;
          return true;
        }
      } catch (e) {
        console.warn('Server-Stem-Pfad nicht verfügbar – Fallback übernimmt.', e);
      }
      return false;
    };

    const tryLocal = async (): Promise<boolean> => {
      try {
        realStems = await separateStemsWithDemucs(file, (p) => setProgress(p));
        if (realStems) {
          usedProvider = 'local';
          return true;
        }
      } catch (e) {
        console.warn('Demucs-ONNX nicht verfügbar – DSP-Notfall übernimmt.', e);
      }
      return false;
    };

    if (apiFirst) {
      await tryServer();
      if (!stems && providerChoice !== 'api') await tryLocal();
      if (!stems && providerChoice === 'api') await tryLocal(); // Server gewählt, aber nicht erreichbar → lokal retten
    } else {
      await tryLocal();
      if (!stems && providerChoice !== 'local') await tryServer();
    }

    // 3) DSP-Notfall (nur wenn weder Modell noch Server Stems geliefert haben).
    if (!realStems && !stems) {
      try {
        stems = await splitStemsLocally(file, (p) => setProgress(p));
      } catch (err: any) {
        setError(err.message || 'Stem-Extraktion fehlgeschlagen.');
        setIsExtracting(false);
        setProgress(0);
        return;
      }
    }

    setIsExtracting(false);
    setProgress(100);
    setUsage(recordStemExtraction(usedProvider));

    if (realStems) {
      const realMap: Record<string, string> = {
        vocals: realStems.vocals,
        drums: realStems.drums,
        bass: realStems.bass,
        other: realStems.other,
      };
      const realChannels: Record<string, TrackType> = {};
      (['vocals', 'drums', 'bass', 'other'] as const).forEach((stem) => {
        const url = realMap[stem];
        routeStemToMixer(stem, url);
        realChannels[stem] = resolveStemChannel(stem);
        addSample({
          id: `stem-${Date.now()}-${stem}`,
          name: `${file!.name.split('.')[0]}_${stem}`,
          category: stem === 'bass' ? 'bass' : 'mids',
          type: 'Stem',
          description: `HTDemucs v4 stem: ${stem} (${file!.name})`,
          url,
          parameters: {},
        });
      });
      setResult({ demucs: true, channels: realChannels });
      return;
    }

    const stemUrls: Record<string, string> = {
      vocals: stems!.vocals,
      melody: stems!.melody,
      highs: stems!.highs,
      mids: stems!.mids,
      lows: stems!.lows,
    };

    const channels: Record<string, TrackType> = {};
    (['vocals', 'melody', 'highs', 'mids', 'lows'] as const).forEach((stem) => {
      const url = stemUrls[stem];
      routeStemToMixer(stem, url);
      channels[stem] = resolveStemChannel(stem);
      const newSample: AudioSample = {
        id: `stem-${Date.now()}-${stem}`,
        name: `${file!.name.split('.')[0]}_${stem}`,
        category: stem === 'lows' ? 'bass' : stem === 'highs' ? 'highs' : 'mids',
        type: 'Stem',
        description: `Extracted stem from ${file!.name}`,
        url,
        parameters: {},
      };
      addSample(newSample);
    });
    setResult({ demucs: false, channels });
  };

  /** Play-All: die in den Mixer gerouteten Stems gemeinsam anspielen (vorhandener Vorhör-Pfad). */
  const playAll = () => {
    if (!result) return;
    new Set(Object.values(result.channels)).forEach((ch) => audioEngine.previewSample(ch));
  };

  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  const lanes = result?.demucs ? DEMUCS_LANES : STEM_LANES;
  const lit = result ? SEGMENTS : isExtracting ? Math.round((progress / 100) * SEGMENTS) : 0;

  return (
    <div className="am-rackrow am-stm" style={locked ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="stem" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      <AmCard title="Quelle" style={{ width: 250 }}>
        <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" />
        <button type="button" onClick={() => fileInputRef.current?.click()} className="am-drop am-stmfile" title="Audio-Datei wählen (WAV, MP3, FLAC, OGG, AIFF)">
          {file ? file.name : 'Drop Audio File to Extract'}
        </button>
        <div className="am-seg" role="tablist" aria-label="Stem-Provider">
          {([['auto', 'AUTO'], ['local', 'LOKAL'], ['api', 'SERVER']] as const).map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={providerChoice === v}
              className={providerChoice === v ? 'am-on' : ''}
              onClick={() => setProviderChoice(v)}
              title={v === 'api' ? 'Eigener stem-ai-Dienst der Flotte' : v === 'local' ? 'Lokale ONNX-Extraktion' : 'Automatisch: Server zuerst (wenn aktiv), lokal als Fallback'}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="am-hint">
          {stemStatus ? (stemStatus.serverActive ? 'Server bereit' : 'Server aus (lokal aktiv)') : '…'}
        </span>
        <span className="am-hint am-mono" title="Geschätzte Cloud-Kosten (lokal = 0)">
          Stem-Zähler: {usage.count} · {usage.lastProvider ? `${usage.lastProvider.toUpperCase()} · ` : ''}≈ {formatUsd(usage.estimatedCostUsd)}
        </span>
      </AmCard>

      <AmCard title="Stems" style={{ flex: 1, minWidth: 380 }}
        right={<span className="am-vb">{result ? (result.demucs ? 'HTDemucs · 4' : '5 Stems') : isExtracting ? `${progress}%` : 'bereit'}</span>}>
        <div className="am-lanes am-stmlanes">
          {lanes.map((l) => (
            <div className="am-lane" key={l.key} style={{ ['--lc' as string]: l.color }}>
              <span className="am-lt" style={{ color: l.color }}>{l.label}</span>
              <div className="am-lb" role="img" aria-label={`${l.label}: ${result ? 'getrennt' : isExtracting ? `${progress} %` : 'leer'}`}>
                {Array.from({ length: SEGMENTS }, (_, k) => (
                  <i key={k} style={{ flex: 1, ['--o' as string]: k < lit ? 0.85 : 0.12 }} />
                ))}
              </div>
              <span className="am-mono am-stmch">{result?.channels[l.key]?.replace('channel', 'K') ?? '–'}</span>
            </div>
          ))}
        </div>
        {error && (
          <div className="am-stmerr">
            <span>Error: {error}</span>
            <button type="button" className="am-tg" onClick={startExtraction}>Retry</button>
          </div>
        )}
      </AmCard>

      <AmCard title="Trennen" style={{ width: 210 }}>
        <button type="button"
          className={`am-btn ${isExtracting ? '' : 'am-pri'}`}
          disabled={!file && !isExtracting}
          onClick={isExtracting ? cancelExtraction : startExtraction}
        >
          {isExtracting ? `Extracting ${progress}%... (Click to Cancel)` : 'Run Extraction'}
        </button>
        <button type="button" className="am-btn" disabled={!result || isExtracting} onClick={playAll} title="Alle gerouteten Stems im Mixer anspielen">
          ▶ PLAY ALL
        </button>
        <span className="am-hint">Ergebnis: Mixer-Kanäle + Bibliothek</span>
      </AmCard>

      <AmCard className="am-pegel">
        <StemMeters />
      </AmCard>
    </div>
  );
});
