/**
 * Mastergraph nach Entwurf – reine Ansicht des Main-Ausgangs
 * ===========================================================
 * Titel · laufende Wellenform des Main-Ausgangs · Zeit/BPM/Takt/Position/
 * Tonart/LUFS · L/R-Pegel. Ton auf Main startet nur ▶ im mixerMONK. Einziges
 * Bedienelement: „Capture“ (IDEA-2026-10-07-A, nur für den mixerMONK-Halter).
 * Werte kommen aus der Engine (UI-Takt, nie im Audio-Thread).
 */
import React, { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings } from '../../utils/pluginSettings';
import { loadAutoloadSong } from '../../core/session/autoloadSong';
import { lufsLabel, transportReadout } from '../MastergraphReadout';
import { EngineStatusBadge } from '../EngineStatusBadge';
import { AmMeter } from './amUi';
import { readMainLevel } from '../../core/audio/mainLevel';
import { CaptureControl } from './CaptureControl';
import { PianoRollTerminal } from './PianoRollTerminal';
import { AutomationPanel } from './AutomationPanel';

const HISTORY = 240;

interface Readout { seconds: number; lufs: number; lufsM: number; truePeak: number; l: number; r: number; peakL: number; peakR: number }
const EMPTY_READOUT: Readout = { seconds: 0, lufs: 0, lufsM: 0, truePeak: 0, l: 0, r: 0, peakL: 0, peakR: 0 };
/** Quantisiert, damit identische Messwerte keinen React-Render auslösen. */
const q = (v: number, step: number) => Math.round(v / step) * step;

export const StudioMastergraph = React.memo(function StudioMastergraph({ bpm, isPlaying, mainHolder = false }: { bpm: number; isPlaying: boolean; mainHolder?: boolean }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  // EIN Zustandsobjekt statt fünf Einzel-States: ein setState pro Tick,
  // und nur wenn sich ein quantisierter Wert wirklich geändert hat.
  const [readout, setReadout] = useState<Readout>(EMPTY_READOUT);
  const { seconds, lufs, lufsM, truePeak } = readout;
  const [key, setKey] = useState('–');
  const [title] = useState(() => loadAutoloadSong()?.name ?? 'Main Out');

  // Tonart aus dem Mixer-Stand (Session) – gleich auf allen Geräten.
  useEffect(() => {
    const read = () => {
      const k = (readPluginSettings('mixer') as { desk?: { key?: unknown } } | null)?.desk?.key;
      setKey(typeof k === 'string' ? k : '–');
    };
    read();
    const id = window.setInterval(read, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Wellenform als Verlauf des Main-Pegels (gemeinsamer Abgriff, src/core/audio/mainLevel.ts).
  useEffect(() => {
    const hist: number[] = Array(HISTORY).fill(0);
    const tick = () => {
      // RT-AUDIT-P0-005: getrennte L/R-Pegel, True Peak und LUFS-M aus dem
      // Mess-SAB des V2-Sinks (echte Werte, nicht derselbe Wert zweimal).
      const mv = audioEngine.readMeterValues();
      const next: Readout = {
        seconds: q(audioEngine.getTransportSeconds(), 0.05),
        lufs: q(audioEngine.getLufsValue(), 0.05),
        lufsM: mv ? q(mv.lufsM, 0.05) : 0,
        truePeak: mv ? q(Math.max(mv.truePeakL, mv.truePeakR), 0.001) : 0,
        l: mv ? q(mv.peakL, 0.005) : 0,
        r: mv ? q(mv.peakR, 0.005) : 0,
        peakL: mv ? q(mv.peakHoldL, 0.005) : 0,
        peakR: mv ? q(mv.peakHoldR, 0.005) : 0,
      };
      setReadout((prev) => (
        prev.seconds === next.seconds && prev.lufs === next.lufs && prev.lufsM === next.lufsM
        && prev.truePeak === next.truePeak && prev.l === next.l && prev.r === next.r
        && prev.peakL === next.peakL && prev.peakR === next.peakR
          ? prev
          : next
      ));
      hist.push(readMainLevel().raw);
      hist.shift();
      const cv = canvas.current;
      const g = cv?.getContext('2d');
      if (!cv || !g || cv.clientWidth < 4) return;
      const w = (cv.width = cv.clientWidth * devicePixelRatio);
      const h = (cv.height = cv.clientHeight * devicePixelRatio);
      g.clearRect(0, 0, w, h);
      g.strokeStyle = 'rgba(70,130,255,.10)';
      for (let x = 0; x < w; x += w / 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      // Farbverlauf wie in der Vorlage (uiübersichtapp): Violett → Blau → Cyan → Grün.
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#8b5cf6'); grad.addColorStop(0.35, '#3b82f6'); grad.addColorStop(0.7, '#22d3ee'); grad.addColorStop(1, '#4ade80');
      g.fillStyle = grad;
      const bw = w / HISTORY;
      for (let i = 0; i < HISTORY; i += 1) {
        const v = Math.max(0.015, hist[i]);
        const bh = v * h * 0.95;
        g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.6), bh);
      }
      g.fillStyle = '#ffffff';
      g.fillRect(w - 2 * devicePixelRatio, 0, 2 * devicePixelRatio, h);
    };
    tick();
    const id = window.setInterval(tick, isPlaying ? 60 : 400);
    return () => window.clearInterval(id);
  }, [isPlaying]);

  const r = transportReadout(seconds, bpm);
  return (
    <>
      <section id="rack-mastergraph" className="am-box am-mp" aria-label="Mastergraph, nur Ansicht">
        <div className="am-mpt">
          <b>{title}</b>
          <small>Main Out · alle sehen dasselbe</small>
          <span className="am-tag">MASTERGRAPH · NUR ANSICHT</span>
          <div style={{ marginTop: 6 }}><EngineStatusBadge /></div>
          <CaptureControl mainHolder={mainHolder} />
        </div>
        <div className="am-mpw"><canvas ref={canvas} aria-hidden="true" /></div>
        <dl className="am-mpi" style={{ gridTemplateColumns: 'repeat(4, auto)' }}>
          <div><dt>ZEIT</dt><dd className="am-big">{r.time}</dd></div>
          <div><dt>BPM</dt><dd>{bpm.toFixed(1)}</dd></div>
          <div><dt>TAKT</dt><dd>4 / 4</dd></div>
          <div><dt>TRANSPORT</dt><dd>{isPlaying ? 'PLAY' : 'STOP'}</dd></div>
          <div><dt>POSITION</dt><dd>{r.position}</dd></div>
          <div><dt>TONART</dt><dd>{key}</dd></div>
          <div><dt>LUFS S</dt><dd>{lufsLabel(lufs)}</dd></div>
          <div><dt>LUFS M</dt><dd>{lufsM < -70 ? '–' : lufsM.toFixed(1)}</dd></div>
          <div><dt>TRUE PEAK</dt><dd>{truePeak <= 0 ? '–' : `${(20 * Math.log10(truePeak)).toFixed(1)} dB`}</dd></div>
        </dl>
        <div className="am-lrw" aria-label="Pegel Main L/R (getrennt)">
          <div className="am-sc"><span>0</span><span>-6</span><span>-12</span><span>-24</span><span>-48</span></div>
          <AmMeter level={readout.l} peak={readout.peakL} width={9} />
          <AmMeter level={readout.r} peak={readout.peakR} width={9} />
        </div>
      </section>
      <PianoRollTerminal />
      <AutomationPanel />
    </>
  );
});
