/**
 * Capture im masterplayerMONK (IDEA-2026-10-07-A „nachträglich aufnehmen“)
 * ======================================================================
 * Ein Klick hält fest, was gerade passiert ist – ohne vorher auf Aufnahme zu
 * drücken:
 *   a) die letzten 60 s Main-Audio → WAV → still in die Bibliothek AUF DEM SERVER
 *      (`addSample`, Typ „recording“; nichts bleibt auf dem Gerät),
 *   b) die Eingaben der letzten 16 Takte → Pattern-Vorschlag (8 × 16) zum
 *      Übernehmen in den Sequencer oder zum Merken im Studio-Speicher.
 *
 * Rechte: Capture macht nur der mixerMONK-Halter (nur bei ihm spielt Main).
 * „In Sequencer übernehmen“ nur, wenn der lokale Nutzer das Sequencer-Plugin
 * (drumsamplerMONK, Step-Sequencer) hält – zentraler Lock, kein Übernehmen.
 */
import React, { useCallback, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { useSamples } from '../../context/SampleContext';
import { usePluginManager } from '../../context/PluginManagerContext';
import { webRTCManager } from '../../utils/WebRTCManager';
import { pluginOwnerOf } from '../../core/session/pluginMode';
import { personLabel, useSessionPeople } from '../../core/session/sessionPeople';
import { encodeWavFromChannels } from '../../utils/wavEncode';
import { trimLeadingSilence, trimTrailingSilence } from '../../core/capture/captureRing';
import { saveCapturePattern } from '../../core/capture/capturePatternStore';
import type { CaptureResult } from '../../core/capture/captureSession';
import { ALL_TRACKS, type TrackType } from '../../types';

/** Plugin, dessen Halter das Sequencer-Pattern ändern darf (Katalog #2, Step-Sequencer). */
export const CAPTURE_SEQUENCER_PLUGIN_ID = 'drumsampler';

const TRACK_COLORS: Readonly<Record<TrackType, string>> = {
  channel1: '#ff4a2a', channel2: '#ff9524', channel3: '#ffd43b', channel4: '#a3e635',
  channel5: '#22d3ee', channel6: '#4cc9f0', channel7: '#a78bfa', channel8: '#e879f9',
};

let patternSeq = 0;

function clock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Speichert das Audio still in der Server-Bibliothek; liefert die Länge in s oder null. */
function storeCaptureAudio(result: CaptureResult, addSample: ReturnType<typeof useSamples>['addSample'], now: Date): number | null {
  if (!result.audio) return null;
  const lead = trimLeadingSilence([result.audio.left, result.audio.right]);
  const [left, right] = trimTrailingSilence(lead);
  if (!left || left.length === 0) return null;
  const blob = encodeWavFromChannels([left, right], result.audio.sampleRate);
  const url = URL.createObjectURL(blob);
  const seconds = left.length / result.audio.sampleRate;
  const bpm = Math.round(result.bpm);
  addSample({
    id: `capture-${now.getTime()}`,
    name: `Capture ${clock(now)}`,
    category: 'mids',
    type: 'recording',
    url,
    description: `Capture: letzte ${seconds.toFixed(1)} s Main bei ${bpm} BPM`,
    tags: ['capture', `${bpm}bpm`],
    parameters: {},
  });
  return seconds;
}

export function CaptureControl({ mainHolder }: { mainHolder: boolean }) {
  const { addSample } = useSamples();
  const { pluginLocks } = usePluginManager();
  const people = useSessionPeople();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [barIndex, setBarIndex] = useState(0);
  const supported = audioEngine.isCaptureSupported();

  const disabledReason = !supported
    ? 'Capture braucht SharedArrayBuffer (Cross-Origin-Isolation) – in diesem Browser nicht verfügbar.'
    : !mainHolder
      ? 'Capture macht der Mixer-Halter'
      : null;

  const capture = useCallback(async () => {
    if (disabledReason || busy) return;
    setBusy(true);
    try {
      const now = new Date();
      const r = await audioEngine.captureNow();
      const msgs: string[] = [];
      const seconds = storeCaptureAudio(r, addSample, now);
      if (seconds !== null) msgs.push(`${seconds.toFixed(1)} s Audio still in der Bibliothek abgelegt.`);
      else if (r.audioUnavailable === 'not-running') msgs.push('Audio-Abgriff läuft noch nicht – Main einmal starten.');
      else msgs.push('Noch nichts zu hören.');
      if (r.suggestedBarIndex >= 0) {
        setResult(r);
        setBarIndex(r.suggestedBarIndex);
      } else {
        msgs.push('Keine Eingaben in den letzten 16 Takten.');
      }
      setNotice(msgs.join(' '));
    } catch (e) {
      setNotice(`Capture fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [addSample, busy, disabledReason]);

  const seqOwner = pluginOwnerOf(pluginLocks[CAPTURE_SEQUENCER_PLUGIN_ID]);
  const holdsSequencer = !!seqOwner && seqOwner === webRTCManager.userId;
  const seqHint = holdsSequencer
    ? 'Ergänzt das laufende Pattern (Step 1–16).'
    : seqOwner
      ? `Den Sequencer (drumsamplerMONK) hält ${personLabel(seqOwner, people)} – nur der Halter darf übernehmen.`
      : 'Der Sequencer (drumsamplerMONK) ist frei – erst mit OFF → STBY holen.';

  const bar = result?.bars[barIndex];
  const close = () => setResult(null);

  const apply = () => {
    if (!bar || !holdsSequencer) return;
    audioEngine.mergeCapturedBar(bar);
    setNotice(`Takt ${barIndex + 1} in den Sequencer übernommen.`);
    close();
  };

  const remember = () => {
    if (!bar || !result) return;
    const now = new Date();
    const list = saveCapturePattern({
      id: `capture-pattern-${now.getTime()}-${++patternSeq}`,
      createdAt: now.toISOString(),
      name: `Capture ${clock(now)} · Takt ${barIndex + 1}`,
      bpm: result.bpm,
      bar,
      notes: result.notes.filter((n) => n.bar === barIndex),
    });
    setNotice(`Pattern gemerkt (${list.length}/32).`);
  };

  return (
    <div className="am-cap">
      <button
        type="button"
        className="am-btn am-cap-btn"
        onClick={() => { void capture(); }}
        disabled={!!disabledReason || busy}
        title={disabledReason ?? 'Letzte 60 s Main + Eingaben der letzten 16 Takte festhalten'}
        aria-label="Capture: nachträglich aufnehmen"
      >
        {busy ? 'CAPTURE …' : '● CAPTURE'}
      </button>
      {!supported && <small className="am-hint" role="note">Capture hier nicht verfügbar (kein SharedArrayBuffer).</small>}
      {notice && <small className="am-hint" role="status" aria-live="polite">{notice}</small>}

      {result && bar && (
        <div className="am-box am-cap-pop" role="dialog" aria-label="Capture-Pattern-Vorschlag">
          <div className="am-cap-head">
            <b>Pattern-Vorschlag</b>
            <span className="am-hint">{Math.round(result.bpm)} BPM</span>
            <span className="am-cap-nav">
              <button type="button" className="am-btn" aria-label="Takt zurück" disabled={barIndex <= 0} onClick={() => setBarIndex((i) => Math.max(0, i - 1))}>‹</button>
              <span aria-live="polite">Takt {barIndex + 1} / {result.bars.length}</span>
              <button type="button" className="am-btn" aria-label="Takt vor" disabled={barIndex >= result.bars.length - 1} onClick={() => setBarIndex((i) => Math.min(result.bars.length - 1, i + 1))}>›</button>
            </span>
          </div>
          <div className="am-cap-grid" role="table" aria-label={`Takt ${barIndex + 1}: 8 Spuren × 16 Steps`}>
            {ALL_TRACKS.map((t, row) => (
              <div key={t} role="row" className="am-cap-row">
                <span className="am-cap-lab" role="rowheader">{row + 1}</span>
                {bar[t].map((on, i) => (
                  <span key={i} role="cell" aria-label={`Spur ${row + 1}, Step ${i + 1}: ${on ? 'an' : 'aus'}`} className={`am-cap-cell ${on ? 'am-on' : ''} ${i % 4 === 0 ? 'am-beat' : ''}`}
                    style={{ ['--sc' as string]: TRACK_COLORS[t] }} />
                ))}
              </div>
            ))}
          </div>
          <small className="am-hint">{seqHint}</small>
          <div className="am-cap-act">
            <button type="button" className="am-btn am-pri" disabled={!holdsSequencer} onClick={apply} title={seqHint}>In Sequencer übernehmen</button>
            <button type="button" className="am-btn" onClick={remember}>Als Pattern merken</button>
            <button type="button" className="am-btn" onClick={close}>Verwerfen</button>
          </div>
        </div>
      )}
    </div>
  );
}
