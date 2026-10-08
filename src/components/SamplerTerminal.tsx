import React, { useEffect, useState } from 'react';
import { usePluginState } from '../hooks/usePluginState';
import { mergeKnown, readPluginSettings, writePluginSettings } from '../utils/pluginSettings';
import { useSamples } from '../context/SampleContext';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { AmCard, AmKnob, AmSeg, AmToggle } from './am/amUi';
import { TrackType } from '../types';
import { MUSIC_LIBRARY } from '../data/musicLibrary';
import { analyzeMusic } from '../utils/audioAnalyzer';

/**
 * audioMONASTRY samplerMONK — Echter 16-Pad-Sample-Sampler.
 * 16 RGB-Pads, CAPTURE aus jeder Quelle, pro Pad SLICE/LOOP/REVERSE/PITCH.
 */
const PAD_COLORS = [
  '#f43f5e', '#fb7185', '#f97316', '#fbbf24',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#a855f7',
  '#d946ef', '#ec4899', '#f472b6', '#fb923c',
];
const SAMPLE_TRACKS: TrackType[] = ['channel4', 'channel5', 'channel6', 'channel8'];

interface Pad {
  name: string; filled: boolean; color: string;
  slice: number; loop: boolean; reverse: boolean; pitch: number;
  bpm?: number; key?: string; analyzing?: boolean;
}
const emptyPads = (): Pad[] =>
  PAD_COLORS.map((c, i) => ({
    name: `PAD ${String(i + 1).padStart(2, '0')}`, filled: false, color: c,
    slice: 1, loop: false, reverse: false, pitch: 0,
  }));

