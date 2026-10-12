/**
 * Capture im mastergraphMONK (IDEA-2026-10-07-A „nachträglich aufnehmen“)
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
 *
 * IDEA-2026-10-07-A-F1:
 *  - Vor der Übernahme wird das Sequencer-Ziel BESTÄTIGT (Bestätigungs-Dialog
 *    nennt Plugin, Halter, Takt und was wohin geht); der Lock wird beim
 *    Bestätigen erneut geprüft.
 *  - drumsamplerMONK-Schläge gehen in dessen Drum-Patterns (gemeinsame Quelle
 *    der Pattern-Ansicht, `captureDrumPatterns.ts`); Kanal-Pads/Noten ins
 *    Engine-Pattern (Anzeige „Kanal-Pattern · Engine“ im drumsamplerMONK).
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
import type { CaptureDrumHit } from '../../core/capture/quantizeCapture';
import {
  CAPTURE_DRUM_MERGE_EVENT,
  drumHitsOfBar,
  mergeCaptureDrumHits,
  type CaptureDrumMergeDetail,
} from '../../core/capture/captureDrumPatterns';
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { DRUM_KITS } from '../../data/drumKits';
import { ALL_TRACKS, type TrackType } from '../../types';

/** Plugin, dessen Halter das Sequencer-Pattern ändern darf (Katalog #2, Step-Sequencer). */
export const CAPTURE_SEQUENCER_PLUGIN_ID = 'drumsampler';

const TRACK_COLORS: Readonly<Record<TrackType, string>> = {
  channel1: '#ff4a2a', channel2: '#ff9524', channel3: '#ffd43b', channel4: '#a3e635',
  channel5: '#22d3ee', channel6: '#4cc9f0', channel7: '#a78bfa', channel8: '#e879f9',
};

let patternSeq = 0;

/** Anzeigename eines Drum-Sounds (Kit · Sound). */
function drumLabel(kitId: string, soundId: string): string {
  const kit = DRUM_KITS.find((k) => k.id === kitId);
  const sound = kit?.sounds.find((x) => x.id === soundId);
  return `${kit?.name ?? kitId} · ${sound?.name ?? soundId}`;
}

/** Zeilen (Kit/Sound) eines Takts mit ihren 16 Steps. */
function drumRows(hits: readonly CaptureDrumHit[]): Array<{ key: string; label: string; steps: boolean[] }> {
  const rows = new Map<string, { key: string; label: string; steps: boolean[] }>();
  for (const h of hits) {
    const key = `${h.kitId}:${h.soundId}`;
    let row = rows.get(key);
    if (!row) {
      row = { key, label: drumLabel(h.kitId, h.soundId), steps: new Array<boolean>(16).fill(false) };
      rows.set(key, row);
    }
    if (h.step >= 0 && h.step < 16) row.steps[h.step] = true;
  }
  return [...rows.values()];
}

/**
 * Drum-Schläge in die drumsamplerMONK-Patterns übernehmen. Offenes Terminal →
 * es übernimmt selbst (aktuelle Bank, sofort sichtbar); sonst direkt in die
 * Plugin-Settings der Session (Bank A). Liefert die Ziel-Bank.
 */
