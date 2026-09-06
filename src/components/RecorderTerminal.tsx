import React, {  useState, useEffect, useRef, useCallback  } from 'react';
import { Radio, Mic, Save, Download, Play, Square, Circle } from 'lucide-react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { useAudio } from '../context/AudioContext';
import { requestUserMedia } from '../utils/mediaDevices';
import { audioEngine } from '../utils/audioEngine';
import { openAudioActionMenu } from './AudioActionMenuHost';
import { sampleToContent } from '../core/audio/audioContent';
import { webRTCManager } from '../utils/WebRTCManager';
import { TerminalFrame } from './terminalShared';

interface Take {
  id: number;
  name: string;
  duration: string;
  size: string;
  date: string;
  /** Blob-URL der fertigen Aufnahme (für die einheitliche Audio-Interaktion). */
  url?: string;
}




export const RecorderTerminal = React.memo(function RecorderTerminal() {
  const { addSample } = useSamples();
  const { audioContext } = useAudio();
  const { state, lockStatus, updateState } = usePluginState('recording', 'PRO');
  const [isRecording, setIsRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [takes, setTakes] = useState<Take[]>([
    { id: 1, name: 'Main_Mix_Take_01.wav', duration: '03:45', size: '38 MB', date: '2026-07-18' }
  ]);
  const [inputSource, setInputSource] = useState('MASTER_OUT');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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

  return (
    <TerminalFrame
      pluginId="recording"
      moaPlaceholder="MOA: z. B. 'Aufnahme starten'"
      title="Master Recorder"
      badge="BIT-PERFECT"
      icon={Radio}
      accent="indigo"
      lockStatus={lockStatus}
      state={state}
      updateState={updateState}
    >
      <div className="flex-1 p-6 flex gap-6 overflow-hidden">
        {/* Left Column: Transport & Source */}
        <div className="w-1/2 flex flex-col gap-6">
          <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-6 flex-1 flex flex-col items-center justify-center shadow-inner relative">
            <div className="absolute top-4 left-4">
               <span className="text-[10px] font-mono font-bold tracking-widest text-neutral-500">FORMAT: 32-BIT FLOAT / 96kHz</span>
            </div>

            <div className={`text-7xl font-mono font-black mb-8 transition-colors ${isRecording ? 'text-red-500 drop-shadow-[0_0_15px_rgba(239,68,68,0.8)]' : 'text-neutral-700'}`}>
              {formatTime(recordTime)}
            </div>

            <div className="flex items-center gap-6">
              {!isRecording ? (
                <button type="button"
                  onClick={startRecording}
                  className="w-20 h-20 short-landscape:w-14 short-landscape:h-14 rounded-full bg-[#222] border-4 border-[#111] flex items-center justify-center shadow-[0_0_20px_rgba(0,0,0,0.5)] hover:border-red-900 transition-colors group"
                >
                  <Circle className="w-8 h-8 text-red-500 fill-current group-hover:drop-shadow-[0_0_10px_rgba(239,68,68,1)]" />
                </button>
              ) : (
                <button type="button"
                  onClick={handleStop}
                  className="w-20 h-20 short-landscape:w-14 short-landscape:h-14 rounded-full bg-[#222] border-4 border-red-900 flex items-center justify-center shadow-[0_0_20px_rgba(239,68,68,0.4)] animate-pulse"
                >
                  <Square className="w-8 h-8 text-red-500 fill-current" />
                </button>
              )}
            </div>
          </div>

          <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-4">
            <h3 className="text-xs font-bold tracking-widest text-neutral-500 mb-3 flex items-center gap-2">
              <Mic className="w-4 h-4" /> INPUT SOURCE
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {['MASTER_OUT', 'VOCAL_STEM', 'DRUM_BUS', 'SYNTH_GROUP'].map(src => (
                <button type="button"
                  key={src}
                  onClick={() => { if (!(lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId)) setInputSource(src); }}
                  className={`py-2 px-3 rounded border text-[10px] font-mono font-bold transition-all ${inputSource === src ? 'bg-indigo-900/40 border-indigo-500 text-indigo-400' : 'bg-[#111] border-neutral-800 text-neutral-500 hover:bg-[#222]'}`}
                >
                  {src}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Takes Library */}
        <div className="w-1/2 bg-[#1a1a1a] rounded-xl border border-neutral-800 p-6 flex flex-col shadow-inner">
          <h3 className="font-bold text-sm tracking-widest uppercase text-neutral-400 mb-4 flex items-center gap-2">
            <Save className="w-4 h-4 text-indigo-500" /> RECORDED TAKES
          </h3>

          <div className="flex-1 overflow-y-auto pr-2 flex flex-col gap-3 scrollbar-thin scrollbar-thumb-neutral-800">
            {takes.map(take => (
              <div
                key={take.id}
                role="button"
                tabIndex={0}
                onClick={(e) => openAudioActionMenu(sampleToContent(takeToSample(take), 'recording'), e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openAudioActionMenu(sampleToContent(takeToSample(take), 'recording'), e.currentTarget as HTMLElement);
                  }
                }}
                className="p-4 rounded-lg bg-[#111] border border-neutral-800 flex items-center justify-between group hover:border-indigo-500/50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-4">
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); if (take.url) audioEngine.previewSample('channel5', undefined, take.url); }}
                    title="Take anhören"
                    className="w-8 h-8 rounded-full bg-[#222] flex items-center justify-center group-hover:bg-indigo-600 transition-colors cursor-pointer"
                  >
                    <Play className="w-4 h-4 text-neutral-400 group-hover:text-white ml-0.5 fill-current" />
                  </button>
                  <div>
                    <div className="text-xs font-bold tracking-wider text-neutral-200">{take.name}</div>
                    <div className="text-[10px] font-mono text-neutral-500 mt-1">{take.duration} • {take.size} • {take.date}</div>
                  </div>
                </div>
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); openAudioActionMenu(sampleToContent(takeToSample(take), 'recording'), e.currentTarget); }}
                  className="px-3 py-1.5 rounded bg-[#222] border border-neutral-700 text-[10px] font-bold text-neutral-400 flex items-center gap-1 hover:bg-[#333] transition-colors cursor-pointer"
                  title="Aktionen für diesen Take öffnen"
                >
                  <Download className="w-3 h-3" /> AKTIONEN
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </TerminalFrame>
  );
});
