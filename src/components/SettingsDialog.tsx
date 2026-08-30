import React, { useState, useEffect } from 'react';
import { Settings, Volume2, Mic, SlidersHorizontal, MonitorSpeaker, X } from 'lucide-react';
import * as Tone from 'tone';
import { storageGet, storageSet } from '../utils/storage';
import { enumerateMediaDevices } from '../utils/mediaDevices';
import { isXonarU7 } from '../core/spatial/roomPlanner';
import { audioDeviceManager } from '../utils/audioDeviceManager';
import { aggregationStatus } from '../utils/audioAggregator';
import { sfuTransport } from '../core/transport/MediasoupTransport';
import { webRTCManager } from '../utils/WebRTCManager';
import { isWebMidiSupported, requestWebMidiAccess } from '../utils/midiAccess';
import { CloudStatusBadge } from './CloudStatusBadge';

/**
 * SettingsDialog – Audio-I/O & Device-Auswahl
 * -------------------------------------------
 * - Output (Soundkarte/Ausgabegerät) via `AudioContext.setSinkId()`.
 * - Input (Mikrofon/Line-in) via `getUserMedia`/`enumerateDevices()`.
 * - Sample-Rate & Buffer als Routing-Hinweis.
 * - Monitor-Routing-Flag (Stereo/DAW/Spatial).
 *
 * Alles wird in localStorage persistiert.
 */

interface SettingsStore {
  outputDeviceId: string;
  inputDeviceId: string;
  sampleRate: number;
  bufferHint: 'interactive' | 'balanced' | 'playback';
  stereoMode: 'STEREO' | 'DAW' | 'SPATIAL';
  monitorGain: number;
  transportMode: 'p2p' | 'sfu';
  midiEnabled: boolean;
}

const DEFAULT_SETTINGS: SettingsStore = {
  outputDeviceId: '',
  inputDeviceId: '',
  sampleRate: 48000,
  bufferHint: 'interactive',
  stereoMode: 'STEREO',
  monitorGain: 0.8,
  transportMode: 'p2p',
  midiEnabled: false,
};

