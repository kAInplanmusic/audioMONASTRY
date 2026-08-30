import React, { useState, useRef, useEffect } from 'react';
import { Radio } from 'lucide-react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { useAudioAI } from '../hooks/useAudioAI';
import { routeStemToMixer } from '../utils/StemRouter';
import { splitStemsLocally, LocalStemUrls } from '../utils/stemSplitter';
import { separateStemsWithDemucs } from '../ai/localDemucs';
import { MoaAssistant } from './MoaAssistant';

export function StemExtractorTerminal() {
  const { addSample } = useSamples();
  const { streamStems } = useAudioAI();
  const { state, lockStatus, updateState } = usePluginState('stem_extractor', 'PRO');
  const [isExtracting, setIsExtracting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    if (!file || (lockStatus.active && lockStatus.lockedBy !== 'localUser')) return;

    abortRef.current = new AbortController();
    setIsExtracting(true);
    setProgress(0);
    setError(null);

    let stems: LocalStemUrls | null = null;
    let realStems: { drums: string; bass: string; other: string; vocals: string } | null = null;

    // 1) ECHTES HTDemucs-ONNX-Modell (100% Inferenz, WebGPU/WASM).
    try {
      realStems = await separateStemsWithDemucs(file, (p) => setProgress(p));
    } catch (e) {
      console.warn('Demucs-ONNX nicht verfügbar – DSP-Notfall übernimmt.', e);
    }

    if (!realStems) {
      // 2) Server-/stem-ai-Pfad.
      try {
        const stream = streamStems(file);
        let finalData: { stems?: Partial<LocalStemUrls> } | null = null;
        for await (const update of stream) {
          if (typeof update === 'number') {
            setProgress(update);
          } else {
            finalData = update;
          }
        }
        if (finalData?.stems && Object.values(finalData.stems).some((u) => typeof u === 'string' && u.length > 0)) {
          stems = finalData.stems as LocalStemUrls;
        }
      } catch (e) {
        console.warn('Server-Stem-Pfad nicht verfügbar – DSP-Notfall übernimmt.', e);
      }
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

    if (realStems) {
      const realMap: Record<string, string> = {
        vocals: realStems.vocals,
        drums: realStems.drums,
        bass: realStems.bass,
        other: realStems.other,
      };
      (['vocals', 'drums', 'bass', 'other'] as const).forEach((stem) => {
        const url = realMap[stem];
        routeStemToMixer(stem, url);
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
      return;
    }

    const stemUrls: Record<string, string> = {
      vocals: stems!.vocals,
      melody: stems!.melody,
      highs: stems!.highs,
      mids: stems!.mids,
      lows: stems!.lows,
    };

    (['vocals', 'melody', 'highs', 'mids', 'lows'] as const).forEach((stem) => {
      const url = stemUrls[stem];
      routeStemToMixer(stem, url);
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
  };

  return (
    <div className={`p-6 bg-[#161616] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} text-neutral-300 font-mono shadow-2xl ${lockStatus.active && lockStatus.lockedBy !== 'localUser' ? 'opacity-50 grayscale' : ''}`}>
      <div className="mb-4 -mt-2">
        <MoaAssistant pluginId="stem" placeholder="MOA: z. B. 'Datei trennen'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-sm font-black uppercase tracking-widest text-neutral-400 flex items-center gap-2">
            <Radio className="w-4 h-4 text-red-400" /> STEM MONK
        </h3>
        <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
        </select>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-900/20 border border-red-500 text-red-400 text-xs rounded flex justify-between items-center">
            <span>Error: {error}</span>
            <button type="button" onClick={startExtraction} className="text-red-300 font-bold underline text-[10px]">Retry</button>
        </div>
      )}

      <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" />
      <button type="button" onClick={() => fileInputRef.current?.click()} className="w-full bg-[#111] border border-dashed border-neutral-700 p-4 rounded-lg mb-4 text-xs font-bold uppercase tracking-widest hover:border-red-500 transition-colors">
        {file ? file.name : "Drop Audio File to Extract"}
      </button>

      <button type="button"
        disabled={!file && !isExtracting}
        onClick={isExtracting ? cancelExtraction : startExtraction}
        className={`w-full py-3 rounded text-sm font-black uppercase tracking-widest ${isExtracting ? 'bg-neutral-800 text-neutral-500' : !file ? 'bg-neutral-800 text-neutral-600 cursor-not-allowed' : 'bg-red-600 hover:bg-red-500'}`}
      >
        {isExtracting ? `Extracting ${progress}%... (Click to Cancel)` : "Run Extraction"}
      </button>
    </div>
  );
}
