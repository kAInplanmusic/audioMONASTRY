import React, { useCallback, useEffect, useState, type DragEvent } from 'react';
import { random } from '../utils/random';
import { Activity, Download, RefreshCw, Upload, X } from 'lucide-react';

type Metrics = {
  duration?: number;
  sampleRate?: number;
  channels?: number;
  peakDb?: number;
  rmsDb?: number;
  lufs?: number;
  true_peak?: number;
  lra?: number;
  crestFactorDb?: number;
  tracks?: number;
  normalizeLufs?: number | null;
  loudnessBefore?: { lufs?: number; true_peak?: number; lra?: number };
};

type MasterResponse = Metrics & { status?: string; data?: string; format?: string; message?: string };
type Mode = 'analyze' | 'master' | 'mix';
type LoadedFile = { name: string; size: number; b64: string; url: string };

const fmt = (v: number | undefined, digits = 1) =>
  v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits);

const fmtSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** LUFS-Farblogik: grün nah am Ziel, amber im Toleranzbereich, rot darüber hinaus. */
function lufsTone(lufs: number | undefined, target = -14): 'good' | 'warn' | 'bad' | 'neutral' {
  if (lufs === undefined || Number.isNaN(lufs)) return 'neutral';
  const d = Math.abs(lufs - target);
  if (d <= 1.5) return 'good';
  if (d <= 3) return 'warn';
  return 'bad';
}

const TONE_TEXT: Record<'good' | 'warn' | 'bad' | 'neutral', string> = {
  good: 'text-emerald-300',
  warn: 'text-amber-300',
  bad: 'text-red-300',
  neutral: 'text-neutral-200',
};

async function callMaster(path: string, payload: Record<string, unknown>): Promise<MasterResponse> {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await resp.json()) as MasterResponse;
  if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
  return data;
}

function readFileAsBase64(file: File): Promise<LoadedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result);
      const b64 = raw.includes(',') ? raw.split(',')[1] : raw;
      resolve({ name: file.name, size: file.size, b64, url: URL.createObjectURL(file) });
    };
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    reader.readAsDataURL(file);
  });
}

function FileSlot({ label, file, onFile, onClear }: {
  label: string;
  file: LoadedFile | null;
  onFile: (f: File) => void;
  onClear: () => void;
}) {
  const [id] = useState(() => `mp-file-${label.replace(/\W/g, '')}-${random().toString(36).slice(2, 8)}`);
  const [drag, setDrag] = useState(false);

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={handleDrop}
      className={`flex-1 min-w-0 rounded-xl border border-dashed transition-all duration-200 ${
        drag
          ? 'border-cyan-300 bg-cyan-400/10 shadow-[0_0_24px_-6px_var(--monk-glow-cyan)] scale-[1.01]'
          : 'border-neutral-700 bg-neutral-900/40'
      }`}
    >
      {file ? (
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-400 uppercase truncate">{label}</span>
            <button type="button"
              onClick={onClear}
              title={`${label} entfernen`}
              className="p-1 rounded-md text-neutral-500 hover:text-red-300 hover:bg-red-500/10 cursor-pointer transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <audio controls src={file.url} className="h-8 max-w-[220px]" preload="metadata" />
          </div>
          <div className="flex items-center justify-between gap-2 text-[9px] font-mono text-neutral-500">
            <span className="truncate">{file.name}</span>
            <span className="shrink-0 text-cyan-300/70">{fmtSize(file.size)}</span>
          </div>
          <p className="text-[8px] font-mono text-neutral-600 tracking-wide">Erneut hierher ziehen zum Ersetzen</p>
        </div>
      ) : (
        <label
          htmlFor={id}
          className="flex flex-col items-center justify-center gap-1.5 px-3 py-4 cursor-pointer hover:border-cyan-400/50 hover:bg-cyan-400/5 transition-colors text-center"
        >
          <Upload className={`w-4 h-4 ${drag ? 'text-cyan-300' : 'text-neutral-500'}`} />
          <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-400 uppercase">{label}</span>
          <span className="text-[9px] font-mono text-neutral-600">Audio hierher ziehen oder klicken</span>
          <span className="text-[8px] font-mono text-neutral-700">wav · mp3 · flac · ogg · max. 120 s</span>
        </label>
      )}
      <input
        id={id}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}

