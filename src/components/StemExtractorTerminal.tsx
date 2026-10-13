/**
 * stemMONK · Rack-Modul (Vorlage public/uidesign/uiübersichtapp.jpg, Zeile 11)
 * ==========================================================================
 * Eine Zeile: links Quelle/Track + Trenn-Anbieter, Mitte fünf farbige
 * Stem-Spuren (Fortschritt/Ergebnis als Balken), rechts Separate/Play-All und
 * Pegel.
 *
 * FLEET-P1-006 – Trennwege (kein stiller Schein-Fallback):
 *  - RP5   Server → stems-Pod, bs-roformer-sw-6stem, 5 echte Stems, Warp auf
 *          Projekt-BPM (und optional Ziel-Tonart). Stems liegen auf dem Server
 *          (URLs) und stehen danach in der Bibliothek.
 *  - 4-STEM  ausdrücklich: stem-ai (htdemucs), Gesang/Bass/Drums/Rest.
 *  - AUTO  RP5; meldet der Server einen Fehler, wird er angezeigt und nur die
 *          lokale ONNX-Trennung (4 Stems, gekennzeichnet) versucht.
 *  - LOKAL ONNX (4 Stems), danach DSP-Notfall – als Frequenzbänder gekennzeichnet,
 *          keine KI-Trennung.
 */
import React, { useState, useRef, useEffect } from 'react';
import { useSamples } from '../context/SampleContext';
import { usePluginState } from '../hooks/usePluginState';
import { useAudioAI, type StemServerResult } from '../hooks/useAudioAI';
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
import { FIVE_STEMS, fiveStemLibraryEntries, type FiveStemKey } from '../plugins/adapters/StemPluginAdapter';

/** Fünf Stem-Spuren nach Spezifikation (#11, Reihenfolge/Label aus dem Adapter) – Farbe je Spur. */
const STEM_COLORS: Record<FiveStemKey, string> = {
  vocals: '#f472b6',
  lows: '#f97316',
  mids: '#facc15',
  highs: '#22d3ee',
  melody: '#a78bfa',
};
const STEM_LANES: { key: string; label: string; color: string }[] = FIVE_STEMS.map((s) => ({
  key: s.key,
  label: s.label,
  color: STEM_COLORS[s.key],
}));
/** HTDemucs (4 Stems) – eigene Beschriftung, gleiche Spur-Ansicht. */
const DEMUCS_LANES: { key: string; label: string; color: string }[] = [
  { key: 'vocals', label: 'Gesang', color: '#f472b6' },
  { key: 'bass', label: 'Bass', color: '#f97316' },
  { key: 'drums', label: 'Drums', color: '#facc15' },
  { key: 'other', label: 'Rest', color: '#a78bfa' },
];
const SEGMENTS = 40;

type ProviderChoice = 'auto' | 'rp5' | '4stem' | 'local';
const PROVIDER_CHOICES: ReadonlyArray<readonly [ProviderChoice, string, string]> = [
  ['auto', 'AUTO', 'RP5 (5 Stems); bei Server-Fehler lokal 4 Stems – der Fehler bleibt sichtbar'],
  ['rp5', 'RP5', 'Nur stems-Pod: BS-RoFormer SW, 5 echte Stems'],
  ['4stem', '4-STEM', 'Ausdrücklich 4-Stem-Modus (stem-ai/htdemucs): Gesang, Bass, Drums, Rest'],
  ['local', 'LOKAL', 'Im Browser: ONNX (4 Stems), sonst DSP-Notfall (Frequenzbänder)'],
];
/** Ziel-Tonarten für den Key-Warp ('' = Tonart bleibt). */
const TARGET_KEYS: readonly string[] = ['', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
  'Cm', 'C#m', 'Dm', 'D#m', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'A#m', 'Bm'];

/** Was die letzte Trennung geliefert hat (nur Anzeige). */
interface StemRunResult {
  kind: '5stem' | '4stem' | 'dsp';
  channels: Record<string, TrackType>;
  melodyAvailable?: boolean;
  notes: string[];
  model?: string;
}

