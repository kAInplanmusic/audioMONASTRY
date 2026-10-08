/**
 * recordMONK · Rack-Modul (Vorlage public/uidesign/uiübersichtapp.jpg, Zeile 16)
 * ==========================================================================
 * Eine Zeile: Eingang · Aufnahmeknopf + Zeit · laufende Wellenform · Takes ·
 * Format/Export (Bounce durch die Kette) · Pegel. Aufnahme-/Bounce-Logik wie bisher.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { useAudio } from '../context/AudioContext';
import { requestUserMedia } from '../utils/mediaDevices';
import { audioEngine } from '../utils/audioEngine';
import { openAudioActionMenu } from './AudioActionMenuHost';
import { sampleToContent } from '../core/audio/audioContent';
import { webRTCManager } from '../utils/WebRTCManager';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { MoaAssistant } from './MoaAssistant';
import { AmCard, AmMeter } from './am/amUi';
import { useMainLevel } from '../core/audio/mainLevel';
import { bounceThroughPluginChain } from '../audio/pluginChainBounce';
import { encodeWavFromChannels } from '../utils/wavEncode';

interface Take {
  id: number;
  name: string;
  duration: string;
  size: string;
  date: string;
  /** Blob-URL der fertigen Aufnahme (für die einheitliche Audio-Interaktion). */
  url?: string;
}

const INPUT_SOURCES = ['MASTER_OUT', 'VOCAL_STEM', 'DRUM_BUS', 'SYNTH_GROUP'] as const;

/** Format, das MediaRecorder hier tatsächlich verwendet (gleiche Reihenfolge wie beim Start). */
function detectRecordFormat(): string {
  try {
    if (typeof MediaRecorder === 'undefined') return 'nicht verfügbar';
    const t = ['audio/wav', 'audio/webm;codecs=pcm', 'audio/webm;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
    if (t === 'audio/wav') return 'WAV';
    if (t === 'audio/webm;codecs=pcm') return 'WebM · PCM';
    if (t === 'audio/webm;codecs=opus') return 'WebM · Opus';
    return 'Browser-Standard';
  } catch {
    return 'Browser-Standard';
  }
}

const RecMeters = React.memo(function RecMeters() {
  const main = useMainLevel();
  return (
    <div className="am-recvm" aria-label="Main-Pegel">
      <AmMeter level={main.level} peak={main.peak} />
      <AmMeter level={main.level} peak={main.peak} />
    </div>
  );
});

/**
 * Laufende Wellenform des Main-Ausgangs (Spitzenwert je UI-Takt, ~60 ms) –
 * liest den gemeinsamen Main-Pegel-Abgriff, berührt den Audio-Pfad nicht.
 */
const RecScope = React.memo(function RecScope({ recording }: { recording: boolean }) {
  const main = useMainLevel();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const hist = useRef<number[]>([]);
  const color = useRef<string | null>(null);
  useEffect(() => {
    const h = hist.current;
    h.push(main.raw);
    if (h.length > 400) h.shift();
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 300;
    const ht = cv.clientHeight || 70;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(ht * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(ht * dpr);
    }
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, ht);
    const mid = ht / 2;
    g.fillStyle = 'rgba(110,140,200,.25)';
    g.fillRect(0, mid, w, 1);
    color.current ??= getComputedStyle(cv).getPropertyValue('--c').trim() || '#4cc9f0';
    g.fillStyle = recording ? '#ff4d4d' : color.current;
    const n = Math.min(h.length, Math.floor(w / 2));
    for (let i = 0; i < n; i++) {
      const v = h[h.length - n + i];
      const a = Math.max(1, v * (mid - 2));
      g.fillRect(w - (n - i) * 2, mid - a, 1.5, a * 2);
    }
  }, [main, recording]);
  return <canvas ref={ref} className="am-cv am-recscope" aria-label="Wellenform des Main-Ausgangs" />;
});

