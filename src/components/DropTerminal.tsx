/**
 * dropMONK · Rack-Modul (Vorlage public/uidesign/uiübersichtapp, Zeile 02)
 * =======================================================================
 * Eine Zeile: links Kategorien · Mitte 2×8 Pads + Verlauf des gewählten Pads
 * (Parameter-Kurven des Drop-Profils) + KI-Eingabe · rechts Trigger/Modus.
 * Die Logik bleibt im DropContext (selectProfile, executeDrop,
 * triggerDjTransition, generateDrop, loadPreset, toggleFavorite).
 */

import React, { useMemo, useState } from 'react';
import { useDropContext, DropProvider } from '../context/DropContext';
import type { DropMode } from '../context/DropContext';
import { DROP_PROFILES } from '../core/drop';
import type { CurveType, DropProfile } from '../core/drop';
import { AmCard, AmSeg, AmToggle } from './am/amUi';
import { DropGeneratorPanel } from './drop/DropGeneratorPanel';
import { DJTransitionPanel } from './drop/DJTransitionPanel';
import { SamplerTopPanel } from './drop/SamplerTopPanel';
import { AiChatPanel } from './drop/AiChatPanel';
import { DropPresetBrowser } from './drop/DropPresetBrowser';

type PadCat = 'all' | 'buildup' | 'breakdown' | 'transition' | 'fill' | 'tops' | 'ai';
type PadAction = 'select' | 'fire';

const CATS: readonly (readonly [PadCat, string])[] = [
  ['all', 'Alle'],
  ['buildup', 'Buildups'],
  ['breakdown', 'Breakdowns'],
  ['transition', 'Übergänge'],
  ['fill', 'Fills'],
  ['tops', 'Tops'],
  ['ai', 'KI & Presets'],
];

const MODES: readonly (readonly [DropMode, string])[] = [
  ['generator', 'Drop'],
  ['dj_transition', 'DJ-Übergang'],
  ['sampler_top', 'Top'],
];

const PAD_ACTIONS: readonly (readonly [PadAction, string])[] = [
  ['select', 'Wählen'],
  ['fire', 'Auslösen'],
];

const CHANNELS = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5 (Master)'];
const AI_SUGGESTIONS = ['Energy', 'Ambient', 'Techno', 'Sidechain', 'Breakdown', 'Cymbal'];
const PAD_COUNT = 16;
const padColor = (i: number) => `hsl(${(i * 47 + 330) % 360} 75% 60%)`;
const CURVE_COLORS = ['var(--c)', '#4cc9f0', '#ffb703', '#a3e635', '#e879f9'];

interface Pad {
  key: string;
  label: string;
  profile: DropProfile;
  presetId?: string;
}

const ease = (c: CurveType, t: number): number => {
  switch (c) {
    case 'exponential': return t * t;
    case 'logarithmic': return Math.sqrt(t);
    case 's-curve': return t * t * (3 - 2 * t);
    case 'stepped': return Math.floor(t * 4) / 4;
    default: return t;
  }
};

/** Verlauf je Parameter (0..1 über die Drop-Dauer) als SVG-Pfad. */
function envelopePaths(p: DropProfile, w: number, h: number): string[] {
  const seq = p.parameterSequence ?? [];
  const total = Math.max(p.dropDuration || 0, ...seq.map((s) => (s.delay ?? 0) + s.duration), 1);
  const y = (v: number) => (h - Math.max(0, Math.min(1, v)) * h).toFixed(1);
  return seq.map((s) => {
    const x0 = ((s.delay ?? 0) / total) * w;
    const span = (s.duration / total) * w;
    const parts = [`M0 ${y(s.startValue)}`, `L${x0.toFixed(1)} ${y(s.startValue)}`];
    for (let k = 1; k <= 24; k += 1) {
      const t = k / 24;
      parts.push(`L${(x0 + t * span).toFixed(1)} ${y(s.startValue + (s.endValue - s.startValue) * ease(s.curve, t))}`);
    }
    parts.push(`L${w} ${y(s.endValue)}`);
    return parts.join(' ');
  });
}

