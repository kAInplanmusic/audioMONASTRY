/**
 * audioMONASTRY · Sampler-Capture (UI-2026-11-06-003)
 * ==================================================
 * Der CAPTURE-Knopf im syntisamplerMONK war ein Fake: `setTimeout(600)` und
 * „Pads 1–4 füllen“. Der echte Abgriff existiert längst
 * (`audioEngine.captureNow()` → `AudioCaptureTap`, letzte 60 s Main-Audio);
 * hier wird aus diesem Ergebnis ein WAV, das ein Pad halten kann.
 */
import { encodeWavFromChannels } from '../../utils/wavEncode';
import { trimLeadingSilence, trimTrailingSilence } from '../capture/captureRing';
import type { CaptureResult } from '../capture/captureSession';

export interface PadClip {
  blob: Blob;
  /** Länge des hörbaren Ausschnitts in Sekunden. */
  seconds: number;
}

export type CaptureOutcome =
  | { ok: true; clip: PadClip }
  | { ok: false; reason: string };

type CaptureAudioInput = Pick<CaptureResult, 'audio' | 'audioUnavailable'>;

/**
 * Schneidet den Abgriff auf den hörbaren Teil und kodiert ihn als WAV.
 * Kein stiller Fehlschlag: der Grund steht im Ergebnis und geht in die Anzeige.
 */
export function captureToClip(result: CaptureAudioInput): CaptureOutcome {
  if (!result.audio) {
    if (result.audioUnavailable === 'unsupported') {
      return { ok: false, reason: 'Capture hier nicht verfügbar (kein SharedArrayBuffer / Cross-Origin-Isolation).' };
    }
    if (result.audioUnavailable === 'not-running') {
      return { ok: false, reason: 'Audio-Abgriff läuft noch nicht – Main einmal starten.' };
    }
    return { ok: false, reason: 'Noch nichts zu hören.' };
  }
  const { left, right, sampleRate } = result.audio;
  if (!left || left.length === 0 || !(sampleRate > 0)) {
    return { ok: false, reason: 'Noch nichts zu hören.' };
  }
  const lead = trimLeadingSilence([left, right ?? left]);
  const [trimmedLeft, trimmedRight] = trimTrailingSilence(lead);
  if (!trimmedLeft || trimmedLeft.length === 0) {
    return { ok: false, reason: 'Aufnahme ist still – nichts in das Pad geschrieben.' };
  }
  return {
    ok: true,
    clip: {
      blob: encodeWavFromChannels([trimmedLeft, trimmedRight ?? trimmedLeft], sampleRate),
      seconds: trimmedLeft.length / sampleRate,
    },
  };
}