export const RecorderTerminal = React.memo(function RecorderTerminal() {
  const { addSample } = useSamples();
  const { audioContext } = useAudio();
  const { state, lockStatus, updateState } = usePluginState('record', 'PRO');
  const [isRecording, setIsRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [takes, setTakes] = useState<Take[]>([
    { id: 1, name: 'Main_Mix_Take_01.wav', duration: '03:45', size: '38 MB', date: '2026-07-18' }
  ]);
  // Beständige Plugins: gewählte Aufnahmequelle bleibt für den nächsten Halter
  // (Aufnahmen selbst sind Audiodaten und gehen in die Bibliothek).
  const [inputSource, setInputSource] = useState(() => mergeKnown({ inputSource: 'MASTER_OUT' }, readPluginSettings('record')).inputSource);
  useEffect(() => {
    writePluginSettings('record', { inputSource });
  }, [inputSource]);
  const [bounceBusy, setBounceBusy] = useState(false);
  const [bounceInfo, setBounceInfo] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordFormat = useMemo(detectRecordFormat, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isRecording) {
      interval = setInterval(() => setRecordTime(prev => prev + 1), 1000);
    } else {
      setRecordTime(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  /** Take → AudioSample-Hülle (referenziert nur die vorhandene Blob-URL). */
  const takeToSample = (take: Take): AudioSample => ({
    id: `take-${take.id}`,
    name: take.name,
    category: 'mids',
    type: 'Recording',
    url: take.url,
    description: `Aufnahme vom ${take.date} · ${take.duration}`,
    parameters: {},
  });

  const startRecording = useCallback(async () => {
    if (lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId) return;

    try {
      let stream: MediaStream;

      if (audioContext && inputSource === 'MASTER_OUT') {
        // Record from the master audio output via AudioContext
        const dest = audioContext.createMediaStreamDestination();
        // Connect the audio context destination to a MediaStreamDestination
        // This captures the master output
        stream = dest.stream;
      } else {
        // Fallback: record from microphone input
        stream = await requestUserMedia({ audio: true });
      }

            // Task 13: Bevorzugung eines verlustfreien Formats, falls verfügbar.
      const preferred = ['audio/wav', 'audio/webm;codecs=pcm', 'audio/webm;codecs=opus']
        .find(t => MediaRecorder.isTypeSupported(t)) ?? '';
      const recorder = new MediaRecorder(stream, { mimeType: preferred });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);

        const newTake: Take = {
          id: Date.now(),
          name: `${inputSource}_Take_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`,
          duration: formatTime(recordTime),
          size: `${sizeMB} MB`,
          date: new Date().toISOString().split('T')[0],
          url,
        };
        setTakes(prev => [newTake, ...prev]);

        const newSample: AudioSample = {
          id: `rec-${Date.now()}`,
          name: newTake.name,
          category: 'mids',
          type: 'Recording',
          url,
          description: `Master recording from ${inputSource}`,
          parameters: {}
        };
        addSample(newSample);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(100); // Collect data every 100ms
      setIsRecording(true);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
// eslint-disable-next-line react-hooks/exhaustive-deps -- bewusst beibehalten (Runde 3, Hook-Deps werden separat auditiert)
  }, [audioContext, inputSource, lockStatus, takes.length, recordTime, addSample]);

  const handleStop = useCallback(() => {
    if (isRecording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  /**
   * Bounce durch die Signalkette: Das auf Kanal 1 geladene Lied läuft offline
   * durch die 16 Adapter in Kettenreihenfolge (Quellen → Mixer → Nachbearbeitung
   * → Recorder → Ausgang) und kommt als WAV in die Takes. Damit ist die Kette
   * hörbar, bevor sie im Live-Pfad hängt – und der Live-Umzug ist danach ein
   * Umzug derselben Ordnung, kein Blindflug.
   */
  const bounceThroughChain = useCallback(async () => {
    if (bounceBusy) return;
    const url = audioEngine.getTrackSampleUrl('channel1');
    if (!url) {
      setBounceInfo('Kein Lied auf Kanal 1 – erst im Mixer laden.');
      return;
    }
    setBounceBusy(true);
    setBounceInfo('Bounce läuft …');
    try {
      const channels = await audioEngine.getMusicSampleChannels(url);
      if (!channels || channels.length === 0) {
        setBounceInfo('Quelle nicht lesbar.');
        return;
      }
      const result = await bounceThroughPluginChain(channels, {
        sampleRate: audioContext?.sampleRate ?? 48000,
      });
      const blob = encodeWavFromChannels(result.output, result.sampleRate);
      const newTake: Take = {
        id: Date.now(),
        name: `Chain_Bounce_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`,
        duration: formatTime(Math.round(result.durationSeconds)),
        size: `${(blob.size / (1024 * 1024)).toFixed(1)} MB`,
        date: new Date().toISOString().split('T')[0],
        url: URL.createObjectURL(blob),
      };
      setTakes(prev => [newTake, ...prev]);
      setBounceInfo(`Fertig: ${result.renderedFrames} Frames durch ${result.order.length} Plugins.`);
    } catch (e) {
      setBounceInfo(`Bounce fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      setBounceBusy(false);
    }
  }, [audioContext, bounceBusy]);

  // MOA-Kommandos: Aufnahme starten/stoppen.
  useEffect(() => {
    const onStart = () => { void startRecording(); };
    const onStop = () => handleStop();
    window.addEventListener('monk:recorder-start', onStart);
    window.addEventListener('monk:recorder-stop', onStop);
    return () => {
      window.removeEventListener('monk:recorder-start', onStart);
      window.removeEventListener('monk:recorder-stop', onStop);
    };
  }, [startRecording, handleStop]);

  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;

  return (
    <div className="am-rackrow am-rec" style={locked ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="recording" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      <AmCard title="Eingang" style={{ width: 170 }}>
        <select
          className="am-sel"
          aria-label="Aufnahmequelle"
          value={inputSource}
          disabled={locked}
          onChange={(e) => { if (!locked) setInputSource(e.target.value); }}
        >
          {INPUT_SOURCES.map((src) => <option key={src} value={src}>{src}</option>)}
        </select>
        <span className="am-hint">{inputSource === 'MASTER_OUT' ? 'Main-Ausgang' : 'Mikrofon/Line-Eingang'}</span>
      </AmCard>

      <AmCard title="Aufnahme" style={{ width: 176 }}>
        <div className="am-recrow">
          <button type="button"
            className={`am-recb ${isRecording ? 'am-on' : ''}`}
            onClick={isRecording ? handleStop : () => { void startRecording(); }}
            disabled={locked && !isRecording}
            aria-label={isRecording ? 'Aufnahme stoppen' : 'Aufnahme starten'}
            title={isRecording ? 'Aufnahme stoppen' : 'Aufnahme starten'}
          ><i /></button>
          <div>
            <div className={`am-big ${isRecording ? 'am-recl' : ''}`}>{formatTime(recordTime)}</div>
            <span className="am-hint">{isRecording ? '● REC' : 'bereit'}</span>
          </div>
        </div>
      </AmCard>

      <AmCard title="Wellenform" style={{ flex: 1, minWidth: 240 }}>
        <RecScope recording={isRecording} />
      </AmCard>

      <AmCard title="Takes" style={{ width: 300 }} right={<span className="am-vb">{takes.length}</span>}>
        <div className="am-recl-list">
          {takes.map((take) => (
            <div
              key={take.id}
              role="button"
              tabIndex={0}
              className="am-rectk"
              onClick={(e) => openAudioActionMenu(sampleToContent(takeToSample(take), 'recording'), e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openAudioActionMenu(sampleToContent(takeToSample(take), 'recording'), e.currentTarget as HTMLElement);
                }
              }}
            >
              <button type="button" className="am-tg"
                onClick={(e) => { e.stopPropagation(); if (take.url) audioEngine.previewSample('channel5', undefined, take.url); }}
                title="Take anhören" aria-label={`Take anhören: ${take.name}`} disabled={!take.url}
              >▶</button>
              <span className="am-rectn"><b>{take.name}</b><em className="am-mono">{take.duration} · {take.size} · {take.date}</em></span>
              <button type="button" className="am-tg"
                onClick={(e) => { e.stopPropagation(); openAudioActionMenu(sampleToContent(takeToSample(take), 'recording'), e.currentTarget); }}
                title="Aktionen für diesen Take öffnen (Export, Bibliothek, Kanal)" aria-label={`Aktionen: ${take.name}`}
              >⋮</button>
            </div>
          ))}
        </div>
      </AmCard>

      <AmCard title="Format · Export" style={{ width: 220 }}>
        <span className="am-recfmt">
          <span className="am-lbl">Aufnahme</span><span className="am-vb">{recordFormat}</span>
        </span>
        <span className="am-recfmt">
          <span className="am-lbl">Bounce</span><span className="am-vb">WAV · {Math.round((audioContext?.sampleRate ?? 48000) / 100) / 10} kHz</span>
        </span>
        <button
          type="button"
          className="am-btn am-pri"
          onClick={() => { void bounceThroughChain(); }}
          disabled={bounceBusy}
          title="Kanal 1 offline durch die 16 Plugins in Kettenreihenfolge rendern (Quellen → Mixer → Nachbearbeitung → Recorder → Ausgang)"
        >
          {bounceBusy ? 'BOUNCE LÄUFT …' : 'BOUNCE DURCH DIE KETTE'}
        </button>
        <span className="am-hint">{bounceInfo ?? 'Quelle: Kanal 1 des Mixers.'}</span>
      </AmCard>

      <AmCard className="am-pegel">
        <RecMeters />
      </AmCard>
    </div>
  );
});
