import { useEffect, useMemo, useState } from 'react';
import { webRTCManager } from '../utils/WebRTCManager';
import { storageGetJson, storageSetJson } from '../utils/storage';
import {
  isStreamFps,
  isStreamPresetId,
  resolveStreamSize,
  sanitizeOutputDisplay,
  type OutputDisplay,
  type StreamFps,
  type StreamPresetId,
  type StreamSize,
} from '../core/visual/streamResolution';

/**
 * Stream-Auflösung des Visual-Streams (Ghostuser 6 / Beamer).
 * - Auswahl (Preset + Bildrate) gehört dem Sender und bleibt auf diesem Gerät
 *   gespeichert (Komfort, kein Session-Zustand),
 * - „Auto" folgt dem Bildschirm, den der Beamer (/visual-out) meldet,
 * - die Größe ist unabhängig vom Format des Senders (Handy/Pad/PC).
 */

const KEY = 'am.visualStream.settings';

interface Saved { preset?: unknown; fps?: unknown }

function load(): { preset: StreamPresetId; fps: StreamFps } {
  const raw = storageGetJson<Saved>(KEY) ?? {};
  return {
    preset: isStreamPresetId(raw.preset) ? raw.preset : 'auto',
    fps: isStreamFps(raw.fps) ? raw.fps : 30,
  };
}

/** Bildschirm des Visual-Empfängers aus der Server-Meldung (erster visual-out). */
export function visualReceiverFrom(msg: unknown): OutputDisplay | null {
  const list = (msg as { displays?: unknown[] } | null)?.displays;
  if (!Array.isArray(list)) return null;
  const entry = list.find((d) => (d as { mode?: unknown })?.mode === 'visual-out');
  return sanitizeOutputDisplay(entry);
}

export interface StreamResolutionState {
  preset: StreamPresetId;
  fps: StreamFps;
  receiver: OutputDisplay | null;
  size: StreamSize;
  setPreset: (p: StreamPresetId) => void;
  setFps: (f: StreamFps) => void;
}

export function useStreamResolution(): StreamResolutionState {
  const [settings, setSettings] = useState(load);
  const [receiver, setReceiver] = useState<OutputDisplay | null>(null);

  useEffect(() => webRTCManager.onOutputDisplays((msg) => setReceiver(visualReceiverFrom(msg))), []);
  useEffect(() => { storageSetJson(KEY, settings); }, [settings]);

  const size = useMemo(() => resolveStreamSize(settings.preset, receiver), [settings.preset, receiver]);
  return {
    preset: settings.preset,
    fps: settings.fps,
    receiver,
    size,
    setPreset: (preset) => setSettings((s) => ({ ...s, preset })),
    setFps: (fps) => setSettings((s) => ({ ...s, fps })),
  };
}