function Slider({ label, value, min, max, step, unit, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex-1 min-w-[90px] flex flex-col gap-1">
      <span className="flex items-center justify-between text-[9px] font-mono text-neutral-500 uppercase tracking-widest">
        {label}
        <span className="text-cyan-300">{value.toFixed(step < 1 ? 1 : 0)}{unit ?? ''}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1 accent-cyan-400 cursor-pointer"
      />
    </label>
  );
}

function Metric({ label, value, unit, tone }: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2 flex flex-col gap-0.5">
      <span className="text-[8px] font-mono text-neutral-500 uppercase tracking-[0.2em]">{label}</span>
      <span className={`font-mono text-sm font-bold ${TONE_TEXT[tone ?? 'neutral']}`}>
        {value}
        {unit && <span className="text-[9px] text-neutral-500 ml-1">{unit}</span>}
      </span>
    </div>
  );
}

const PROGRESS_STEPS = ['DECODE', 'FFmpeg-DSP', 'ENCODE'];

function ProgressBar({ busy }: { busy: boolean }) {
  const [idx, setIdx] = useState(0);
  // Reset bei Übergang von idle → busy (state during render statt setState im Effect).
  const [wasBusy, setWasBusy] = useState(busy);
  if (busy !== wasBusy) {
    setWasBusy(busy);
    if (busy) setIdx(0);
  }
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % PROGRESS_STEPS.length), 900);
    return () => clearInterval(t);
  }, [busy]);
  if (!busy) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-1 rounded-full bg-neutral-800 overflow-hidden">
        <div className="h-full w-1/3 rounded-full bg-cyan-400/80 animate-pulse" />
      </div>
      <span className="text-[9px] font-mono text-cyan-300/80 tracking-[0.3em] animate-pulse">
        {PROGRESS_STEPS[idx]} …
      </span>
    </div>
  );
}
export const MasterPlayerTerminal = React.memo(function MasterPlayerTerminal() { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
  const [mode, setMode] = useState<Mode>('analyze');
  const [trackA, setTrackA] = useState<LoadedFile | null>(null);
  const [trackB, setTrackB] = useState<LoadedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MasterResponse | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);

  // Mastering-Parameter
  const [eqLow, setEqLow] = useState(0);
  const [eqMid, setEqMid] = useState(0);
  const [eqHigh, setEqHigh] = useState(0);
  const [thresholdDb, setThresholdDb] = useState(-18);
  const [ceilingDb, setCeilingDb] = useState(-1);
  const [useLufs, setUseLufs] = useState(true);
  const [targetLufs, setTargetLufs] = useState(-14);

  // Mix-Parameter
  const [gainA, setGainA] = useState(-6);
  const [panA, setPanA] = useState(-0.5);
  const [gainB, setGainB] = useState(-6);
  const [panB, setPanB] = useState(0.5);

  const checkHealth = useCallback(async () => {
    setOnline(null);
    try {
      const resp = await fetch('/api/master/health');
      const data = await resp.json();
      setOnline(resp.ok && data?.status === 'ok');
    } catch {
      setOnline(false);
    }
  }, []);

  const revokeResultUrl = useCallback(() => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const revokeFileUrl = useCallback((f: LoadedFile | null) => {
    if (f) URL.revokeObjectURL(f.url);
  }, []);

  const clearA = useCallback(() => {
    setTrackA((prev) => { revokeFileUrl(prev); return null; });
    setResult(null);
    revokeResultUrl();
    setError(null);
  }, [revokeFileUrl, revokeResultUrl]);

  const clearB = useCallback(() => {
    setTrackB((prev) => { revokeFileUrl(prev); return null; });
    setResult(null);
    revokeResultUrl();
    setError(null);
  }, [revokeFileUrl, revokeResultUrl]);

  useEffect(() => {
    // Kein synchroner setState-Aufruf im Effect-Body: Health-Check asynchron starten.
    void (async () => {
      await Promise.resolve();
      await checkHealth();
    })();
    return () => {
      setTrackA((prev) => { revokeFileUrl(prev); return null; });
      setTrackB((prev) => { revokeFileUrl(prev); return null; });
      revokeResultUrl();
    };
  }, [checkHealth, revokeFileUrl, revokeResultUrl]);

  const onFileA = useCallback(async (f: File) => {
    if (!f.type.startsWith('audio') && !/\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f.name)) {
      setError('Bitte eine Audio-Datei wählen (wav/mp3/flac/ogg).');
      return;
    }
    try {
      setTrackA((prev) => { revokeFileUrl(prev); return null; });
      setTrackA(await readFileAsBase64(f));
      setResult(null);
      revokeResultUrl();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [revokeFileUrl, revokeResultUrl]);

  const onFileB = useCallback(async (f: File) => {
    if (!f.type.startsWith('audio') && !/\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f.name)) {
      setError('Bitte eine Audio-Datei wählen (wav/mp3/flac/ogg).');
      return;
    }
    try {
      setTrackB((prev) => { revokeFileUrl(prev); return null; });
      setTrackB(await readFileAsBase64(f));
      setResult(null);
      revokeResultUrl();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [revokeFileUrl, revokeResultUrl]);

  const finishWithAudio = (res: MasterResponse) => {
    revokeResultUrl();
    setResult(res);
    if (res.data) setAudioUrl(`data:audio/wav;base64,${res.data}`);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    revokeResultUrl();
    try {
      if (mode === 'analyze') {
        if (!trackA) throw new Error('Bitte zuerst eine Audiodatei laden.');
        const res = await callMaster('/api/master/analyze', { data: trackA.b64 });
        finishWithAudio({ ...res, data: undefined });
      } else if (mode === 'master') {
        if (!trackA) throw new Error('Bitte zuerst eine Audiodatei laden.');
        const res = await callMaster('/api/master/master', {
          data: trackA.b64,
          params: {
            eq: { low: eqLow, mid: eqMid, high: eqHigh },
            compressor: { threshold_db: thresholdDb, ratio: 4, attack_ms: 5, release_ms: 80, makeup_db: 0 },
            ceiling_db: ceilingDb,
            normalize_lufs: useLufs ? targetLufs : undefined,
          },
        });
        finishWithAudio(res);
      } else {
        if (!trackA || !trackB) throw new Error('Bitte zwei Audiodateien laden (Track A + Track B).');
        const res = await callMaster('/api/master/mix', {
          tracks: [
            { data: trackA.b64, gain: gainA, pan: panA },
            { data: trackB.b64, gain: gainB, pan: panB },
          ],
        });
        finishWithAudio(res);
      }
      // Nach erfolgreicher Verarbeitung Health-Status aktualisieren.
      checkHealth();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resetMasterParams = () => {
    setEqLow(0); setEqMid(0); setEqHigh(0);
    setThresholdDb(-18); setCeilingDb(-1);
    setUseLufs(true); setTargetLufs(-14);
  };

  const canRun = mode === 'mix' ? !!trackA && !!trackB : !!trackA;
  const runDisabled = busy || !canRun || online === false;

  return (
    <div className="rounded-xl border border-neutral-800 bg-black/40 p-4 short-landscape:p-2 flex flex-col gap-4 short-landscape:gap-2">
      {/* Kopfzeile */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <h4 className="text-[10px] font-bold tracking-[0.3em] text-neutral-400 uppercase">Master Engine</h4>
          <span className="px-2 py-0.5 rounded-full border border-cyan-400/30 bg-cyan-400/5 text-[8px] font-mono text-cyan-300 tracking-widest">
            NATIV · FFmpeg+NumPy
          </span>
        </div>
        <button type="button"
          onClick={checkHealth}
          title="Service-Status neu prüfen"
          className="flex items-center gap-1.5 text-[9px] font-mono tracking-widest cursor-pointer transition-colors"
        >
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${online === null ? 'bg-neutral-600' : online ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
          <span className={online === null ? 'text-neutral-500' : online ? 'text-emerald-400' : 'text-red-400'}>
            {online === null ? 'PRÜFE…' : online ? 'MASTER ONLINE' : 'MASTER OFFLINE'}
          </span>
          <RefreshCw className={`w-3 h-3 ml-1 text-neutral-500 ${online === null ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Modus-Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-neutral-900/70 border border-neutral-800 w-fit max-w-full" role="tablist" aria-label="Master Engine Modus">
        {([['analyze', 'Analyse', 'Lautheit & Metriken'], ['master', 'Mastering', 'EQ · Kompressor · LUFS'], ['mix', 'Mixdown', '2 Tracks mischen']] as [Mode, string, string][]).map(([m, label, hint]) => (
          <button type="button"
            key={m}
            role="tab"
            aria-selected={mode === m}
            title={hint}
            onClick={() => { setMode(m); setError(null); setResult(null); revokeResultUrl(); }}
            className={`px-3 py-1.5 rounded-md text-[9px] font-bold tracking-[0.2em] uppercase transition-all cursor-pointer ${
              mode === m ? 'bg-cyan-400/15 text-cyan-200 border border-cyan-400/40' : 'text-neutral-500 hover:text-neutral-300 border border-transparent'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Offline-Hinweis */}
      {online === false && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
          <span className="text-[10px] font-mono text-red-300">
            Master-Service nicht erreichbar – Verarbeitung deaktiviert. Läuft der <code className="text-red-200">master-player</code>-Container?
          </span>
          <button type="button" onClick={checkHealth} className="px-2.5 py-1 rounded-full border border-red-400/40 text-red-200 text-[9px] font-bold tracking-widest uppercase hover:bg-red-500/15 cursor-pointer">
            Neu prüfen
          </button>
        </div>
      )}

      {/* Datei-Slots */}
      <div className={`flex gap-3 ${mode === 'mix' ? 'flex-col sm:flex-row' : ''}`}>
        <FileSlot label={mode === 'mix' ? 'Track A' : 'Audio laden'} file={trackA} onFile={onFileA} onClear={clearA} />
        {mode === 'mix' && <FileSlot label="Track B" file={trackB} onFile={onFileB} onClear={clearB} />}
      </div>

      {/* Parameter */}
      {mode === 'master' && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Slider label="EQ Low" value={eqLow} min={-12} max={12} step={0.5} unit="dB" onChange={setEqLow} />
          <Slider label="EQ Mid" value={eqMid} min={-12} max={12} step={0.5} unit="dB" onChange={setEqMid} />
          <Slider label="EQ High" value={eqHigh} min={-12} max={12} step={0.5} unit="dB" onChange={setEqHigh} />
          <Slider label="Threshold" value={thresholdDb} min={-40} max={0} step={1} unit="dB" onChange={setThresholdDb} />
          <Slider label="Ceiling" value={ceilingDb} min={-6} max={0} step={0.5} unit="dB" onChange={setCeilingDb} />
          <div className="flex items-center gap-3 col-span-2 md:col-span-5 flex-wrap">
            <label className="flex items-center gap-2 text-[9px] font-mono text-neutral-400 uppercase tracking-widest cursor-pointer">
              <input type="checkbox" checked={useLufs} onChange={(e) => setUseLufs(e.target.checked)} className="accent-cyan-400" />
              LUFS-Normal
            </label>
            {useLufs && (
              <Slider label="Ziel-LUFS" value={targetLufs} min={-20} max={-8} step={0.5} unit=" LUFS" onChange={setTargetLufs} />
            )}
            <button type="button"
              onClick={resetMasterParams}
              className="px-2.5 py-1 rounded-full border border-neutral-700 text-neutral-400 text-[8px] font-bold tracking-widest uppercase hover:text-cyan-200 hover:border-cyan-400/50 cursor-pointer transition-colors"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {mode === 'mix' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 flex gap-3">
            <Slider label="Gain A" value={gainA} min={-24} max={6} step={0.5} unit="dB" onChange={setGainA} />
            <Slider label="Pan A" value={panA} min={-1} max={1} step={0.1} onChange={setPanA} />
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 flex gap-3">
            <Slider label="Gain B" value={gainB} min={-24} max={6} step={0.5} unit="dB" onChange={setGainB} />
            <Slider label="Pan B" value={panB} min={-1} max={1} step={0.1} onChange={setPanB} />
          </div>
        </div>
      )}

      {/* Action + Fortschritt */}
      <div className="flex flex-col gap-2">
        <button type="button"
          onClick={run}
          disabled={runDisabled}
          className="px-5 py-2.5 rounded-full bg-cyan-500/12 border border-cyan-500/50 text-cyan-200 text-xs font-bold tracking-widest uppercase hover:bg-cyan-500/25 hover:shadow-[0_0_20px_-6px_var(--monk-glow-teal)] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 w-full sm:w-fit"
        >
          {busy ? 'Verarbeite…' : mode === 'analyze' ? '▶ Analysieren' : mode === 'master' ? '▶ Mastering starten' : '▶ Mixdown erstellen'}
        </button>
        <ProgressBar busy={busy} />
        {!busy && !canRun && (
          <p className="text-[9px] font-mono text-neutral-600">
            {mode === 'mix' ? 'Lade Track A und Track B, um den Mixdown zu starten.' : 'Lade eine Audiodatei, um zu starten.'}
          </p>
        )}
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
          <span className="text-[10px] font-mono text-red-300">{error}</span>
          <button type="button" onClick={() => setError(null)} className="p-1 text-red-300/70 hover:text-red-200 cursor-pointer" title="Meldung schließen">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Ergebnis */}
      {result && (
        <div className="flex flex-col gap-3 animate-[mp-fade_0.3s_ease-out]">
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            <Metric label="Lautheit" value={fmt(result.lufs)} unit="LUFS" tone={lufsTone(result.lufs, mode === 'master' && useLufs ? targetLufs : -14)} />
            <Metric label="Peak" value={fmt(result.peakDb)} unit="dBFS" tone={result.peakDb !== undefined && result.peakDb > -0.5 ? 'warn' : 'neutral'} />
            <Metric label="RMS" value={fmt(result.rmsDb)} unit="dBFS" />
            <Metric label="True Peak" value={fmt(result.true_peak)} unit="dBTP" tone={result.true_peak !== undefined && result.true_peak > -1 ? 'warn' : 'neutral'} />
            <Metric label="LRA" value={fmt(result.lra)} unit="LU" />
            <Metric label="Dauer" value={fmt(result.duration, 1)} unit="s" />
          </div>

          {mode === 'master' && result.loudnessBefore?.lufs !== undefined && (
            <p className="text-[9px] font-mono text-neutral-500 tracking-wide">
              LUFS vorher: <span className="text-neutral-300">{fmt(result.loudnessBefore.lufs)} LUFS</span>
              {' → '}nachher: <span className={TONE_TEXT[lufsTone(result.lufs, targetLufs)]}>{fmt(result.lufs)} LUFS</span>
              {result.normalizeLufs != null && ` (Ziel: ${result.normalizeLufs} LUFS)`}
            </p>
          )}

          {audioUrl && (
            <div className="flex items-center gap-3 flex-wrap">
              <audio controls src={audioUrl} className="h-9 max-w-full" />
              <a
                href={audioUrl}
                download={mode === 'mix' ? 'samplemonk-mixdown.wav' : 'samplemonk-master.wav'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200 text-[9px] font-bold tracking-widest uppercase hover:bg-fuchsia-500/20 transition-colors"
              >
                <Download className="w-3 h-3" /> WAV speichern
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