const getStored = (): SettingsStore => {
  try {
    const raw = storageGet('audiomonastry_audio_settings');
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS;
};

export const useAudioSettings = () => {
  const [settings, setSettings] = useState<SettingsStore>(getStored);
  const persist = (next: SettingsStore) => {
    setSettings(next);
    try { storageSet('audiomonastry_audio_settings', JSON.stringify(next)); } catch { /* ignore */ }
  };
  return { settings, update: persist };
};

export const SettingsDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { settings, update } = useAudioSettings();
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [sinkSupported, setSinkSupported] = useState<boolean>(true);
  const [xonarCount, setXonarCount] = useState(0);
  const [midiSupported] = useState(() => isWebMidiSupported());
  const [midiInputCount, setMidiInputCount] = useState(0);
  const [midiOutputCount, setMidiOutputCount] = useState(0);
  const [midiError, setMidiError] = useState<string | null>(null);
  const [latency, setLatency] = useState(() => audioDeviceManager.getLatencySnapshot());

  useEffect(() => {
    if (!open) return;
    const ctx = Tone.context.rawContext as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    setSinkSupported(!!ctx?.setSinkId);

    const refresh = () => {
      enumerateMediaDevices()
        .then(devs => {
          const outs = devs.filter(d => d.kind === 'audiooutput');
          setOutputDevices(outs);
          setInputDevices(devs.filter(d => d.kind === 'audioinput'));
          setXonarCount(outs.filter(d => isXonarU7(d.label || d.deviceId)).length);
          setLatency(audioDeviceManager.getLatencySnapshot());
        })
        .catch(() => { /* Permission/Hardware nicht verfügbar */ });
    };
    refresh();
    audioDeviceManager.startMonitoring();
    const off = audioDeviceManager.onDeviceChange(() => refresh());
    return () => {
      off();
      audioDeviceManager.stopMonitoring();
    };
  }, [open]);

  const applyOutput = async (deviceId: string) => {
    update({ ...settings, outputDeviceId: deviceId });
    try {
      await audioDeviceManager.applyOutput(deviceId);
    } catch (e) {
      console.warn('setSinkId fehlgeschlagen:', (e as Error).message);
    }
  };

  const applyInput = async (deviceId: string) => {
    update({ ...settings, inputDeviceId: deviceId });
    // Geräte-Wahl wird beim nächsten startLocalAudio genutzt; hier sofort
    // testen, damit Permission-/Device-Fehler sichtbar sind.
    await audioDeviceManager.applyInput(deviceId);
  };

  const applyMidi = async (enabled: boolean) => {
    update({ ...settings, midiEnabled: enabled });
    if (!enabled) { setMidiInputCount(0); setMidiOutputCount(0); return; }
    try {
      const info = await requestWebMidiAccess(true);
      setMidiInputCount(info.inputs);
      setMidiOutputCount(info.outputs);
      setMidiError(null);
    } catch (e) {
      setMidiError((e as Error).message);
    }
  };

  const applyTransportMode = async (mode: 'p2p' | 'sfu') => {
    update({ ...settings, transportMode: mode });
    try {
      if (mode === 'sfu') {
        await sfuTransport.connect('studio-session', 'local-user');
        // Session-/Plugin-State-Sync laeuft weiter ueber den Signaling-Socket,
        // nur der Media-Pfad wechselt auf die SFU (Producer/Consumer).
        webRTCManager.setSfuMode(true, sfuTransport);
      } else {
        webRTCManager.setSfuMode(false, sfuTransport);
        sfuTransport.disconnect();
      }
    } catch (e) {
      console.warn('SFU-Transport nicht verfügbar:', (e as Error).message);
    }
  };

  if (!open) return null;

  return (
    <div
      role="button"
      tabIndex={-1}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label="Audio / I-O Einstellungen" className="w-full max-w-2xl bg-neutral-900 border border-neutral-700 rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-black text-white tracking-widest flex items-center gap-2">
            <Settings className="w-5 h-5 text-purple-500" /> AUDIO / I/O
          </h2>
          <button type="button" onClick={onClose} aria-label="Einstellungen schließen" autoFocus className="text-neutral-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        {/* Output */}
        <div className="mb-5">
          <label className="text-xs font-bold text-neutral-400 flex items-center gap-1.5 mb-2 uppercase tracking-wider">
            <Volume2 className="w-3.5 h-3.5 text-emerald-500" /> Ausgabe (Soundkarte)
          </label>
          {!sinkSupported && <p className="text-[10px] text-amber-500 mb-1">Nur Browser-Umleitung; Soundcard muss im Browser gesetzt sein.</p>}
          <select
            className="w-full bg-neutral-800 text-white p-2 rounded border border-neutral-700"
            value={settings.outputDeviceId}
            onChange={e => applyOutput(e.target.value)}
          >
            <option value="">Browser-Standard</option>
            {outputDevices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || 'Audio-Ausgabegerät'}</option>
            ))}
          </select>
          <p className="text-[10px] text-neutral-500 mt-1 font-mono">
            Engine: {latency.state} · {latency.sampleRate || '—'} Hz · Base {latency.baseLatencyMs.toFixed(1)} ms · Out {latency.outputLatencyMs.toFixed(1)} ms · RT {latency.roundTripMs.toFixed(1)} ms
            <span className="text-neutral-600"> (Browser-Metriken, keine Device-Garantie)</span>
          </p>
          <p className="text-[10px] text-neutral-600 mt-1 font-mono">
            Native Runtime (cpal/WASAPI/CoreAudio/PipeWire): Desktop-Build erforderlich – im Browser nicht aktiv.
          </p>
          <div className="mt-2"><CloudStatusBadge /></div>
          {xonarCount > 0 && (
            <p className="text-[10px] text-lime-400 mt-1 font-mono">
              ✓ {xonarCount}× ASUS Xonar U7 erkannt (8 Kanäle je Gerät) – Spatial 12.x/18.x/24.x über den RAUMPLAN im Spatial-Modul zuweisen.
              {xonarCount < 3 && ' Für 24.x werden 3–4 U7 benötigt (OS-Aggregation: ASIO4ALL / PipeWire Combine-Sink).'}
            </p>
          )}
          {(() => {
            const agg = aggregationStatus();
            return (
              <details className="mt-2 text-[10px] text-neutral-400">
                <summary className="cursor-pointer font-mono text-neutral-300">
                  OS-Aggregation ({agg.os.toUpperCase()}) · Cross-Origin-Isolation:{' '}
                  <span className={agg.crossOriginIsolated ? 'text-emerald-400' : 'text-amber-400'}>
                    {agg.crossOriginIsolated ? 'AKTIV (SAB/WebGPU-Threads ✓)' : 'INAKTIV (Header fehlen)'}
                  </span>
                </summary>
                <div className="mt-2 space-y-1">
                  <p className="font-bold text-neutral-300">{agg.guide.title}</p>
                  {agg.guide.steps.map((s) => <p key={s}>{s}</p>)}
                  {agg.guide.command && <p className="font-mono text-lime-400">{agg.guide.command}</p>}
                </div>
              </details>
            );
          })()}
        </div>

        {/* Input */}
        <div className="mb-5">
          <label className="text-xs font-bold text-neutral-400 flex items-center gap-1.5 mb-2 uppercase tracking-wider">
            <Mic className="w-3.5 h-3.5 text-rose-500" /> Eingang (Mikro/Line)
          </label>
          <select
            className="w-full bg-neutral-800 text-white p-2 rounded border border-neutral-700"
            value={settings.inputDeviceId}
            onChange={e => applyInput(e.target.value)}
          >
            <option value="">System-Standard</option>
            {inputDevices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || 'Audio-Eingabegerät'}</option>
            ))}
          </select>
        </div>

        {/* Audio-Qualität */}
        <div className="grid grid-cols-2 gap-4 mb-5">
          <div>
            <label className="text-xs font-bold text-neutral-400 flex items-center gap-1.5 mb-2 uppercase"><SlidersHorizontal className="w-3.5 h-3.5 text-blue-500" /> Sample-Rate</label>
            <select
              className="w-full bg-neutral-800 text-white p-2 rounded border border-neutral-700"
              value={settings.sampleRate}
              onChange={e => update({ ...settings, sampleRate: Number(e.target.value) })}
            >
              <option value={44100}>44,1 kHz (Standard)</option>
              <option value={48000}>48 kHz (Film/DAW)</option>
              <option value={96000}>96 kHz (High-End)</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-bold text-neutral-400 flex items-center gap-1.5 mb-2 uppercase"><SlidersHorizontal className="w-3.5 h-3.5 text-blue-500" /> Latenz-Profil</label>
            <select
              className="w-full bg-neutral-800 text-white p-2 rounded border border-neutral-700"
              value={settings.bufferHint}
              onChange={e => update({ ...settings, bufferHint: e.target.value as SettingsStore['bufferHint'] })}
            >
              <option value="interactive">Niedrig (Live/DJ)</option>
              <option value="balanced">Ausgeglichen</option>
              <option value="playback">Hoch (Mastering)</option>
            </select>
          </div>
        </div>

        {/* Kollaborations-Transport */}
        <div className="mb-5">
          <label className="text-xs font-bold text-neutral-400 flex items-center gap-1.5 mb-2 uppercase tracking-wider">
            <Mic className="w-3.5 h-3.5 text-purple-500" /> Kollaborations-Transport
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(['p2p', 'sfu'] as const).map(mode => (
              <button type="button"
                key={mode}
                onClick={() => applyTransportMode(mode)}
                aria-pressed={settings.transportMode === mode}
                className={`p-2 rounded border text-xs font-bold tracking-wider uppercase ${
                  settings.transportMode === mode ? 'bg-purple-900/30 border-purple-500/60 text-purple-300' : 'bg-neutral-800 border-neutral-700 text-neutral-500'
                }`}
              >
                {mode === 'p2p' ? 'P2P (WebRTC)' : 'SFU (Mediasoup)'}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-neutral-500 mt-1">
            SFU verbindet den Mediasoup-Transport (10+-User-skalierbar). Session-Sync läuft aktuell noch über P2P – volle SFU-Verdrahtung folgt.
          </p>
        </div>

        {/* MIDI */}
        <div className="mb-5">
          <label className="text-xs font-bold text-neutral-400 flex items-center gap-1.5 mb-2 uppercase tracking-wider">
            <Mic className="w-3.5 h-3.5 text-lime-500" /> MIDI (Web MIDI)
          </label>
          <div className="flex items-center gap-3">
            <button type="button"
              onClick={() => applyMidi(!settings.midiEnabled)}
              disabled={!midiSupported}
              aria-pressed={settings.midiEnabled}
              className={`px-3 py-2 rounded border text-xs font-bold uppercase tracking-wider ${
                settings.midiEnabled ? 'bg-lime-900/30 border-lime-500/60 text-lime-300' : 'bg-neutral-800 border-neutral-700 text-neutral-500'
              } disabled:opacity-40`}
            >
              {settings.midiEnabled ? 'MIDI AN' : 'MIDI AUS'}
            </button>
            <span className="text-[10px] text-neutral-500 font-mono">
              {midiError ?? (settings.midiEnabled ? `${midiInputCount} In / ${midiOutputCount} Out` : 'nicht verbunden')}
            </span>
          </div>
          <p className="text-[10px] text-neutral-500 mt-1">
            SysEx-fähig (nur Chromium/Edge). Für Safari/iOS den midi-bridge-Sidecar verwenden.
          </p>
        </div>

        {/* Routing / Ausgang */}
        <div className="mb-5">
          <label className="text-xs font-bold text-neutral-400 flex items-center gap-1.5 mb-2 uppercase"><MonitorSpeaker className="w-3.5 h-3.5 text-cyan-500" /> Master-Ausgangsmodus</label>
          <div className="grid grid-cols-3 gap-2">
            {(['STEREO', 'DAW', 'SPATIAL'] as const).map(mode => (
              <button type="button"
                key={mode}
                onClick={() => update({ ...settings, stereoMode: mode })}
                className={`p-2 rounded border text-xs font-bold tracking-wider uppercase ${
                  settings.stereoMode === mode ? 'bg-cyan-900/30 border-cyan-500/60 text-cyan-300' : 'bg-neutral-800 border-neutral-700 text-neutral-500'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {/* Monitor-Gain */}
        <div>
          <label className="text-xs font-bold text-neutral-400 mb-2 uppercase flex items-center justify-between">
            <span className="flex items-center gap-1.5"><MonitorSpeaker className="w-3.5 h-3.5 text-purple-500" /> Monitor-Kopfhörer-Pegel</span>
            <span className="text-purple-400">{Math.round(settings.monitorGain * 100)}%</span>
          </label>
          <input
            type="range" min="0" max="1" step="0.01" value={settings.monitorGain}
            onChange={e => update({ ...settings, monitorGain: Number.parseFloat(e.target.value) })}
            className="w-full accent-purple-500"
          />
        </div>
      </div>
    </div>
  );
};