export const SamplerTerminal = React.memo(() => {
  const { state, updateState } = usePluginState('syntisampler', 'PRO');
  const { takeoverRequest, clearTakeoverRequest } = useSamples();
  // Beständige Plugins (syntisampler › sampler): Muster und Pad-Regler. Die
  // Pad-Klänge selbst sind Audiodaten auf diesem Gerät (gehören in die Bibliothek).
  const [saved] = useState(() => readPluginSettings<{ pads?: unknown; seqs?: unknown; stepPitches?: unknown; quantize?: unknown; seqCount?: unknown; bank?: unknown }>('syntisampler', { section: 'sampler' }));
  const [pads, setPads] = useState<Pad[]>(() => {
    const base = emptyPads();
    const list = Array.isArray(saved?.pads) ? saved.pads : [];
    return base.map((p, i) => ({ ...p, ...mergeKnown({ slice: p.slice, loop: p.loop, reverse: p.reverse, pitch: p.pitch }, list[i]) }));
  });
  const [capturing, setCapturing] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  // NEW-MONK-2: 16/32-Step-Sequencer je Pad + Bank A/B + Quantize + Step-Pitch.
  const [seqs, setSeqs] = useState<Record<string, boolean[]>>(() => (saved?.seqs && typeof saved.seqs === 'object' ? saved.seqs as Record<string, boolean[]> : {}));
  const [stepPitches, setStepPitches] = useState<Record<string, Record<number, number>>>(() => (saved?.stepPitches && typeof saved.stepPitches === 'object' ? saved.stepPitches as Record<string, Record<number, number>> : {}));
  const [curStep, setCurStep] = useState(0);
  const [quantize, setQuantize] = useState(typeof saved?.quantize === 'boolean' ? saved.quantize : true);
  const [seqCount, setSeqCount] = useState<16 | 32>(saved?.seqCount === 32 ? 32 : 16);
  const [bank, setBank] = useState<'A' | 'B'>(saved?.bank === 'B' ? 'B' : 'A');
  useEffect(() => {
    writePluginSettings('syntisampler', {
      pads: pads.map((p) => ({ slice: p.slice, loop: p.loop, reverse: p.reverse, pitch: p.pitch })),
      seqs, stepPitches, quantize, seqCount, bank,
    }, { section: 'sampler' });
  }, [pads, seqs, stepPitches, quantize, seqCount, bank]);

  const seqKey = (padIdx: number) => `${bank}:${padIdx}`;

  const updatePad = (i: number, patch: Partial<Pad>) =>
    setPads((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  // Einheitliche Action-Menu-Übernahme: Sample in das gewählte (oder erste
  // freie) Pad übernehmen. Nutzt den vorhandenen Pad-Audio-Eingang (Trigger-
  // Track je Pad), keine neue Audio-Funktion.
  useEffect(() => {
    if (!takeoverRequest || takeoverRequest.pluginId !== 'sampler') return;
    const { sample } = takeoverRequest;
    const idx = sel ?? pads.findIndex((p) => !p.filled);
    if (idx >= 0) {
      updatePad(idx, { filled: true, name: sample.name });
      if (sample.url) {
        const t = SAMPLE_TRACKS[idx % SAMPLE_TRACKS.length];
        void audioEngine.loadTrackSample(t, sample.url).catch(() => { /* URL optional */ });
      }
    }
    clearTakeoverRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeoverRequest]);

  const triggerPad = (i: number, stepPitch = 0) => {
    const pad = pads[i];
    if (!pad.filled) return;
    const t = SAMPLE_TRACKS[i % SAMPLE_TRACKS.length];
    audioEngine.triggerEvent(t, 0.9);
    const pitch = (pad.pitch ?? 0) + stepPitch;
    if (pitch !== 0) audioEngine.setChannelPan(t, Math.max(-1, Math.min(1, pitch / 12)));
  };

  // Step-Anzeige vom Master-Transport.
  useEffect(() => audioEngine.addStepListener(setCurStep), []);

  // Sequencer: aktive Steps triggern das zugehörige Pad (quantisiert).
  useEffect(() => {
    if (!quantize) return;
    const step = curStep % seqCount;
    Object.entries(seqs).forEach(([key, arr]) => {
      if (!arr[step]) return;
      const i = Number(key.split(':')[1]);
      if (pads[i]?.filled) triggerPad(i, stepPitches[key]?.[step] ?? 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curStep, quantize, seqs, pads, seqCount, stepPitches]);

  const toggleSeq = (padIdx: number, step: number) => {
    const key = seqKey(padIdx);
    setSeqs((prev) => {
      const arr = prev[key] ? [...prev[key]] : Array(seqCount).fill(false);
      arr[step] = !arr[step];
      return { ...prev, [key]: arr };
    });
  };

  const setStepPitch = (padIdx: number, step: number, pitch: number) => {
    const key = seqKey(padIdx);
    setStepPitches((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [step]: pitch } }));
  };

  const capture = () => {
    if (capturing) return;
    setCapturing(true);
    setTimeout(() => {
      setPads((prev) => prev.map((p, i) =>
        i < 4 ? { ...p, filled: true, name: `CAP ${Date.now() % 1000}`, loop: true } : p
      ));
      setCapturing(false);
    }, 600);
  };

  const step = curStep % seqCount;
  const selPad = sel !== null ? pads[sel] : null;
  // Spuren im Raster: Pads mit Klang oder Muster in dieser Bank + das gewählte.
  const rows = pads.map((p, i) => i).filter((i) => i === sel || pads[i].filled || (seqs[seqKey(i)] ?? []).some(Boolean));
  const padInfo = (p: Pad) => (p.filled
    ? `SL${p.slice}${p.loop ? ' ∞' : ''}${p.reverse ? ' RVS' : ''}${p.pitch !== 0 ? ` ${p.pitch > 0 ? '+' : ''}${p.pitch}st` : ''}`
    : 'LEER');

  return (
    <div className="am-rackrow">
      <MoaAssistant pluginId="sampler" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      <AmCard title="Pads · 16" style={{ width: 236 }}
        right={(
          <button type="button" onClick={capture} disabled={capturing} className={`am-tg am-cue ${capturing ? 'am-on' : ''}`} title="Aus der laufenden Quelle in Pad 1–4 aufnehmen">
            ● CAPTURE
          </button>
        )}>
        <div className="am-c-pads">
          {pads.map((p, i) => ( // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
            <div key={i}
              role="button"
              tabIndex={0}
              aria-label={`Pad ${i + 1}: ${p.name}`}
              title={`${p.name} · ${padInfo(p)}${p.filled && (p.bpm || p.key) ? ` · ${p.bpm ?? ''} ${p.key ?? ''}` : ''}`}
              onClick={() => { triggerPad(i); setSel(i); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); triggerPad(i); setSel(i); } }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
              onDrop={(e) => { e.preventDefault(); updatePad(i, { filled: true, name: e.dataTransfer.getData('text/plain') || p.name }); }}
              className={`am-pad ${p.filled ? '' : 'am-c-empty'} ${sel === i ? 'am-c-sel' : ''}`}
              style={{ ['--pc' as string]: p.color }}>
              <span>{p.filled ? p.name : String(i + 1).padStart(2, '0')}</span>
              {p.filled && <small>{p.analyzing ? 'ANALYSE…' : padInfo(p)}</small>}
            </div>
          ))}
        </div>
      </AmCard>

      <AmCard title={selPad ? `Pad ${String((sel ?? 0) + 1).padStart(2, '0')}` : 'Pad'} style={{ width: 250 }}
        right={selPad?.filled ? <span className="am-vb">{selPad.analyzing ? 'ANALYSE…' : [selPad.bpm, selPad.key].filter(Boolean).join(' · ') || '—'}</span> : undefined}>
        {sel !== null && selPad ? (
          <>
            <div className="am-c-name" title={selPad.name}>{selPad.name}</div>
            <div className="am-c-row">
              <button type="button" className="am-tg am-on" onClick={() => updatePad(sel, { slice: (selPad.slice % 4) + 1 })} title="Slices 1–4">SLICE {selPad.slice}</button>
              <AmToggle on={selPad.loop} onClick={() => updatePad(sel, { loop: !selPad.loop })}>LOOP</AmToggle>
              <AmToggle on={selPad.reverse} kind="m" onClick={() => updatePad(sel, { reverse: !selPad.reverse })}>REVERSE</AmToggle>
              <AmKnob size="xs" value={selPad.pitch} min={-12} max={12} def={0} unit="int" label="Pitch" title="Pad-Tonhöhe (Halbtöne)"
                onChange={(v) => updatePad(sel, { pitch: Math.round(v) })} />
            </div>
            <div className="am-c-row">
              <select
                className="am-sel am-c-grow"
                aria-label="Musik auf Pad laden"
                value=""
                onChange={(e) => {
                  const t = MUSIC_LIBRARY.find((x) => x.name === e.target.value);
                  if (t) {
                    updatePad(sel, { filled: true, name: t.name, analyzing: true });
                    audioEngine.loadTrackSample(SAMPLE_TRACKS[sel % SAMPLE_TRACKS.length], t.url);
                    analyzeMusic(t.url).then((a) =>
                      updatePad(sel, { bpm: a?.bpm, key: a?.key, analyzing: false }),
                    );
                  }
                }}
              >
                <option value="">+ MUSIK LADEN</option>
                {MUSIC_LIBRARY.map((t) => (
                  <option key={t.id} value={t.name}>{t.name}</option>
                ))}
              </select>
              <button type="button" className="am-tg am-m" onClick={() => updatePad(sel, { filled: false })} title="Pad leeren">CLEAR</button>
            </div>
          </>
        ) : (
          <span className="am-hint">Pad antippen oder Sample auf ein Pad ziehen.</span>
        )}
      </AmCard>

      {/* NEW-MONK-2: Step-Sequencer (16/32, Bank A/B) – Spuren = Pads.
          VISUAL-P1-010: enthält den laufenden Step (curStep) - data-live-value haelt
          ihn aus visuellen Baselines heraus, weil er sich mit dem Transport aendert. */}
      <AmCard title={`Step-Sequenzer · Bank ${bank}`} style={{ flex: 1, minWidth: 420 }}
        right={<span className="am-c-stat" data-live-value="step">STEP {step + 1}/{seqCount}</span>}>
        <div className="am-c-row">
          <AmToggle on={quantize} kind="sync" onClick={() => setQuantize(!quantize)} title="Steps am Master-Transport auslösen">QUANT</AmToggle>
          <AmSeg<'A' | 'B'> label="Bank" value={bank} onChange={setBank} options={[['A', 'BANK A'], ['B', 'BANK B']]} />
          <AmSeg label="Steps" value={String(seqCount) as '16' | '32'} onChange={(v) => setSeqCount(v === '32' ? 32 : 16)} options={[['16', '16'], ['32', '32']]} />
          {sel !== null && (
            <AmKnob size="xs" value={stepPitches[seqKey(sel)]?.[step] ?? 0} min={-12} max={12} def={0} unit="int"
              label={`St ${step + 1}`} title={`Step-Pitch (Step ${step + 1})`}
              onChange={(v) => setStepPitch(sel, step, Math.round(v))} />
          )}
        </div>
        <div className="am-c-seqbox" data-live-value="step-sequencer">
          {rows.length === 0 ? (
            <span className="am-hint">Pad wählen – dann Steps setzen.</span>
          ) : (
            <div className="am-c-seq am-c-st" style={{ ['--n' as string]: seqCount }}>
              {rows.map((i) => (
                <React.Fragment key={i}>
                  <button type="button" className={`am-c-trk ${sel === i ? 'am-on' : ''}`} style={{ ['--c' as string]: pads[i].color }}
                    onClick={() => setSel(i)} title={`Spur Pad ${i + 1} wählen`}>
                    {String(i + 1).padStart(2, '0')}
                  </button>
                  {[...Array(seqCount)].map((_, s) => {
                    const on = seqs[seqKey(i)]?.[s] ?? false;
                    return (
                      <button type="button" key={s}
                        aria-label={`Pad ${i + 1} Step ${s + 1} ${on ? 'aus' : 'an'}`} aria-pressed={on}
                        onClick={() => toggleSeq(i, s)}
                        className={`am-stp ${on ? 'am-v2' : ''} ${s % 4 === 0 ? 'am-q' : ''} ${step === s ? 'am-ph' : ''}`}
                        style={{ ['--c' as string]: pads[i].color }} />
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      </AmCard>
    </div>
  );
});
