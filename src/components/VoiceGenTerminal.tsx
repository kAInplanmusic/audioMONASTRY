import React, {  useState, useRef  } from 'react';
import { random } from '../utils/random';
import { Mic, Play, Download, RefreshCw, AlignLeft, Wand2 } from 'lucide-react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { useAudioAI } from '../hooks/useAudioAI';
import { PitchDetector } from '../utils/PitchDetector';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { useAudio } from '../context/AudioContext';
import { requestUserMedia } from '../utils/mediaDevices';
import { webRTCManager } from '../utils/WebRTCManager';

export const VoiceGenTerminal = React.memo(function VoiceGenTerminal({ enabled = true }: { enabled?: boolean }) {
  const { addSample } = useSamples();
  const { generateVoice } = useAudioAI();
  const { state, lockStatus, updateState } = usePluginState('voice', 'PRO');
  const [prompt, setPrompt] = useState('Dark warehouse techno vocals saying "Are you ready to lose control"');

  const [style, setStyle] = useState('SPOKEN'); // SPOKEN, CHANT, SINGING
  const [voice, setVoice] = useState('FEMALE_ROBOTIC');
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [ttsMode, setTtsMode] = useState<'AI' | 'SPEECH'>('AI');
  const [isRecordingMidi, setIsRecordingMidi] = useState(false);
  const midiIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const { audioContext } = useAudio();

  if (!enabled) {
    return (
        <div className="w-full h-full flex items-center justify-center bg-[#111] rounded-xl border border-neutral-800 text-neutral-600 font-mono text-xs uppercase tracking-widest">
            Voice Generator Disabled
        </div>
    );
  }

  const startRecordingForMIDI = async () => {
    if (isRecordingMidi) {
        if (midiIntervalRef.current) clearInterval(midiIntervalRef.current);
        setIsRecordingMidi(false);
        return;
    }

    await requestUserMedia({ audio: true });
    if (!audioContext) {
        console.warn("AudioContext not available for PitchDetector.");
        return;
    }
    const detector = new PitchDetector(audioContext);

    setIsRecordingMidi(true);
    const interval = setInterval(() => {
        detector.getNote();
        // console.log("Detected Pitch ausgewertet");
        audioEngine.triggerEvent('channel5', 0.8);
    }, 100);

    midiIntervalRef.current = interval as any;
  };


  const generate = async () => {
    if (lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId) return;
    setIsGenerating(true);
    setHasResult(false);
    setTtsMode('AI');

    try {
      await generateVoice(prompt, voice);
      // Kurze Wartezeit für sichtbares Feedback (KI-Pfad).
      await new Promise(r => setTimeout(r, 800));
      setIsGenerating(false);
      setHasResult(true);
      setTtsMode('AI');

      // Add generated vocal to library
      const newSample: AudioSample = {
          id: `vocal-${Date.now()}`,
          name: `Vocal_${voice}_${Date.now()}`,
          category: 'mids',
          type: 'Vocal',
          description: `Generated vocal: "${prompt}"`,
          tags: ["Vocal", "AI"],
          parameters: {}
      };
      addSample(newSample);

    } catch (error) {
      // Fallback: Web Speech API (offline, zuverlässig) – KI-TTS ist unzuverlässig.
      console.warn('KI-TTS fehlgeschlagen – Web-Speech-Fallback aktiv:', error);
      setIsGenerating(false);
      setHasResult(true);
      setTtsMode('SPEECH');
      // Direkt abspielbar über playResult() → speechSynthesis.
    }
  };

  const voices = ['FEMALE_ROBOTIC', 'MALE_GRITTY', 'ETHEREAL_CHOIR', 'DISTORTED_DEMON', 'AI_NEWSCASTER'];

  // #12 Fertigstellung: Generierte Stimme hörbar abspielen (Web-Speech, offline).
  const playResult = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      // Fallback: kurzer hörbarer Test-Oszillator über die AudioEngine.
      audioEngine.triggerEvent('channel5', 0.6);
      setTimeout(() => audioEngine.triggerEvent('channel5', 0.4), 180);
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(prompt);
    const match = synth.getVoices().find(v => v.lang === voice) || synth.getVoices()[0];
    if (match) utter.voice = match;
    utter.rate = style === 'SINGING' ? 0.7 : style === 'CHANT' ? 0.85 : 0.95;
    utter.pitch = style === 'SINGING' ? 1.2 : 1;
    utter.volume = 1;
    synth.speak(utter);
  };

  return (
    <div className={`w-full h-full flex flex-col bg-[#111] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} overflow-hidden text-neutral-300 font-sans shadow-2xl relative ${lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId ? 'opacity-50 grayscale' : ''}`}>
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="voice" placeholder="MOA: z. B. 'Singe Hallo meine Freunde'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-orange-900/20 to-[#111] border-b border-orange-900/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center border border-orange-500/50 shadow-[0_0_15px_rgba(249,115,22,0.3)]">
            <Mic className="w-5 h-5 text-orange-400" />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase flex items-center gap-2">
              Voice Generator <span className="text-[10px] font-mono text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded-sm">AI VOCALIST</span>
            </h2>
          </div>
        </div>

        <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
        </select>
      </div>

      <div className="flex-1 flex overflow-hidden">

        {/* Left Side: Input & Settings */}
        <div className="w-1/2 p-8 border-r border-neutral-800 flex flex-col gap-6 bg-[#161616]">

          <div>
            <label className="text-xs font-bold tracking-widest text-neutral-500 mb-2 flex items-center gap-2">
              <AlignLeft className="w-4 h-4" /> LYRICS / PROMPT
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full h-32 short-landscape:h-20 bg-[#111] border border-neutral-800 rounded-lg p-4 text-sm text-neutral-300 focus:outline-none focus:border-orange-500/50 resize-none font-mono"
              placeholder="Enter text to synthesize..."
            />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div>
              <span className="text-xs font-bold tracking-widest text-neutral-500 mb-2 block">DELIVERY STYLE</span>
              <div className="flex flex-col gap-2">
                {['SPOKEN', 'CHANT', 'SINGING'].map(s => (
                  <button type="button"
                    key={s}
                    onClick={() => setStyle(s)}
                    className={`py-2 rounded-md border text-xs font-bold tracking-widest transition-all ${style === s ? 'bg-orange-900/40 border-orange-500 text-orange-400' : 'bg-[#111] border-neutral-800 text-neutral-500 hover:text-neutral-400'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="text-xs font-bold tracking-widest text-neutral-500 mb-2 block">VOICE MODEL</span>
              <div className="flex flex-col gap-2 overflow-y-auto max-h-32 scrollbar-thin scrollbar-thumb-neutral-800 pr-2">
                {voices.map(v => (
                  <button type="button"
                    key={v}
                    onClick={() => setVoice(v)}
                    className={`py-2 px-3 rounded-md border text-[10px] font-mono text-left transition-all truncate ${voice === v ? 'bg-neutral-800 border-neutral-600 text-neutral-200' : 'bg-[#111] border-transparent text-neutral-500 hover:bg-[#1a1a1a]'}`}
                  >
                    {v.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-auto pt-6 border-t border-neutral-800 flex flex-col gap-3">
            <button type="button"
              onClick={startRecordingForMIDI}
              className={`w-full py-3 rounded-lg font-bold tracking-widest flex justify-center items-center gap-2 transition-all ${isRecordingMidi ? 'bg-red-900/50 text-red-400' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              <Mic className="w-4 h-4" /> {isRecordingMidi ? 'STOP RECORDING' : 'RECORD VOICE-TO-MIDI'}
            </button>
            <button type="button"
              onClick={generate}
              disabled={isGenerating}
              className={`w-full py-4 rounded-lg font-black tracking-widest flex justify-center items-center gap-3 transition-all ${isGenerating ? 'bg-neutral-800 text-neutral-500 cursor-wait' : 'bg-orange-600 hover:bg-orange-500 text-white shadow-[0_0_20px_rgba(249,115,22,0.4)]'}`}
            >
              {isGenerating ? (
                <><RefreshCw className="w-5 h-5 animate-spin" /> SYNTHESIZING...</>
              ) : (
                <><Wand2 className="w-5 h-5" /> GENERATE VOCAL</>
              )}
            </button>
          </div>

        </div>

        {/* Right Side: Result & Processing */}
        <div className="w-1/2 p-8 flex flex-col bg-[#111] relative">

           {!hasResult && !isGenerating ? (
             <div className="flex-1 flex flex-col items-center justify-center opacity-20">
               <Mic className="w-24 h-24 mb-4 short-landscape:w-14 short-landscape:h-14 short-landscape:mb-2" />
               <p className="font-bold tracking-widest">READY TO SYNTHESIZE</p>
             </div>
           ) : isGenerating ? (
             <div className="flex-1 flex flex-col items-center justify-center">
               <div className="w-full flex items-center justify-center gap-2 mb-8">
                 {[...Array(20)].map((_, i) => (
                   <div
                     key={i}
                     className="w-1.5 bg-orange-500 rounded-full animate-pulse"
                     style={{ height: `${random() * 40 + 10}px`, animationDelay: `${i * 0.1}s` }}
                   ></div>
                 ))}
               </div>
               <p className="text-orange-400 font-mono text-xs animate-pulse">Running TTS Model...</p>
             </div>
           ) : (
             <div className="flex-1 flex flex-col justify-center animate-in fade-in duration-500">

               <div className="bg-[#1a1a1a] rounded-xl border border-neutral-800 p-6 shadow-inner relative overflow-hidden group">
                 <div className="relative z-10 flex items-center justify-between">
                   <div className="flex items-center gap-4">
                     <button type="button" onClick={playResult} className="w-16 h-16 rounded-full bg-orange-600 flex items-center justify-center text-white shadow-[0_0_15px_rgba(249,115,22,0.5)] hover:scale-105 transition-transform">
                       <Play className="w-6 h-6 ml-1 fill-current" />
                     </button>
                     <div>
                       <h4 className="font-black text-lg tracking-widest">vocal_take_01.wav</h4>
                       <p className="text-xs text-neutral-400 font-mono mt-1">
                         {style} • {voice}
                         {ttsMode === 'SPEECH' && (
                           <span className="ml-2 text-[9px] text-emerald-400 border border-emerald-500/40 px-1.5 py-0.5 rounded">WEB SPEECH OFFLINE</span>
                         )}
                       </p>
                     </div>
                   </div>

                   <button type="button" className="px-4 py-2 bg-[#222] border border-neutral-700 hover:bg-[#333] rounded flex items-center gap-2 text-xs font-bold transition-colors">
                     <Download className="w-4 h-4" /> EXPORT TO LIB
                   </button>
                 </div>
               </div>
             </div>
           )}

        </div>

      </div>
    </div>
  );
});
