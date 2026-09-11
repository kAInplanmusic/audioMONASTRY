import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { storageGet, storageSet } from '../../utils/storage';
import type { TrackType } from '../../types';
import {
  defaultOptionalDspPresets,
  optionalDspSpec,
  parseOptionalDspPresets,
  serializeOptionalDspPresets,
  type OptionalDspBlock,
  type OptionalDspPreset,
} from '../../core/dsp/dspPresets';

/**
 * UI-Pfad der optionalen DSP-Bausteine (FEAT-P3-002).
 *
 * Der Regler schreibt in den **hörbaren V2-Pfad**: audioEngine → V2LiveSink →
 * v2-sink-processor (AudioWorklet). Presets werden über das Schema
 * (`core/dsp/dspPresets.ts`) serialisiert und lokal persistiert.
 */

const STORAGE_KEY = 'audiomonastry_optional_dsp_presets';

/** Kanal je Quell-Baustein (die beiden Quellen brauchen einen V2-Kanal). */
const SOURCE_CHANNEL: Record<'phase-distortion' | 'electric-piano', TrackType> = {
  'phase-distortion': 'channel5',
  'electric-piano': 'channel4',
};

function loadPresets(): Record<OptionalDspBlock, OptionalDspPreset> {
  const base = defaultOptionalDspPresets();
  const raw = storageGet(STORAGE_KEY);
  if (!raw) return base;
  try {
    for (const preset of parseOptionalDspPresets(raw)) base[preset.block] = preset;
  } catch (e) {
    // Kaputte Persistenz darf die UI nicht blockieren, wird aber gemeldet.
    console.warn('[optional-dsp] Presets konnten nicht gelesen werden – Defaults aktiv:', e);
  }
  return base;
}

/** Schreibt ein Preset in den hörbaren V2-Pfad. */
export function applyOptionalDspPreset(preset: OptionalDspPreset): void {
  switch (preset.block) {
    case 'mod-matrix':
      audioEngine.setOptionalModMatrix({ enabled: preset.enabled, rate: preset.params.rate, depth: preset.params.depth });
      break;
    case 'hq-reverb':
      audioEngine.setOptionalReverb({
        enabled: preset.enabled,
        mix: preset.params.mix,
        decayS: preset.params.decayS,
        damping: preset.params.damping,
        sizeScale: preset.params.sizeScale,
      });
      break;
    case 'phase-distortion': {
      const channel = SOURCE_CHANNEL['phase-distortion'];
      if (preset.enabled) {
        audioEngine.setOptionalSynthVoice(channel, 'phase', preset.params.freq, { amount: preset.params.amount });
      } else {
        audioEngine.resetOptionalSynthVoice(channel);
      }
      break;
    }
    case 'electric-piano': {
      const channel = SOURCE_CHANNEL['electric-piano'];
      if (preset.enabled) {
        audioEngine.setOptionalSynthVoice(channel, 'epiano', preset.params.freq, { modIndex: preset.params.modIndex });
      } else {
        audioEngine.resetOptionalSynthVoice(channel);
      }
      break;
    }
  }
}

interface OptionalDspPanelProps {
  block: OptionalDspBlock;
  className?: string;
}

export const OptionalDspPanel: React.FC<OptionalDspPanelProps> = ({ block, className = '' }) => {
  const spec = useMemo(() => optionalDspSpec(block), [block]);
  const [preset, setPreset] = useState<OptionalDspPreset>(() => loadPresets()[block]);

  // Persistierten Zustand beim Einhängen hörbar machen (einmalig).
  useEffect(() => {
    applyOptionalDspPreset(loadPresets()[block]);
  }, [block]);

  const publish = useCallback((next: OptionalDspPreset) => {
    setPreset(next);
    applyOptionalDspPreset(next);
    const all = loadPresets();
    all[block] = next;
    storageSet(STORAGE_KEY, serializeOptionalDspPresets(Object.values(all)));
  }, [block]);

  const setParam = (name: string, value: number) => publish({ ...preset, params: { ...preset.params, [name]: value } });

  return (
    <div className={`rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 ${className}`} data-optional-dsp={block}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => publish({ ...preset, enabled: !preset.enabled })}
          aria-pressed={preset.enabled}
          title={`${spec.label} – gehört zu ${spec.monk}MONK (${spec.kind === 'source' ? 'Quelle' : 'Prozessor'})`}
          className={`px-2 py-0.5 rounded-full text-[9px] font-bold tracking-widest border transition-colors ${preset.enabled ? 'border-emerald-400/70 text-emerald-200 bg-emerald-400/10' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}
        >
          {preset.enabled ? 'AN' : 'AUS'}
        </button>
        <span className="text-[10px] text-neutral-300 truncate">{spec.label}</span>
        <span className="text-[8px] tracking-widest text-neutral-500">{spec.monk.toUpperCase()}MONK</span>
        {spec.kind === 'source' && (
          <span className="text-[8px] text-neutral-500">· {(SOURCE_CHANNEL as Record<string, string>)[block]}</span>
        )}
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
        {Object.entries(spec.ranges).map(([name, range]) => {
          const [min, max] = range;
          const value = preset.params[name] ?? spec.defaults[name];
          const step = max - min <= 1 ? 0.01 : (max - min) / 100;
          return (
            <label key={name} className="flex items-center gap-1.5 text-[9px] text-neutral-400">
              <span className="w-14 shrink-0">{name}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => setParam(name, Number(e.target.value))}
                aria-label={`${spec.block}-${name}`}
                className="w-full accent-emerald-400"
              />
              <span className="w-10 shrink-0 text-right tabular-nums text-neutral-500">
                {value >= 100 ? value.toFixed(0) : value.toFixed(2)}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
};