const DropTerminalContent = React.memo(function DropTerminalContent() {
  const {
    mode, setMode,
    selectedProfile, selectProfile,
    aiSuggestions, presets, favorites,
    isExecuting, executionProgress, executeDrop,
    selectedStartChannel, selectedEndChannel, setSelectedChannels,
    triggerDjTransition, transitionInProgress,
    generateDrop, loadPreset, toggleFavorite, chatHistory,
  } = useDropContext();

  const [cat, setCat] = useState<PadCat>('all');
  const [padAction, setPadAction] = useState<PadAction>('select');
  // Verzögertes Einwerfen: wartet auf die nächste 4-Takt-Grenze
  // (`dropEngine.triggerDrop(profile, 'quantized', '4bar')` via executeDrop).
  const [quantized, setQuantized] = useState(false);
  const [outputChannel, setOutputChannel] = useState('CH1');
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  // Erweitert (eingeklappt): die vollständigen Panels – Chat-Verlauf,
  // Preset-Verwaltung und Modus-Details. Nur gerendert, wenn aufgeklappt.
  const [moreOpen, setMoreOpen] = useState(false);

  const allPads = useMemo<Pad[]>(() => {
    const base = DROP_PROFILES.map((p) => ({ key: p.id, label: p.name, profile: p }));
    const ai = aiSuggestions.map((p) => ({ key: `ai-${p.id}`, label: p.name, profile: p as DropProfile }));
    const pre = presets.map((p) => ({ key: `preset-${p.id}`, label: p.name, profile: p.profile, presetId: p.id }));
    return [...base, ...ai, ...pre];
  }, [aiSuggestions, presets]);

  const padsFor = (c: PadCat): Pad[] => {
    switch (c) {
      case 'all': return allPads;
      case 'tops': return allPads.filter((p) => p.profile.tags?.includes('percussive'));
      case 'ai': return allPads.filter((p) => p.key.startsWith('ai-') || p.presetId);
      default: return allPads.filter((p) => p.profile.category === c);
    }
  };
  const pads = padsFor(cat).slice(0, PAD_COUNT);

  const hit = (pad: Pad) => {
    if (pad.presetId) void loadPreset(pad.presetId);
    setSelectedPresetId(pad.presetId ?? null);
    selectProfile(pad.profile);
    if (padAction === 'fire' && mode !== 'dj_transition' && !isExecuting) {
      void executeDrop(pad.profile, mode === 'generator' && quantized);
    }
  };

  const sendAi = async (text: string) => {
    if (!text.trim() || aiBusy) return;
    setAiBusy(true);
    try {
      await generateDrop(text);
      setInput('');
    } catch (err) {
      console.error('Chat error:', err);
    } finally {
      setAiBusy(false);
    }
  };

  const busy = isExecuting || transitionInProgress;
  const pct = Math.round(executionProgress * 100);
  const paths = selectedProfile ? envelopePaths(selectedProfile, 300, 60) : [];
  const isFav = !!selectedPresetId && favorites.some((f) => f.id === selectedPresetId);
  const lastAi = [...chatHistory].reverse().find((m) => m.sender === 'ai');

  return (
    <div className="am-rackrow am-a-drop">
      <AmCard title="Kategorie" style={{ width: 150 }}>
        <div className="am-list" role="listbox" aria-label="Drop-Kategorie">
          {CATS.map(([id, label]) => (
            <button key={id} type="button" role="option" aria-selected={cat === id} className={cat === id ? 'am-on' : ''} onClick={() => setCat(id)}>
              {label}<i>{padsFor(id).length}</i>
            </button>
          ))}
        </div>
      </AmCard>

      <AmCard
        title="Pads"
        style={{ flex: 1, minWidth: 560 }}
        right={(
          <span className="am-a-inline">
            {selectedPresetId ? (
              <AmToggle on={isFav} onClick={() => void toggleFavorite(selectedPresetId)} ariaLabel="Favorit" title="Preset als Favorit markieren">★</AmToggle>
            ) : null}
            <span className="am-vb">{selectedProfile ? selectedProfile.name : 'kein Pad gewählt'}</span>
          </span>
        )}
      >
        <div className="am-a-padrow">
          <div className="am-pads am-a-pads8" role="group" aria-label="Drop-Pads">
            {Array.from({ length: PAD_COUNT }, (_, i) => {
              const pad = pads[i];
              if (!pad) return <button key={`empty-${i}`} type="button" className="am-pad am-a-empty" disabled aria-label={`Pad ${i + 1} leer`} />;
              const on = selectedProfile?.id === pad.profile.id && (selectedPresetId ?? null) === (pad.presetId ?? null);
              return (
                <button
                  key={pad.key}
                  type="button"
                  className={`am-pad ${on ? 'am-lit' : ''} ${on && isExecuting ? 'am-hit' : ''}`}
                  style={{ ['--pc' as string]: padColor(i) }}
                  title={`${pad.label} · ${pad.profile.description}`}
                  aria-pressed={on}
                  onClick={() => hit(pad)}
                >
                  {pad.label}
                </button>
              );
            })}
          </div>
          <div className="am-a-envcol">
            <svg className="am-a-env" viewBox="0 0 300 60" preserveAspectRatio="none" aria-label="Parameter-Verlauf des gewählten Pads">
              {[15, 30, 45].map((y) => <line key={y} x1="0" x2="300" y1={y} y2={y} className="am-a-grid" />)}
              {paths.map((d, i) => (
                <path key={i} d={d} fill="none" stroke={CURVE_COLORS[i % CURVE_COLORS.length]} strokeWidth="2" vectorEffect="non-scaling-stroke" />
              ))}
              {isExecuting ? <line x1={pct * 3} x2={pct * 3} y1="0" y2="60" className="am-a-ph" /> : null}
            </svg>
            {selectedProfile ? (
              <div className="am-a-meta am-mono">
                <span>Dauer {selectedProfile.dropDuration} ms</span>
                <span>Buildup {selectedProfile.buildupTime} ms</span>
                <span>Quant. {selectedProfile.quantization}</span>
                {selectedProfile.intensity !== undefined ? <span>Intensität {Math.round(selectedProfile.intensity * 100)} %</span> : null}
                {(selectedProfile.parameterSequence ?? []).map((s, i) => (
                  <span key={i} style={{ color: CURVE_COLORS[i % CURVE_COLORS.length] }}>{s.pluginId}·{s.parameterId}</span>
                ))}
              </div>
            ) : (
              <span className="am-hint">Pad wählen – der Verlauf der Parameter erscheint hier.</span>
            )}
          </div>
        </div>
        <div className="am-a-inline">
          <input
            className="am-libq"
            list="am-a-drop-sugg"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void sendAi(input); }}
            placeholder="KI: Drop beschreiben …"
            aria-label="Drop beschreiben"
            disabled={aiBusy}
          />
          <datalist id="am-a-drop-sugg">
            {AI_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
          </datalist>
          <button type="button" className="am-btn" onClick={() => void sendAi(input)} disabled={!input.trim() || aiBusy}>
            {aiBusy ? 'KI …' : 'KI-Drop'}
          </button>
          <span className="am-hint am-a-ell" aria-live="polite">{lastAi ? lastAi.text : 'Erzeugte Drops landen unter „KI & Presets".'}</span>
        </div>
      </AmCard>

      <AmCard title="Trigger" style={{ width: 240 }}>
        <AmSeg label="Drop-Modus" value={mode} options={MODES} onChange={setMode} />
        <div className="am-a-inline">
          <span className="am-lbl">Pad</span>
          <AmSeg<PadAction> label="Pad-Verhalten" value={padAction} options={PAD_ACTIONS} onChange={setPadAction} />
        </div>

        {mode === 'generator' && (
          <>
            <div className="am-a-inline">
              <AmToggle on={quantized} onClick={() => setQuantized((q) => !q)} ariaLabel="Quantized Recall" title="Quantized Recall">4-TAKT</AmToggle>
              <span className="am-hint">{quantized ? 'Wartet auf die nächste 4-Takt-Grenze' : 'Wirft sofort ein'}</span>
            </div>
            <button
              type="button"
              className="am-btn am-pri"
              onClick={() => selectedProfile && void executeDrop(selectedProfile, quantized)}
              disabled={!selectedProfile || isExecuting}
            >
              {isExecuting ? `DROPPING … ${pct}%` : quantized ? '▼ DROP · 4-BAR' : '▼ DROP'}
            </button>
          </>
        )}

        {mode === 'dj_transition' && (
          <>
            <div className="am-a-inline">
              <select className="am-sel" aria-label="Von Kanal" value={selectedStartChannel || ''} onChange={(e) => setSelectedChannels(e.target.value, selectedEndChannel)}>
                <option value="">Von …</option>
                {CHANNELS.map((ch) => <option key={ch} value={ch}>{ch}</option>)}
              </select>
              <span className="am-arrow">→</span>
              <select className="am-sel" aria-label="Nach Kanal" value={selectedEndChannel || ''} onChange={(e) => setSelectedChannels(selectedStartChannel, e.target.value)}>
                <option value="">Nach …</option>
                {CHANNELS.map((ch) => <option key={ch} value={ch}>{ch}</option>)}
              </select>
            </div>
            <button
              type="button"
              className="am-btn am-pri"
              onClick={() => selectedStartChannel && selectedEndChannel && void triggerDjTransition(selectedStartChannel, selectedEndChannel, selectedProfile ?? undefined)}
              disabled={!selectedStartChannel || !selectedEndChannel || transitionInProgress}
            >
              {transitionInProgress ? 'ÜBERGANG …' : '▶ ÜBERGANG STARTEN'}
            </button>
          </>
        )}

        {mode === 'sampler_top' && (
          <>
            <select className="am-sel" aria-label="Ausgangskanal" value={outputChannel} onChange={(e) => setOutputChannel(e.target.value)}>
              {CHANNELS.map((ch) => <option key={ch} value={ch}>{ch}</option>)}
            </select>
            <button
              type="button"
              className="am-btn am-pri"
              onClick={() => selectedProfile && void executeDrop(selectedProfile, false)}
              disabled={!selectedProfile || isExecuting}
            >
              {isExecuting ? 'TOP …' : '▶ TOP ERZEUGEN'}
            </button>
          </>
        )}

        {busy ? (
          <div className="am-a-prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={isExecuting ? pct : undefined} aria-label="Fortschritt">
            <i style={{ width: isExecuting ? `${pct}%` : '100%' }} />
          </div>
        ) : null}
      </AmCard>

      <details className="am-a-more" onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="am-lbl">Erweitert · KI-Chat · Presets · Modus-Details</summary>
        {moreOpen ? (
          <div className="am-a-moregrid">
            <div className="am-a-morebox"><AiChatPanel /></div>
            <div className="am-a-morebox"><DropPresetBrowser /></div>
            <div className="am-a-morebox">
              {mode === 'generator' && <DropGeneratorPanel />}
              {mode === 'dj_transition' && <DJTransitionPanel />}
              {mode === 'sampler_top' && <SamplerTopPanel />}
            </div>
          </div>
        ) : null}
      </details>
    </div>
  );
});

/**
 * Main DropTerminal Component
 * Wrapped with DropProvider
 */
export const DropTerminal = React.memo(function DropTerminal() {
  return (
    <DropProvider>
      <DropTerminalContent />
    </DropProvider>
  );
});