function applyDrumHits(hits: CaptureDrumHit[]): 'A' | 'B' {
  const detail: CaptureDrumMergeDetail = { hits, handled: false };
  window.dispatchEvent(new CustomEvent<CaptureDrumMergeDetail>(CAPTURE_DRUM_MERGE_EVENT, { detail }));
  if (detail.handled) return detail.bank ?? 'A';
  const saved = readPluginSettings<{ patterns?: Record<string, boolean[]> } & Record<string, unknown>>('drumsampler', { legacyKey: 'drum-state' }) ?? {};
  const merged = mergeCaptureDrumHits(saved.patterns ?? {}, hits, 'A', 16);
  writePluginSettings('drumsampler', { ...saved, patterns: merged.patterns });
  return 'A';
}

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
  /** IDEA-2026-10-07-A-F1: Bestätigung des Sequencer-Ziels offen? */
  const [confirming, setConfirming] = useState(false);
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
        setConfirming(false);
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
  const barDrumHits = result ? drumHitsOfBar(result.drumHits ?? [], barIndex) : [];
  const barDrumRows = drumRows(barDrumHits);
  const engineSteps = bar ? ALL_TRACKS.reduce((n, t) => n + bar[t].filter(Boolean).length, 0) : 0;
  const close = () => { setResult(null); setConfirming(false); };

  /** Schritt 1: Ziel zur Bestätigung anzeigen (nur für den Sequencer-Halter). */
  const requestApply = () => {
    if (!bar || !holdsSequencer) return;
    setConfirming(true);
  };

  /** Schritt 2: bestätigt → übernehmen (Lock wird erneut geprüft). */
  const confirmApply = () => {
    if (!bar || !holdsSequencer) { setConfirming(false); return; }
    const parts: string[] = [];
    if (engineSteps > 0) {
      audioEngine.mergeCapturedBar(bar);
      parts.push(`${engineSteps} Kanal-Steps`);
    }
    if (barDrumHits.length > 0) {
      const bank = applyDrumHits(barDrumHits.map((h) => ({ ...h, bar: 0 })));
      parts.push(`${barDrumHits.length} Drum-Steps (Bank ${bank})`);
    }
    setNotice(`Takt ${barIndex + 1} in den Sequencer (drumsamplerMONK) übernommen: ${parts.join(', ') || 'keine Steps'}.`);
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
      drumHits: barDrumHits,
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
              <button type="button" className="am-btn" aria-label="Takt zurück" disabled={barIndex <= 0} onClick={() => { setConfirming(false); setBarIndex((i) => Math.max(0, i - 1)); }}>‹</button>
              <span aria-live="polite">Takt {barIndex + 1} / {result.bars.length}</span>
              <button type="button" className="am-btn" aria-label="Takt vor" disabled={barIndex >= result.bars.length - 1} onClick={() => { setConfirming(false); setBarIndex((i) => Math.min(result.bars.length - 1, i + 1)); }}>›</button>
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
            {barDrumRows.map((row) => (
              <div key={row.key} role="row" className="am-cap-row">
                <span className="am-cap-lab" role="rowheader" title={row.label}>D</span>
                {row.steps.map((on, i) => (
                  <span key={i} role="cell" aria-label={`Drum ${row.label}, Step ${i + 1}: ${on ? 'an' : 'aus'}`} className={`am-cap-cell ${on ? 'am-on' : ''} ${i % 4 === 0 ? 'am-beat' : ''}`}
                    style={{ ['--sc' as string]: '#f97316' }} />
                ))}
              </div>
            ))}
          </div>
          <small className="am-hint">{seqHint}</small>
          {result.transportStartSec == null && <small className="am-hint">Ohne laufenden Transport: Raster ab der ersten Eingabe.</small>}
          {confirming ? (
            <div className="am-box" role="alertdialog" aria-label="Sequencer-Ziel bestätigen">
              <b>Ziel bestätigen</b>
              <small className="am-hint">
                Takt {barIndex + 1} → drumsamplerMONK (Step-Sequencer, gehalten von dir), Step 1–16, ergänzt per ODER:
                {' '}{barDrumHits.length} Drum-Steps in die Drum-Pattern-Ansicht, {engineSteps} Kanal-Steps ins Kanal-Pattern.
              </small>
              <div className="am-cap-act">
                <button type="button" className="am-btn am-pri" disabled={!holdsSequencer} onClick={confirmApply}>Übernahme bestätigen</button>
                <button type="button" className="am-btn" onClick={() => setConfirming(false)}>Abbrechen</button>
              </div>
            </div>
          ) : (
            <div className="am-cap-act">
              <button type="button" className="am-btn am-pri" disabled={!holdsSequencer} onClick={requestApply} title={seqHint}>In Sequencer übernehmen</button>
              <button type="button" className="am-btn" onClick={remember}>Als Pattern merken</button>
              <button type="button" className="am-btn" onClick={close}>Verwerfen</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
