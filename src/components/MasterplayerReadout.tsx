import React, { useEffect, useState } from 'react';
import { audioEngine } from '../utils/audioEngine';

/**
 * UI2-P1-002 · Masterplayer = reine Ansicht
 * Zeit, Takt.Schlag und Lautheit des Main-Ausgangs. Keine Bedienelemente:
 * Ton auf Main startet nur ▶ im mixerMONK. Abgefragt wird im UI-Takt, nie im
 * Audio-Thread; die Werte kommen aus der Engine, nicht aus lokalem UI-State.
 */
export interface TransportReadout {
  /** mm:ss */
  time: string;
  /** Takt.Schlag, 1-basiert (4/4). */
  position: string;
}

export function transportReadout(seconds: number, bpm: number, beatsPerBar = 4): TransportReadout {
  const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const beats = Math.floor((sec * tempo) / 60 + 1e-9);
  const bar = Math.floor(beats / beatsPerBar) + 1;
  const beat = (beats % beatsPerBar) + 1;
  const whole = Math.floor(sec);
  const mm = String(Math.floor(whole / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return { time: `${mm}:${ss}`, position: `${bar}.${beat}` };
}

/** LUFS-Anzeige: unter -70 (Stille/kein Messwert) als „—". */
export function lufsLabel(value: number): string {
  return Number.isFinite(value) && value > -70 && value !== 0 ? value.toFixed(1) : '—';
}

const Cell = ({ value, label, wide = false }: { value: string; label: string; wide?: boolean }) => (
  <div className={wide ? 'hidden sm:block' : undefined}>
    <div className="font-mono text-sm font-bold text-white tabular-nums">{value}</div>
    <div className="text-[7px] font-mono text-neutral-500 tracking-widest">{label}</div>
  </div>
);

export const MasterplayerReadout = React.memo(function MasterplayerReadout({
  bpm,
  isPlaying,
  pollMs = 100,
}: { bpm: number; isPlaying: boolean; pollMs?: number }) {
  const [seconds, setSeconds] = useState(0);
  const [lufs, setLufs] = useState(0);
  useEffect(() => {
    const read = () => {
      setSeconds(audioEngine.getTransportSeconds());
      setLufs(audioEngine.getLufsValue());
    };
    read();
    if (!isPlaying) return;
    const id = window.setInterval(read, pollMs);
    return () => window.clearInterval(id);
  }, [isPlaying, pollMs]);
  const r = transportReadout(seconds, bpm);
  return (
    <>
      <Cell value={r.time} label="ZEIT" />
      <Cell value={r.position} label="TAKT" />
      <Cell value={lufsLabel(lufs)} label="LUFS" wide />
    </>
  );
});
