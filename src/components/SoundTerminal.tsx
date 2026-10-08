import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePluginState } from '../hooks/usePluginState';
import { useSamples } from '../context/SampleContext';
import { MoaAssistant } from './MoaAssistant';
import { audioEngine } from '../utils/audioEngine';
import { generateRhythmicPattern } from '../utils/aiRhythmGenerator';
import { random } from '../utils/random';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { webRTCManager } from '../utils/WebRTCManager';
import type { AudioSample } from '../data/samples';
import { AmCard, AmSeg } from './am/amUi';

type GeneratorKind = 'beat' | 'bass' | 'atmosphere' | 'oneshot';

const KIND_LABEL: Record<GeneratorKind, string> = {
  beat: 'BEAT / RHYTHMUS',
  bass: 'BASS-SOUND',
  atmosphere: 'ATMOSPHÄRE',
  oneshot: 'ONE-SHOT',
};

const KIND_OPTIONS: readonly (readonly [GeneratorKind, string])[] = [
  ['beat', 'Beat'],
  ['bass', 'Bass'],
  ['atmosphere', 'Atmo'],
  ['oneshot', 'One-Shot'],
];

const KINDS = KIND_OPTIONS.map(([k]) => k);

/** Mini-Wellenform aus den Syntheseparametern (Oszillator × Abklingen). */
function wavePath(p: AudioSample['parameters'], w = 120, h = 32): string {
  const cycles = Math.max(2, Math.min(28, (p.frequency ?? 200) / 30));
  const decay = Math.max(0.05, p.decay ?? 0.4);
  const osc = p.oscillatorType ?? 'sine';
  const mid = h / 2;
  const pts: string[] = [];
  for (let i = 0; i <= 160; i += 1) {
    const t = i / 160;
    const ph = (t * cycles) % 1;
    const s = osc === 'sawtooth' ? 2 * ph - 1 : osc === 'triangle' ? 1 - 4 * Math.abs(ph - 0.5) : osc === 'square' ? (ph < 0.5 ? 1 : -1) : Math.sin(ph * 2 * Math.PI);
    const env = Math.exp(-t / (decay * 1.2));
    pts.push(`${i === 0 ? 'M' : 'L'}${(t * w).toFixed(1)} ${(mid - s * env * (mid - 2)).toFixed(1)}`);
  }
  return pts.join(' ');
}

/**
 * soundMONK – KI-/Regel-basierte Klang-Generierung · Rack-Modul
 * ============================================================
 * Vorlage public/uidesign/uiübersichtapp, Zeile 10: Beschreibung + Kategorie +
 * Erzeugen, daneben die Varianten (letzte Ergebnisse) mit Wellenform.
 * Beats gehen direkt in den Sequencer (`monk:apply-patterns`), alle anderen
 * Ergebnisse landen als AudioSample in der Session-Bibliothek (biblioMONK).
 */
