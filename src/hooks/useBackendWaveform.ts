import { useEffect, useRef, useState } from 'react';
import { webRTCManager } from '../utils/WebRTCManager';

/** R16 §P3: peak/RMS of the finished backend master block. Numbers only. */
export interface BackendWaveformValue {
  frame: number;
  frames: number;
  sampleRate: number;
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
  clipped: number;
  receivedAt: number;
}

export type BackendWaveformState = 'missing' | 'stale' | 'live';
export const WAVEFORM_STALE_MS = 300;

/**
 * A value is only "live" while it is recent. Older or absent telemetry must be shown
 * as such; the UI is not allowed to fall back to a local meter reading.
 */
export function waveformState(value: BackendWaveformValue | null, now = Date.now()): BackendWaveformState {
  if (!value || !Number.isFinite(value.receivedAt)) return 'missing';
  return now - value.receivedAt <= WAVEFORM_STALE_MS ? 'live' : 'stale';
}

/** Tolerant parse: a malformed message is ignored instead of poisoning the display. */
export function applyWaveformMessage(
  previous: BackendWaveformValue | null,
  message: unknown,
  now = Date.now(),
): BackendWaveformValue | null {
  if (!message || typeof message !== 'object') return previous;
  const m = message as Record<string, unknown>;
  if (m.type !== 'waveform-peak') return previous;
  const num = (key: string): number | null => (typeof m[key] === 'number' && Number.isFinite(m[key]) ? m[key] as number : null);
  const peakL = num('peakL'); const peakR = num('peakR');
  const rmsL = num('rmsL'); const rmsR = num('rmsR');
  const frame = num('frame'); const frames = num('frames'); const sampleRate = num('sampleRate');
  const clipped = num('clipped');
  if (peakL === null || peakR === null || rmsL === null || rmsR === null
    || frame === null || frames === null || sampleRate === null || clipped === null) return previous;
  return { peakL, peakR, rmsL, rmsR, frame, frames, sampleRate, clipped, receivedAt: now };
}

/** Subscribes to the backend telemetry; returns the value plus its freshness. */
export function useBackendWaveform(): { value: BackendWaveformValue | null; state: BackendWaveformState } {
  const [value, setValue] = useState<BackendWaveformValue | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const valueRef = useRef<BackendWaveformValue | null>(null);

  useEffect(() => {
    const off = webRTCManager.onWaveformPeak((msg) => {
      const next = applyWaveformMessage(valueRef.current, msg);
      if (next !== valueRef.current) { valueRef.current = next; setValue(next); setNow(Date.now()); }
    });
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => { off(); window.clearInterval(timer); };
  }, []);

  // Freshness is derived during render from the last reception time, so no effect
  // writes state just to age a value out.
  return { value, state: waveformState(value, now) };
}
