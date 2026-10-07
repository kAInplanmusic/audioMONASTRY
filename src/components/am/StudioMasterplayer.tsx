/**
 * Masterplayer nach Entwurf – reine Ansicht des Main-Ausgangs
 * ===========================================================
 * Titel · laufende Wellenform des Main-Ausgangs · Zeit/BPM/Takt/Position/
 * Tonart/LUFS · L/R-Pegel. Keine Bedienelemente: Ton auf Main startet nur ▶ im
 * mixerMONK. Werte kommen aus der Engine (UI-Takt, nie im Audio-Thread).
 */
import React, { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings } from '../../utils/pluginSettings';
import { loadAutoloadSong } from '../../core/session/autoloadSong';
import { lufsLabel, transportReadout } from '../MasterplayerReadout';
import { EngineStatusBadge } from '../EngineStatusBadge';
import { AmMeter } from './amUi';
import { readMainLevel, useMainLevel } from '../../core/audio/mainLevel';

const HISTORY = 240;

export const StudioMasterplayer = React.memo(function StudioMasterplayer({ bpm, isPlaying }: { bpm: number; isPlaying: boolean }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [lufs, setLufs] = useState(0);
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
  const main = useMainLevel();
  useEffect(() => {
    const hist: number[] = Array(HISTORY).fill(0);
    const tick = () => {
      setSeconds(audioEngine.getTransportSeconds());
      setLufs(audioEngine.getLufsValue());
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
    <section id="rack-masterplayer" className="am-box am-mp" aria-label="Masterplayer, nur Ansicht">
      <div className="am-mpt">
        <b>{title}</b>
        <small>Main Out · alle sehen dasselbe</small>
        <span className="am-tag">MASTERPLAYER · NUR ANSICHT</span>
        <div style={{ marginTop: 6 }}><EngineStatusBadge /></div>
      </div>
      <div className="am-mpw"><canvas ref={canvas} aria-hidden="true" /></div>
      <dl className="am-mpi" style={{ gridTemplateColumns: 'repeat(4, auto)' }}>
        <div><dt>ZEIT</dt><dd className="am-big">{r.time}</dd></div>
        <div><dt>BPM</dt><dd>{bpm.toFixed(1)}</dd></div>
        <div><dt>TAKT</dt><dd>4 / 4</dd></div>
        <div><dt>TRANSPORT</dt><dd>{isPlaying ? 'PLAY' : 'STOP'}</dd></div>
        <div><dt>POSITION</dt><dd>{r.position}</dd></div>
        <div><dt>TONART</dt><dd>{key}</dd></div>
        <div><dt>LUFS</dt><dd>{lufsLabel(lufs)}</dd></div>
      </dl>
      <div className="am-lrw" aria-label="Pegel Main L/R">
        <div className="am-sc"><span>0</span><span>-6</span><span>-12</span><span>-24</span><span>-48</span></div>
        <AmMeter level={main.level} peak={main.peak} width={9} />
        <AmMeter level={main.level} peak={main.peak} width={9} />
      </div>
    </section>
  );
});