export const SoundTerminal = React.memo(function SoundTerminal() {
  const { state, lockStatus, updateState } = usePluginState('sound', 'PRO');
  const { samples, addSample } = useSamples();
  // Beständige Plugins: Einstiegsstand = letzte Beschreibung/Kategorie.
  const [saved] = useState(() => mergeKnown({ description: '', kind: 'bass' }, readPluginSettings('sound')));
  const [description, setDescription] = useState<string>(saved.description);
  const [kind, setKind] = useState<GeneratorKind>(KINDS.includes(saved.kind as GeneratorKind) ? (saved.kind as GeneratorKind) : 'bass');
  useEffect(() => {
    writePluginSettings('sound', { description, kind });
  }, [description, kind]);
  const [busy, setBusy] = useState<GeneratorKind | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-9), line]);
  }, []);

  const synthesizeSample = (k: GeneratorKind, text: string): AudioSample => {
    const id = `sound-${k}-${Date.now().toString(36)}-${random().toString(36).slice(2, 6)}`;
    const base: AudioSample = {
      id,
      name: `${KIND_LABEL[k]} ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
      category: k === 'bass' ? 'bass' : k === 'atmosphere' ? 'highs' : 'mids',
      type: k === 'bass' ? 'Bass' : k === 'atmosphere' ? 'Pad' : 'Percussion',
      description: text ? `soundMONK ${k}: ${text}` : `soundMONK ${k}-Generator`,
      tags: ['soundmonk', k],
      parameters: {},
    };
    switch (k) {
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

  const preview = useCallback((sample: AudioSample) => {
    if (sample.url) {
      // KI-Audio direkt zur Hörprobe abspielen (Browser).
      try {
        const audio = new Audio(sample.url);
        audio.volume = 0.9;
        void audio.play().catch(() => { /* Autoplay-Block ignorieren */ });
      } catch { /* Audio-Objekt im Test/Node nicht verfügbar */ }
    } else {
      audioEngine.previewSynthesizedSample(sample.parameters ?? {}, 'channel5');
    }
  }, []);

  const generate = useCallback(async (k: GeneratorKind) => {
    setBusy(k);
    const text = description.trim();
    try {
      if (k === 'beat') {
        const patterns = generateRhythmicPattern('techno');
        audioEngine.loadPatterns(patterns as unknown as Record<string, boolean[]>);
        audioEngine.setBpm(128);
        window.dispatchEvent(new CustomEvent('monk:apply-patterns', { detail: { patterns, bpm: 128 } }));
        pushLog(`✓ BEAT erzeugt: 16 Steps × 8 Spuren @ 128 BPM → Sequencer`);
      } else {
        const sample = synthesizeSample(k, text);
        let usedAi = false;
        try {
          // soundMONK Server-AI (audiomonastry-ai / MusicGen) zuerst, lokale Synthese als Fallback.
          const resp = await fetch('/api/sound/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind: k,
              ...(text ? { prompt: text } : {}),
              durationSeconds: k === 'atmosphere' ? 8 : k === 'bass' ? 3 : 2,
            }),
          });
          if (resp.ok) {
            const blob = await resp.blob();
            if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
              sample.url = URL.createObjectURL(blob);
            }
            usedAi = true;
          }
        } catch {
          // Netzwerk-/Runtime-Fehler → lokale Synthese.
        }

        addSample(sample);
        preview(sample);
        pushLog(`✓ ${KIND_LABEL[k]} erzeugt → biblioMONK (${sample.name}${usedAi ? ', Server-AI' : ', lokal'})`);
      }
    } catch (e) {
      pushLog(`✗ ${KIND_LABEL[k]}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [addSample, description, preview, pushLog]);

  const variants = useMemo(
    () => samples.filter((s) => s.tags?.includes('soundmonk')).slice(-6).reverse(),
    [samples],
  );
  const locked = lockStatus.active && lockStatus.lockedBy !== webRTCManager.userId;
  const last = log[log.length - 1];

  return (
    <div className="am-rackrow am-a-sound" style={locked ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined}>
      <MoaAssistant pluginId="sound" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      <AmCard title="Beschreibung" style={{ flex: 1, minWidth: 340 }}>
        <textarea
          className="am-libq am-a-ta"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="Klang beschreiben"
          placeholder="z. B. dunkler, rollender Sub-Bass mit kurzem Attack …"
        />
        <div className="am-a-inline">
          <AmSeg<GeneratorKind> label="Kategorie" value={kind} options={KIND_OPTIONS} onChange={setKind} disabled={busy !== null} />
          <button type="button" className="am-btn am-pri" onClick={() => void generate(kind)} disabled={busy !== null}>
            {busy ? 'Erzeuge …' : 'Erzeugen'}
          </button>
          <span className="am-hint">{kind === 'beat' ? '→ Sequencer' : '→ biblioMONK'}</span>
        </div>
        <div className={`am-a-ell am-mono ${last?.startsWith('✗') ? 'am-a-err' : last ? 'am-a-ok' : 'am-hint'}`} aria-live="polite" title={last}>
          {last ?? 'Noch keine Generierung – Kategorie wählen und erzeugen.'}
        </div>
      </AmCard>

      <AmCard title="Varianten" style={{ flex: 1.3, minWidth: 420 }} right={<span className="am-vb">{variants.length} / 6</span>}>
        {variants.length === 0 ? (
          <span className="am-hint">Erzeugte Klänge erscheinen hier – Klick spielt sie ab.</span>
        ) : (
          <div className="am-a-variants">
            {variants.map((v) => (
              <button key={v.id} type="button" className="am-a-var" title={`${v.name} · ${v.description}`} onClick={() => preview(v)}>
                <svg viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true">
                  <path d={wavePath(v.parameters ?? {})} fill="none" stroke="var(--c)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
                </svg>
                <span className="am-a-ell">▶ {v.name}</span>
                {v.url ? <em>KI</em> : null}
              </button>
            ))}
          </div>
        )}
      </AmCard>
    </div>
  );
});
