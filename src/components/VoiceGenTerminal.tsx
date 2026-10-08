import React, { useState, useRef, useEffect } from 'react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { useAudioAI } from '../hooks/useAudioAI';
import { PitchDetector } from '../utils/PitchDetector';
import { audioEngine } from '../utils/audioEngine';
import { useAudio } from '../context/AudioContext';
import { requestUserMedia } from '../utils/mediaDevices';
import { webRTCManager } from '../utils/WebRTCManager';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { MoaAssistant } from './MoaAssistant';
import { AmCard, AmSeg, AmToggle } from './am/amUi';

const STYLE_OPTIONS = [['SPOKEN', 'Spoken'], ['CHANT', 'Chant'], ['SINGING', 'Singing']] as const;

export const VoiceGenTerminal = React.memo(function VoiceGenTerminal({ enabled = true }: { enabled?: boolean }) {
  const { addSample } = useSamples();
  const { generateVoice } = useAudioAI();
  const { state, lockStatus, updateState } = usePluginState('voice', 'PRO');
  // Beständige Plugins: Einstiegsstand = letzter Prompt/Stil/Stimme/Modus.
  const [saved] = useState(() => mergeKnown({ prompt: 'Dark warehouse techno vocals saying "Are you ready to lose control"', style: 'SPOKEN', voice: 'FEMALE_ROBOTIC', ttsMode: 'AI' }, readPluginSettings('voice')));
  const [prompt, setPrompt] = useState(saved.prompt);

  const [style, setStyle] = useState(saved.style); // SPOKEN, CHANT, SINGING
  const [voice, setVoice] = useState(saved.voice);
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [ttsMode, setTtsMode] = useState<'AI' | 'SPEECH'>(saved.ttsMode === 'SPEECH' ? 'SPEECH' : 'AI');
  useEffect(() => {
    writePluginSettings('voice', { prompt, style, voice, ttsMode });
  }, [prompt, style, voice, ttsMode]);
  const [isRecordingMidi, setIsRecordingMidi] = useState(false);
  const midiIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const { audioContext } = useAudio();

  if (!enabled) {
    return (
        <div className="am-hint am-mono">Voice Generator Disabled</div>
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

  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  // Feste Balken je Text (kein Zufall im Render) für die Ergebnis-Anzeige.
  const bars = Array.from({ length: 28 }, (_, i) => 18 + ((prompt.charCodeAt(i % Math.max(1, prompt.length)) || 64) * (i + 7)) % 70);

  return (
    <div className="am-rackrow am-a-voice" style={locked ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="voice" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      <AmCard title="Lyrics / Prompt" style={{ flex: 1.3, minWidth: 360 }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          className="am-libq am-a-ta"
          aria-label="Lyrics / Prompt"
          placeholder="Enter text to synthesize..."
        />
        <div className="am-a-inline">
          <select className="am-sel" aria-label="Voice Model" value={voice} onChange={(e) => setVoice(e.target.value)}>
            {voices.map(v => <option key={v} value={v}>{v.replace('_', ' ')}</option>)}
          </select>
          <AmSeg label="Delivery Style" value={style} options={STYLE_OPTIONS} onChange={setStyle} />
          <AmToggle on={isRecordingMidi} onClick={() => void startRecordingForMIDI()} kind="m" title="Stimme aufnehmen und als MIDI auslösen">
            {isRecordingMidi ? 'STOP REC' : 'VOICE→MIDI'}
          </AmToggle>
          <button type="button" className="am-btn am-pri" onClick={generate} disabled={isGenerating}>
            {isGenerating ? 'SYNTHESIZING …' : 'GENERATE VOCAL'}
          </button>
        </div>
      </AmCard>

      <AmCard title="Take" style={{ width: 320 }} right={ttsMode === 'SPEECH' && hasResult ? <span className="am-vb am-a-ok">WEB SPEECH OFFLINE</span> : null}>
        <div className={`am-a-wave ${isGenerating ? 'am-a-busy' : ''}`} aria-label={isGenerating ? 'Running TTS Model' : hasResult ? 'Ergebnis' : 'Ready to synthesize'}>
          {hasResult || isGenerating
            ? bars.map((h, i) => <i key={i} style={{ height: `${h}%`, animationDelay: `${(i % 10) * 0.08}s` }} />)
            : <span className="am-hint">Ready to synthesize</span>}
        </div>
        <div className="am-a-inline">
          <button type="button" className="am-tg am-on" onClick={playResult} disabled={!hasResult} aria-label="Take abspielen">▶</button>
          <div className="am-a-ell">
            <b className="am-mono">vocal_take_01.wav</b>
            <div className="am-hint am-a-ell">{style} • {voice} · → biblioMONK</div>
          </div>
        </div>
      </AmCard>
    </div>
  );
});