function resultBadge(r: StemRunResult): string {
  if (r.kind === 'dsp') return 'DSP-Notfall · keine KI';
  if (r.kind === '4stem') return `4-Stem-Modus${r.model ? ` · ${r.model}` : ''}`;
  return r.melodyAvailable === false ? '5 Stems · Melodie leer (Fallback)' : `5 Stems${r.model ? ` · ${r.model}` : ''}`;
}

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
  // Beständige Plugins: gewählter Trennweg + Warp bleiben für den nächsten Halter.
  // Alt-Wert 'api' (früher SERVER = stem-ai) heißt jetzt RP5.
  const [saved] = useState(() => mergeKnown({ providerChoice: 'auto', warp: true, targetKey: '' }, readPluginSettings('stem')));
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>(() => {
    const v = saved.providerChoice;
    if (v === 'api') return 'rp5';
    return v === 'local' || v === 'rp5' || v === '4stem' ? v : 'auto';
  });
  const [warpOn, setWarpOn] = useState<boolean>(() => saved.warp !== false);
  const [targetKey, setTargetKey] = useState<string>(() => (typeof saved.targetKey === 'string' && TARGET_KEYS.includes(saved.targetKey) ? saved.targetKey : ''));
  useEffect(() => {
    writePluginSettings('stem', { providerChoice, warp: warpOn, targetKey });
  }, [providerChoice, warpOn, targetKey]);
  const [stemStatus, setStemStatus] = useState<{ provider: string; serverActive: boolean; rp5Active?: boolean; fourStemActive?: boolean; model?: string | null; estimateUsdPerSong: number } | null>(null);
  /** Ergebnis der letzten Trennung (Anzeige: Art, Spuren, Kanäle, Hinweise). */
  const [result, setResult] = useState<StemRunResult | null>(null);
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
    const sourceName = file.name;
    const stamp = Date.now();

    const finish = (run: StemRunResult, provider: StemProvider) => {
      setIsExtracting(false);
      setProgress(100);
      setUsage(recordStemExtraction(provider));
      setResult(run);
    };
    const fail = (message: string) => {
      setError(message);
      setIsExtracting(false);
      setProgress(0);
    };

    /** Routing + Bibliothek für eine Server-Antwort (URLs; Bibliothek hat der Server schon geschrieben). */
    const applyServer = (data: StemServerResult): StemRunResult => {
      const five = data.mode !== '4stem';
      const channels: Record<string, TrackType> = {};
      const entries = data.library?.length
        ? data.library
        : five
          ? fiveStemLibraryEntries(sourceName, { stems: data.stems ?? {}, melodyAvailable: data.melodyAvailable }).map((e) => ({ ...e, id: `stem-${stamp}-${e.key}` }))
          : [];
      Object.entries(data.stems ?? {}).forEach(([key, url]) => {
        if (!url || (five && key === 'melody' && data.melodyAvailable === false)) return;
        routeStemToMixer(key, url);
        channels[key] = resolveStemChannel(key);
      });
      // Server-URLs: addSample lädt NICHT erneut hoch (nur blob:-URLs würden hochgeladen).
      entries.forEach((e) => addSample({ id: e.id, name: e.name, category: e.category, type: 'Stem', description: e.description, url: e.url, tags: e.tags, parameters: {} }));
      const notes = [...(data.notes ?? [])];
      if (data.fallbackReason) notes.unshift(data.fallbackReason);
      if (data.warp?.applied) {
        const w = data.warp;
        notes.push(`Warp: ${w.sourceBpm ?? '?'} → ${w.targetBpm ?? '–'} BPM${w.semitones ? `, ${w.semitones > 0 ? '+' : ''}${w.semitones} HT (${w.sourceKey} → ${w.targetKey})` : ''}`);
      }
      return { kind: five ? '5stem' : '4stem', channels, melodyAvailable: five ? data.melodyAvailable : false, notes, model: data.model };
    };

    /** Lokale ONNX-Trennung (4 Stems, im Browser). */
    const runLocalOnnx = async (): Promise<StemRunResult | null> => {
      try {
        const real = await separateStemsWithDemucs(file, (p) => setProgress(p));
        if (!real) return null;
        const channels: Record<string, TrackType> = {};
        (['vocals', 'drums', 'bass', 'other'] as const).forEach((stem) => {
          routeStemToMixer(stem, real[stem]);
          channels[stem] = resolveStemChannel(stem);
          addSample({
            id: `stem-${stamp}-${stem}`,
            name: `${sourceName.split('.')[0]}_${stem}`,
            category: stem === 'bass' ? 'bass' : 'mids',
            type: 'Stem',
            description: `HTDemucs (lokal, 4 Stems): ${stem} (${sourceName})`,
            url: real[stem],
            parameters: {},
          });
        });
        return { kind: '4stem', channels, melodyAvailable: false, notes: ['Lokal (ONNX, 4 Stems) – kein Warp.'], model: 'htdemucs (lokal)' };
      } catch (e) {
        console.warn('Demucs-ONNX nicht verfügbar.', e);
        return null;
      }
    };

    if (providerChoice !== 'local') {
      const stream = streamStems(file, {
        mode: providerChoice === 'rp5' ? '5stem' : providerChoice === '4stem' ? '4stem' : 'auto',
        targetBpm: warpOn ? audioEngine.getBpm() : undefined,
        targetKey: warpOn && targetKey ? targetKey : undefined,
        signal: abortRef.current.signal,
      });
      let data: StemServerResult;
      while (true) {
        const step = await stream.next();
        if (step.done) { data = step.value; break; }
        if (typeof step.value === 'number') setProgress(step.value);
      }
      if (data.code === 'CANCELLED') return;
      if (data.status === 'success' && !data.simulated && data.stems && Object.values(data.stems).some(Boolean)) {
        finish(applyServer(data), data.provider === 'rp5' ? 'rp5' : 'stem-ai');
        return;
      }
      const serverError = data.simulated
        ? 'Server liefert nur den simulierten Stub (STEM_AI_PROVIDER=fallback) – keine Stems.'
        : `${data.message ?? 'Stem-Trennung fehlgeschlagen.'}${data.hint ? ` ${data.hint}` : ''}`;
      if (providerChoice !== 'auto') { fail(serverError); return; }
      // AUTO: Server-Fehler sichtbar lassen, nur die echte lokale 4-Stem-Trennung versuchen.
      const local = await runLocalOnnx();
      if (local) {
        finish({ ...local, notes: [`Server: ${serverError}`, ...local.notes] }, 'local');
        return;
      }
      fail(serverError);
      return;
    }

    // LOKAL: ONNX, danach DSP-Notfall (Frequenzbänder, ausdrücklich gekennzeichnet).
    const local = await runLocalOnnx();
    if (local) { finish(local, 'local'); return; }
    let bands: LocalStemUrls;
    try {
      bands = await splitStemsLocally(file, (p) => setProgress(p));
    } catch (err) {
      fail((err as Error).message || 'Stem-Extraktion fehlgeschlagen.');
      return;
    }
    const channels: Record<string, TrackType> = {};
    fiveStemLibraryEntries(sourceName, { stems: bands }).forEach((entry) => {
      routeStemToMixer(entry.key, entry.url);
      channels[entry.key] = resolveStemChannel(entry.key);
      addSample({
        id: `stem-${stamp}-${entry.key}`,
        name: `${entry.name}_dsp`,
        category: entry.category,
        type: 'Stem',
        description: `DSP-Notfall (Frequenzbänder, keine KI-Trennung): ${entry.key} aus ${sourceName}`,
        url: entry.url,
        parameters: {},
      });
    });
    finish({ kind: 'dsp', channels, notes: ['DSP-Notfall: Frequenzbänder, KEINE KI-Trennung.'] }, 'fallback');
  };

  /** Play-All: die in den Mixer gerouteten Stems gemeinsam anspielen (vorhandener Vorhör-Pfad). */
  const playAll = () => {
    if (!result) return;
    new Set(Object.values(result.channels)).forEach((ch) => audioEngine.previewSample(ch));
  };

  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  const lanes = result?.kind === '4stem' ? DEMUCS_LANES : STEM_LANES;
  const lit = result ? SEGMENTS : isExtracting ? Math.round((progress / 100) * SEGMENTS) : 0;

  return (
    <div className="am-rackrow am-stm" style={locked ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="stem" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      <AmCard title="Quelle" style={{ width: 250 }}>
        <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" />
        <button type="button" onClick={() => fileInputRef.current?.click()} className="am-drop am-stmfile" title="Audio-Datei wählen (WAV, MP3, FLAC, OGG, AIFF)">
          {file ? file.name : 'Drop Audio File to Extract'}
        </button>
        <div className="am-seg" role="tablist" aria-label="Trennweg">
          {PROVIDER_CHOICES.map(([v, label, title]) => (
            <button key={v} type="button" role="tab" aria-selected={providerChoice === v}
              className={providerChoice === v ? 'am-on' : ''}
              onClick={() => setProviderChoice(v)}
              title={title}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="am-seg" aria-label="Warp auf das Projekt">
          <button type="button" className={warpOn ? 'am-on' : ''} aria-pressed={warpOn} onClick={() => setWarpOn((w) => !w)}
            title="Stems auf Projekt-BPM dehnen (WSOLA, gemeinsamer Plan – Stems bleiben deckungsgleich)">
            WARP {warpOn ? `${Math.round(audioEngine.getBpm())} BPM` : 'AUS'}
          </button>
          <select aria-label="Ziel-Tonart" value={targetKey} disabled={!warpOn} onChange={(e) => setTargetKey(e.target.value)}
            title="Ziel-Tonart (Pitch-Shift, max. ±6 Halbtöne); leer = Tonart bleibt">
            {TARGET_KEYS.map((k) => <option key={k || 'orig'} value={k}>{k || 'Key: Original'}</option>)}
          </select>
        </div>
        <span className="am-hint">
          {stemStatus
            ? stemStatus.rp5Active
              ? `RP5 bereit (${stemStatus.model ?? 'bs-roformer-sw-6stem'})`
              : stemStatus.fourStemActive
                ? 'RP5 aus · nur 4-Stem-Modus'
                : 'Server aus (lokal aktiv)'
            : '…'}
        </span>
        <span className="am-hint am-mono" title="Geschätzte Cloud-Kosten (lokal = 0)">
          Stem-Zähler: {usage.count} · {usage.lastProvider ? `${usage.lastProvider.toUpperCase()} · ` : ''}≈ {formatUsd(usage.estimatedCostUsd)}
        </span>
      </AmCard>

      <AmCard title="Stems" style={{ flex: 1, minWidth: 380 }}
        right={<span className="am-vb">{result ? resultBadge(result) : isExtracting ? (progress > 0 ? `${progress}%` : 'läuft …') : 'bereit'}</span>}>
        <div className="am-lanes am-stmlanes">
          {lanes.map((l) => (
            <div className="am-lane" key={l.key} style={{ ['--lc' as string]: l.color }}>
              <span className="am-lt" style={{ color: l.color }}>{l.label}</span>
              <div className="am-lb" role="img" aria-label={`${l.label}: ${result ? 'getrennt' : isExtracting ? `${progress} %` : 'leer'}`}>
                {Array.from({ length: SEGMENTS }, (_, k) => (
                  <i key={k} style={{ flex: 1, ['--o' as string]: k < lit ? 0.85 : 0.12 }} />
                ))}
              </div>
              <span className="am-mono am-stmch" title={l.key === 'melody' && result?.melodyAvailable === false ? 'Fallback-Modell trennt keine Melodie – melodische Anteile liegen in Mids/Highs' : undefined}>
                {l.key === 'melody' && result?.melodyAvailable === false ? 'leer' : result?.channels[l.key]?.replace('channel', 'K') ?? '–'}
              </span>
            </div>
          ))}
        </div>
        {result && result.notes.length > 0 && (
          <div className="am-hint" role="status">{result.notes.join(' · ')}</div>
        )}
        {error && (
          <div className="am-stmerr" role="alert">
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
