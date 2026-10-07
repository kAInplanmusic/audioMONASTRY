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

const HISTORY = 240;

export const StudioMasterplayer = React.memo(function StudioMasterplayer({ bpm, isPlaying }: { bpm: number; isPlaying: boolean }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [lufs, setLufs] = useState(0);
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
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

  // Wellenform als Verlauf der Spitzenwerte + Pegel.
  useEffect(() => {
    let analyser: AnalyserNode | null = null;
    let buf: Float32Array | null = null;
    const hist: number[] = Array(HISTORY).fill(0);
    let pk = 0;
    const tick = () => {
      setSeconds(audioEngine.getTransportSeconds());
      setLufs(audioEngine.getLufsValue());
      if (!analyser) {
        try { analyser = audioEngine.createVisualAnalyser(1024); } catch { analyser = null; }
        if (analyser) buf = new Float32Array(analyser.fftSize);
      }
      let p = 0;
      if (analyser && buf) {
        analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
        for (let i = 0; i < buf.length; i += 2) p = Math.max(p, Math.abs(buf[i]));
      }
      const lv = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(p, 1e-5)) + 48) / 48));
      pk = Math.max(lv, pk - 0.02);
      setLevel(lv);
      setPeak(pk);
      hist.push(Math.min(1, p));
      hist.shift();
      const cv = canvas.current;
      const g = cv?.getContext('2d');
      if (!cv || !g) return;
      const w = (cv.width = cv.clientWidth * devicePixelRatio);
      const h = (cv.height = cv.clientHeight * devicePixelRatio);
      g.clearRect(0, 0, w, h);
      // Taktraster
      g.strokeStyle = 'rgba(70,130,255,.10)';
      for (let x = 0; x < w; x += w / 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      const bw = w / HISTORY;
      for (let i = 0; i < HISTORY; i += 1) {
        const v = hist[i];
        const bh = Math.max(1, v * h * 0.95);
        g.fillStyle = i > HISTORY - 6 ? '#ffffff' : `rgba(76,201,240,${0.35 + v * 0.65})`;
        g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 1), bh);
      }
    };
    tick();
    const id = window.setInterval(tick, isPlaying ? 50 : 400);
    return () => {
      window.clearInterval(id);
      if (analyser) try { audioEngine.disconnectVisualAnalyser(analyser); } catch { /* noop */ }
    };
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
        <AmMeter level={level} peak={peak} width={9} />
        <AmMeter level={level} peak={peak} width={9} />
      </div>
    </section>
  );
});
