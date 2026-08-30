import React, { useCallback, useState } from 'react';
import { AudioLines, Sparkles } from 'lucide-react';
import { usePluginState } from '../hooks/usePluginState';
import { useSamples } from '../context/SampleContext';
import { MoaAssistant } from './MoaAssistant';
import { audioEngine } from '../utils/audioEngine';
import { generateRhythmicPattern } from '../utils/aiRhythmGenerator';
import { random } from '../utils/random';
import type { AudioSample } from '../data/samples';

type GeneratorKind = 'beat' | 'bass' | 'atmosphere' | 'oneshot';

const KIND_LABEL: Record<GeneratorKind, string> = {
  beat: 'BEAT / RHYTHMUS',
  bass: 'BASS-SOUND',
  atmosphere: 'ATMOSPHÄRE',
  oneshot: 'ONE-SHOT',
};

/**
 * soundMONK – KI-/Regel-basierte Klang-Generierung
 * ================================================
 * Erzeugt Beats, Bass-Sounds, Atmosphären und One-Shots. Beats werden direkt
 * in den Sequencer übernommen (`monk:apply-patterns`), alle anderen Ergebnisse
 * landen als AudioSample in der Session-Bibliothek (biblioMONK-Clipboard).
 */
export const SoundTerminal = React.memo(function SoundTerminal() {
  const { state, updateState } = usePluginState('sound', 'PRO');
  const { addSample } = useSamples();
  const [busy, setBusy] = useState<GeneratorKind | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-9), line]);
  }, []);

  const synthesizeSample = (kind: GeneratorKind): AudioSample => {
    const id = `sound-${kind}-${Date.now().toString(36)}-${random().toString(36).slice(2, 6)}`;
    const base: AudioSample = {
      id,
      name: `${KIND_LABEL[kind]} ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
      category: kind === 'bass' ? 'bass' : kind === 'atmosphere' ? 'highs' : 'mids',
      type: kind === 'bass' ? 'Bass' : kind === 'atmosphere' ? 'Pad' : 'Percussion',
      description: `soundMONK ${kind}-Generator`,
      tags: ['soundmonk', kind],
      parameters: {},
    };
    switch (kind) {
      case 'bass':
        base.parameters = { frequency: 40 + Math.round(random() * 80), decay: 0.3 + random() * 0.3, oscillatorType: 'sawtooth' };
        break;
      case 'atmosphere':
        base.parameters = { frequency: 110 + Math.round(random() * 220), decay: 1.2 + random() * 1.8, oscillatorType: 'sine' };
        break;
      case 'oneshot':
        base.parameters = { frequency: 400 + Math.round(random() * 1600), decay: 0.05 + random() * 0.2, oscillatorType: 'triangle' };
        break;
      default:
        break;
    }
    return base;
  };

  const generate = useCallback(async (kind: GeneratorKind) => {
    setBusy(kind);
    try {
      if (kind === 'beat') {
        const patterns = generateRhythmicPattern('techno');
        audioEngine.loadPatterns(patterns as unknown as Record<string, boolean[]>);
        audioEngine.setBpm(128);
        window.dispatchEvent(new CustomEvent('monk:apply-patterns', { detail: { patterns, bpm: 128 } }));
        pushLog(`✓ BEAT erzeugt: 16 Steps × 8 Spuren @ 128 BPM → Sequencer`);
      } else {
        const sample = synthesizeSample(kind);
        addSample(sample);
        // Sofortige Hörprobe (Parameter-basierte Synthese).
        audioEngine.previewSynthesizedSample(sample.parameters ?? {});
        pushLog(`✓ ${KIND_LABEL[kind]} erzeugt → biblioMONK (${sample.name})`);
      }
    } catch (e) {
      pushLog(`✗ ${KIND_LABEL[kind]}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [addSample, pushLog]);

  return (
    <div className="w-full h-full flex flex-col bg-[#111] rounded-xl border border-neutral-800 overflow-hidden text-neutral-300 font-sans">
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="sound" placeholder="MOA: z. B. 'Atmosphäre erzeugen'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-violet-900/20 to-[#111] border-b border-violet-900/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-violet-500/20 flex items-center justify-center border border-violet-500/50">
            <AudioLines className="w-5 h-5 text-violet-400" />
          </div>
          <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase">soundMONK</h2>
        </div>
        <select value={state} onChange={(e) => updateState(e.target.value as never)} className="bg-black text-white text-xs p-1 rounded">
          <option value="OFF">OFF</option>
          <option value="AUTO_AI">AI</option>
          <option value="PRO">ACTIVE</option>
        </select>
      </div>

      <div className="flex-1 p-6 overflow-y-auto space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {(['beat', 'bass', 'atmosphere', 'oneshot'] as GeneratorKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => generate(kind)}
              disabled={busy !== null}
              className="group flex flex-col items-center gap-3 p-6 rounded-xl border border-neutral-800 bg-[#161616] hover:border-violet-500/60 hover:bg-violet-950/20 transition-all disabled:opacity-40 disabled:cursor-wait"
            >
              <Sparkles className={`w-7 h-7 text-violet-400 group-hover:scale-110 transition-transform ${busy === kind ? 'animate-pulse' : ''}`} />
              <span className="text-sm font-black tracking-widest text-neutral-200">{KIND_LABEL[kind]}</span>
              <span className="text-[10px] font-mono text-neutral-500">
                {kind === 'beat' ? '→ Sequencer' : '→ biblioMONK'}
              </span>
            </button>
          ))}
        </div>

        <div className="bg-black/40 border border-neutral-800 rounded-xl p-4 min-h-[120px]">
          <h3 className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase mb-2">Generator-Log</h3>
          <div className="space-y-1 font-mono text-[11px]">
            {log.length === 0 && <div className="text-neutral-600">Noch keine Generierung – Button wählen.</div>}
            {log.map((line, i) => <div key={i} className={line.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}>{line}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
});
