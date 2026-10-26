/**
 * effectMONK · Send-Effekte (Engine: effect-processor + optional Reverb)
 * ======================================================================
 * Vorlage: docs/design/audioMONASTRY-design.html + V2_UI_VERKABELUNG.md
 * Engine-Schlüssel (setEffectParams): wet, feedback, rate, depth, bits, sampleReduction, drive
 * Engine-Schlüssel (setOptionalReverb): enabled, mix, decayS, damping, sizeScale
 * FX-Lock: Makros/Szenen dürfen Effekte nicht ändern.
 */
import React, { useEffect, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { AmCard, AmKnob, AmToggle, AmCollapsible, AmLed } from './amUi';

interface EffectSettings {
  // Main effect processor
  type: 'delay' | 'chorus' | 'phaser' | 'distortion' | 'bitcrusher';
  wet: number;
  feedback: number;
  rate: number;
  depth: number;
  bits: number;
  sampleReduction: number;
  drive: number;
  // Optional HQ Reverb on master
  reverbEnabled: boolean;
  reverbMix: number;
  reverbDecayS: number;
  reverbDamping: number;
  sizeScale: number;
}

const DEFAULTS: EffectSettings = {
  type: 'delay',
  wet: 0.3,
  feedback: 0.5,
  rate: 0.5,
  depth: 0.5,
  bits: 16,
  sampleReduction: 1,
  drive: 0,
  reverbEnabled: false,
  reverbMix: 0.3,
  reverbDecayS: 2.5,
  reverbDamping: 0.5,
  sizeScale: 1,
};

const EFFECT_TYPES = [
  { id: 'delay' as const, name: 'Delay', icon: '🔁' },
  { id: 'chorus' as const, name: 'Chorus', icon: '🌊' },
  { id: 'phaser' as const, name: 'Phaser', icon: '🌀' },
  { id: 'distortion' as const, name: 'Distortion', icon: '🔥' },
  { id: 'bitcrusher' as const, name: 'Bitcrusher', icon: '📉' },
] as const;

function restore(): EffectSettings {
  const raw = readPluginSettings<{ effects?: Partial<EffectSettings> }>('effect');
  if (!raw?.effects) return DEFAULTS;
  return { ...DEFAULTS, ...raw.effects };
}

export const EffectRack = React.memo(function EffectRack({ fxLock = false }: { fxLock?: boolean }) {
  const [settings, setSettings] = useState<EffectSettings>(restore);
  const [activeType, setActiveType] = useState<EffectSettings['type']>(() => restore().type);

  // Engine initialisieren
  useEffect(() => {
    applyToEngine(settings);
  }, [settings]);

  // Persistieren
  useEffect(() => {
    writePluginSettings('effect', { effects: settings });
  }, [settings]);

  const applyToEngine = (s: EffectSettings) => {
    audioEngine.setEffectParams({
      type: s.type,
      wet: s.wet,
      feedback: s.feedback,
      rate: s.rate,
      depth: s.depth,
      bits: s.bits,
      sampleReduction: s.sampleReduction,
      drive: s.drive,
    });
    audioEngine.setOptionalReverb({
      enabled: s.reverbEnabled,
      mix: s.reverbMix,
      decayS: s.reverbDecayS,
      damping: s.reverbDamping,
      sizeScale: s.sizeScale,
    });
  };

  const setParam = <K extends keyof EffectSettings>(key: K, value: EffectSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      applyToEngine(next);
      return next;
    });
  };

  const setType = (type: EffectSettings['type']) => {
    setActiveType(type);
    setParam('type', type);
  };

  return (
    <div className="am-rackrow" data-testid="effect-rack">
      {/* Effect Type Selector */}
      <AmCard title="Effect Type" style={{ width: 220 }}>
        <div className="am-seg" role="group" aria-label="Effect Type" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {EFFECT_TYPES.map(t => (
            <button
              key={t.id}
              type="button"
              className={`am-tg ${activeType === t.id ? 'am-on' : ''}`}
              onClick={() => setType(t.id)}
              disabled={fxLock}
              aria-pressed={activeType === t.id}
              aria-label={t.name}
              style={{ padding: '4px 10px', fontSize: 11 }}
            >
              {t.icon} {t.name}
            </button>
          ))}
        </div>
        {fxLock && <AmLed on={true} color="lock" size="s" label="FX-Lock aktiv" />}
      </AmCard>

      {/* Main Effect Parameters */}
      <AmCard title={`Effect · ${EFFECT_TYPES.find(t => t.id === activeType)?.name}`} style={{ flex: 1, minWidth: 400 }}>
        <div className="am-knobs" style={{ marginTop: 8 }}>
          <AmToggle
            on={true}
            onClick={() => {}}
            kind="m"
            ariaLabel="Effect aktiv"
            disabled={true}
          >
            ON
          </AmToggle>

          {/* Type-specific parameters */}
          {activeType === 'delay' && (
            <>
              <AmKnob size="s" value={settings.wet} min={0} max={1} def={0.3} unit="pct" label="Wet" title="Dry/Wet Mix" onChange={v => setParam('wet', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.feedback} min={0} max={0.95} def={0.5} unit="pct" label="Feedback" title="Feedback Amount" onChange={v => setParam('feedback', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.rate} min={0.01} max={1} def={0.25} log unit="hz" label="Time" title="Delay Time" onChange={v => setParam('rate', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.depth} min={0} max={1} def={0.3} unit="pct" label="Mod" title="Modulation Depth" onChange={v => setParam('depth', v)} disabled={fxLock} />
            </>
          )}
          {activeType === 'chorus' && (
            <>
              <AmKnob size="s" value={settings.wet} min={0} max={1} def={0.3} unit="pct" label="Wet" title="Dry/Wet Mix" onChange={v => setParam('wet', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.rate} min={0.1} max={10} def={1.5} log unit="hz" label="Rate" title="LFO Rate" onChange={v => setParam('rate', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.depth} min={0} max={1} def={0.5} unit="pct" label="Depth" title="Modulation Depth" onChange={v => setParam('depth', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.feedback} min={0} max={0.9} def={0.3} unit="pct" label="Feedback" title="Feedback" onChange={v => setParam('feedback', v)} disabled={fxLock} />
            </>
          )}
          {activeType === 'phaser' && (
            <>
              <AmKnob size="s" value={settings.wet} min={0} max={1} def={0.3} unit="pct" label="Wet" title="Dry/Wet Mix" onChange={v => setParam('wet', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.rate} min={0.1} max={10} def={1} log unit="hz" label="Rate" title="LFO Rate" onChange={v => setParam('rate', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.depth} min={0} max={1} def={0.6} unit="pct" label="Depth" title="Modulation Depth" onChange={v => setParam('depth', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.feedback} min={0} max={0.95} def={0.5} unit="pct" label="Feedback" title="Feedback" onChange={v => setParam('feedback', v)} disabled={fxLock} />
            </>
          )}
          {activeType === 'distortion' && (
            <>
              <AmKnob size="s" value={settings.wet} min={0} max={1} def={0.5} unit="pct" label="Wet" title="Dry/Wet Mix" onChange={v => setParam('wet', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.drive} min={0} max={1} def={0.3} unit="pct" label="Drive" title="Distortion Amount" onChange={v => setParam('drive', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.depth} min={0} max={1} def={0.5} unit="pct" label="Tone" title="Tone/Filter" onChange={v => setParam('depth', v)} disabled={fxLock} />
            </>
          )}
          {activeType === 'bitcrusher' && (
            <>
              <AmKnob size="s" value={settings.wet} min={0} max={1} def={0.5} unit="pct" label="Wet" title="Dry/Wet Mix" onChange={v => setParam('wet', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.bits} min={1} max={16} def={16} unit="int" label="Bits" title="Bit Depth" onChange={v => setParam('bits', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.sampleReduction} min={1} max={100} def={1} unit="int" label="Downsample" title="Sample Rate Reduction" onChange={v => setParam('sampleReduction', v)} disabled={fxLock} />
            </>
          )}
        </div>
      </AmCard>

      {/* Optional HQ Reverb */}
      <AmCard title="Master Reverb (HQ)" style={{ width: 280 }}>
        <AmCollapsible
          title="HQ Reverb (4-Line FDN)"
          open={settings.reverbEnabled}
          onToggle={() => setParam('reverbEnabled', !settings.reverbEnabled)}
        >
          <div className="am-row am-c" style={{ gap: 8, marginTop: 8 }}>
            <AmToggle
              on={settings.reverbEnabled}
              onClick={() => setParam('reverbEnabled', !settings.reverbEnabled)}
              kind="m"
              ariaLabel="HQ Reverb ein/aus"
              disabled={fxLock}
            >
              ON
            </AmToggle>
            <AmLed on={settings.reverbEnabled} color="ok" size="s" label={settings.reverbEnabled ? 'HQ Reverb aktiv' : 'HQ Reverb aus'} />
          </div>
          {settings.reverbEnabled && (
            <div className="am-knobs" style={{ marginTop: 8 }}>
              <AmKnob size="s" value={settings.reverbMix} min={0} max={1} def={0.3} unit="pct" label="Mix" title="Reverb Mix" onChange={v => setParam('reverbMix', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.reverbDecayS} min={0.1} max={20} def={2.5} log unit="ms" label="Decay" title="Decay Time" onChange={v => setParam('reverbDecayS', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.reverbDamping} min={0} max={1} def={0.5} unit="pct" label="Damping" title="High-Frequency Damping" onChange={v => setParam('reverbDamping', v)} disabled={fxLock} />
              <AmKnob size="s" value={settings.sizeScale} min={0.1} max={4} def={1} unit="x" label="Size" title="Room Size Scale" onChange={v => setParam('sizeScale', v)} disabled={fxLock} />
            </div>
          )}
        </AmCollapsible>
      </AmCard>
    </div>
  );
});