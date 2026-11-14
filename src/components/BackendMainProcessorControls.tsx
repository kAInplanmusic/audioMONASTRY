import React, { useEffect, useState } from 'react';
import { readPluginSettings, writePluginSettings, flushPluginSettings } from '../utils/pluginSettings';
import { webRTCManager } from '../utils/WebRTCManager';
import { isMainProcessor, MAIN_SOURCE_IDS } from '../core/audio/backendMainProcessorSettings';

type Values = Record<string, unknown>;
const controls: Record<string, [string, string, number, number, number, number][]> = {
  eq: [['low', 'Tiefen dB', -24, 24, 0.5, 0], ['mid', 'Mitten dB', -24, 24, 0.5, 0], ['high', 'Höhen dB', -24, 24, 0.5, 0]],
  dsp: [['cutoff', 'Tiefpass Hz', 20, 20000, 10, 1000], ['resonance', 'Resonanz', 0, 1, 0.01, 0], ['depth', 'Filtertiefe', 0, 1, 0.01, 0], ['drive', 'Drive', 0, 1, 0.01, 0]],
  effect: [['wet', 'Effektanteil', 0, 1, 0.01, 0], ['feedback', 'Feedback', 0, 0.95, 0.01, 0], ['rate', 'Rate', 0, 1, 0.01, 0.3], ['depth', 'Tiefe', 0, 1, 0.01, 0]],
  spatial: [['pan', 'Panorama', -1, 1, 0.01, 0], ['width', 'Stereobreite', 0, 2, 0.01, 1]],
  master: [['gain', 'Summenpegel', 0, 2, 0.01, 1]],
};
function saved(id: string): Values { return readPluginSettings<Values>(id, { section: 'backendMain' }) ?? {}; }

/** Controls only the canonical Main settings path; no local audio or monitor mutations. */
export function BackendMainProcessorControls({ pluginId, disabled }: { pluginId: string; disabled: boolean }) {
  const [values, setValues] = useState<Values>(() => saved(pluginId));
  const [selected, setSelected] = useState<string>('drop');
  useEffect(() => {
    const refresh = () => setValues(saved(pluginId));
    const offSettings = webRTCManager.onPluginSettings(msg => { if (msg.pluginId === pluginId) refresh(); });
    const offSession = webRTCManager.onSessionState(refresh);
    return () => { offSettings(); offSession(); };
  }, [pluginId]);
  if (!isMainProcessor(pluginId)) return null;
  const change = (patch: Values) => {
    if (disabled) return;
    const defaults = Object.fromEntries((controls[pluginId] ?? []).map(([key, , , , , fallback]) => [key, fallback]));
    const next = { ...defaults, ...saved(pluginId), ...values, ...patch };
    setValues(next);
    writePluginSettings(pluginId, next, { section: 'backendMain' });
    flushPluginSettings(pluginId);
  };
  const field = (key: string, label: string, min: number, max: number, step: number, fallback: number, current: Values, write: (next: Values) => void) => (
    <label key={key} className="inline-flex items-center gap-2 p-2 text-xs">{label}
      <input type="number" aria-label={`${pluginId} Main ${label}`} min={min} max={max} step={step}
        className="am-input w-20" value={typeof current[key] === 'number' ? current[key] as number : fallback}
        onChange={e => { const n = e.target.valueAsNumber; if (Number.isFinite(n)) write({ [key]: Math.max(min, Math.min(max, n)) }); }} />
    </label>
  );
  const sources = values.sources as Record<string, Values> | undefined;
  const channel = sources?.[selected] ?? {};
  const writeChannel = (patch: Values) => change({ sources: { ...sources, [selected]: { ...channel, ...patch } } });
  return <fieldset disabled={disabled} data-main-processor={pluginId} className="border border-white/20 rounded p-2 my-2">
    <legend>Gemeinsamer Main · {pluginId}MONK{pluginId === 'master' ? ' · Gain' : ''}</legend>
    {(pluginId === 'eq' || pluginId === 'dsp') && <label className="text-xs">Quelle <select aria-label={`${pluginId} Main Quelle`} value={(values.targets as string[] | undefined)?.[0] ?? 'all'} onChange={e => change({ targets: e.target.value === 'all' ? [] : [e.target.value] })}>
      <option value="all">Alle Quellen</option>{MAIN_SOURCE_IDS.map(id => <option key={id} value={id}>{id}MONK</option>)}
    </select></label>}
    {(controls[pluginId] ?? []).map(args => field(...args, values, change))}
    {pluginId === 'mixer' && <>
      <select aria-label="mixer Main Quelle" value={selected} onChange={e => setSelected(e.target.value)}>{MAIN_SOURCE_IDS.map(id => <option key={id} value={id}>{id}MONK</option>)}</select>
      {field('gain', 'Kanalpegel', 0, 2, 0.01, 1, channel, writeChannel)}
      {field('pan', 'Panorama', -1, 1, 0.01, 0, channel, writeChannel)}
      {field('sendEffect', 'Effect-Send', 0, 1, 0.01, 0, channel, writeChannel)}
      {field('sendSpatial', 'Spatial-Send', 0, 1, 0.01, 0, channel, writeChannel)}
      <label className="text-xs">Stumm <input aria-label="mixer Main Stumm" type="checkbox" checked={channel.mute === true} onChange={e => writeChannel({ mute: e.target.checked })} /></label>
    </>}
    {(pluginId === 'effect' || pluginId === 'spatial') && <p className="text-xs opacity-70">Die Sends wählt der DJ im Main-Kanalzug von mixerMONK.</p>}
  </fieldset>;
}
