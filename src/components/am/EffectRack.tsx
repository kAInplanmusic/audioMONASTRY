/**
 * effectMONK · Send-Effekte (Engine: V2-Master-FX + optionales HQ-Reverb)
 * =======================================================================
 * Vorlage: docs/design/audioMONASTRY-design.html + V2_UI_VERKABELUNG.md
 *
 * VERKABELUNG (korrigiert 2026-10-26): Der hörbare Pfad ist
 *   audioEngine.setEffectParams({wet, feedback, rate, depth})
 *     → WorkletParamBridge.setEffectParam → v2LiveSink.setMasterFx(w,f,r,d)
 *   audioEngine.setOptionalReverb({enabled, mix, decayS, damping, sizeScale})
 *
 * Was hier NICHT mehr steht (und warum):
 *   - `type` und `power`: `setEffectParams` verwirft beide, sie erreichen den
 *     Worklet nie (src/utils/audioEngine.ts:1556).
 *   - `bits` / `sampleReduction`: gehen nur an den eigenständigen effect-processor,
 *     NICHT in den V2-Live-Pfad (mirrorFx spiegelt ausschließlich wet/feedback/
 *     rate/depth). Als Live-Regler wären sie Attrappen.
 * Ersatz für die fünf „Typen": Charakter-Presets, die genau die vier echten
 * Parameter setzen — jeder davon ist auf dem Main hörbar.
 */
import React, { useEffect, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { AmCard, AmKnob, AmToggle, AmCollapsible, AmLed } from './amUi';

interface FxParams {
  wet: number;
  feedback: number;
  rate: number;
  depth: number;
}

interface ReverbParams {
  enabled: boolean;
  mix: number;
  decayS: number;
  damping: number;
  sizeScale: number;
}

interface EffectSettings {
  character: CharacterId;
  fx: FxParams;
  reverb: ReverbParams;
}

/** Charaktere = benannte Parameter-Sätze des EINEN realen Effekts. */
const CHARACTERS = [
  { id: 'slap', name: 'Slap', hint: 'kurz, trocken', fx: { wet: 0.22, feedback: 0.18, rate: 0.62, depth: 0.10 } },
  { id: 'delay', name: 'Delay', hint: 'klarer Nachhall', fx: { wet: 0.35, feedback: 0.62, rate: 0.34, depth: 0.15 } },
  { id: 'chorus', name: 'Chorus', hint: 'breit, schwebend', fx: { wet: 0.42, feedback: 0.22, rate: 0.22, depth: 0.78 } },
  { id: 'phaser', name: 'Phaser', hint: 'wellig, rhythmisch', fx: { wet: 0.38, feedback: 0.48, rate: 0.16, depth: 0.62 } },
  { id: 'wash', name: 'Wash', hint: 'lang, diffus', fx: { wet: 0.55, feedback: 0.80, rate: 0.08, depth: 0.45 } },
] as const;

type CharacterId = typeof CHARACTERS[number]['id'];

const DEFAULTS: EffectSettings = {
  character: 'delay',
  fx: { ...CHARACTERS[1].fx },
  reverb: { enabled: false, mix: 0.3, decayS: 2.5, damping: 0.5, sizeScale: 1 },
};

function restore(): EffectSettings {
  const raw = readPluginSettings<Partial<EffectSettings>>('effect');
  return {
    character: raw?.character ?? DEFAULTS.character,
    fx: { ...DEFAULTS.fx, ...raw?.fx },
    reverb: { ...DEFAULTS.reverb, ...raw?.reverb },
  };
}

export const EffectRack = React.memo(function EffectRack({ fxLock = false }: { fxLock?: boolean }) {
  const [settings, setSettings] = useState<EffectSettings>(restore);

  // Anfangsstand in die Engine (nur echte Parameter)
  useEffect(() => {
    applyToEngine(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Einhängen
  }, []);

  // Persistieren (Session-Stand)
  useEffect(() => {
    writePluginSettings('effect', settings);
  }, [settings]);

  const applyToEngine = (s: EffectSettings) => {
    try {
      audioEngine.setEffectParams({
        wet: s.fx.wet,
        feedback: s.fx.feedback,
        rate: s.fx.rate,
        depth: s.fx.depth,
      });
      audioEngine.setOptionalReverb({
        enabled: s.reverb.enabled,
        mix: s.reverb.mix,
        decayS: s.reverb.decayS,
        damping: s.reverb.damping,
        sizeScale: s.reverb.sizeScale,
      });
    } catch { /* Engine noch nicht bereit – Stand bleibt erhalten */ }
  };

  const patchFx = (patch: Partial<FxParams>) => {
    setSettings((prev) => {
      const next = { ...prev, fx: { ...prev.fx, ...patch } };
      applyToEngine(next);
      return next;
    });
  };

  const patchReverb = (patch: Partial<ReverbParams>) => {
    setSettings((prev) => {
      const next = { ...prev, reverb: { ...prev.reverb, ...patch } };
      applyToEngine(next);
      return next;
    });
  };

  const applyCharacter = (id: CharacterId) => {
    const preset = CHARACTERS.find((c) => c.id === id);
    if (!preset) return;
    setSettings((prev) => {
      const next = { ...prev, character: id, fx: { ...preset.fx } };
      applyToEngine(next);
      return next;
    });
  };

  return (
    <div className="am-rackrow" data-testid="effect-rack">
      {/* Charakter */}
      <AmCard title="Charakter" style={{ width: 220 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {CHARACTERS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`am-btn ${settings.character === c.id ? 'am-pri' : ''}`}
              onClick={() => applyCharacter(c.id)}
              disabled={fxLock}
              aria-pressed={settings.character === c.id}
              aria-label={`Effekt-Charakter ${c.name}`}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 8, textAlign: 'left' }}
            >
              <span>{c.name}</span>
              <small style={{ opacity: 0.7 }}>{c.hint}</small>
            </button>
          ))}
        </div>
        {fxLock && (
          <div style={{ marginTop: 8 }}>
            <AmLed on color="lock" size="s" label="FX-Lock aktiv" />
          </div>
        )}
      </AmCard>

      {/* Die vier echten Parameter */}
      <AmCard title="FX-Parameter (hörbar)" style={{ flex: 1, minWidth: 380 }}>
        <div className="am-knobs" style={{ marginTop: 4 }}>
          <AmKnob
            size="s" value={settings.fx.wet} min={0} max={1} def={0.3} unit="pct"
            label="Wet" title="Dry/Wet-Anteil des Effekts"
            onChange={(v) => patchFx({ wet: v })} disabled={fxLock}
          />
          <AmKnob
            size="s" value={settings.fx.feedback} min={0} max={0.9} def={0.6} unit="pct"
            label="Feedback" title="Rückkopplung (0–0,9)"
            onChange={(v) => patchFx({ feedback: v })} disabled={fxLock}
          />
          <AmKnob
            size="s" value={settings.fx.rate} min={0} max={1} def={0.5} unit="pct"
            label="Rate" title="Modulations-/Verzögerungsrate"
            onChange={(v) => patchFx({ rate: v })} disabled={fxLock}
          />
          <AmKnob
            size="s" value={settings.fx.depth} min={0} max={1} def={0.5} unit="pct"
            label="Depth" title="Modulationstiefe"
            onChange={(v) => patchFx({ depth: v })} disabled={fxLock}
          />
        </div>
        <p className="am-hint" style={{ marginTop: 8 }}>
          Alle vier Werte gehen über <code>setEffectParams</code> in den V2-Live-Pfad
          (<code>setMasterFx</code>) und sind damit auf dem Main hörbar.
        </p>
      </AmCard>

      {/* HQ-Reverb am Master */}
      <AmCard title="Master Reverb (HQ)" style={{ width: 260 }}>
        <AmCollapsible
          title="HQ Reverb (4-Leitung)"
          open={settings.reverb.enabled}
          onToggle={() => patchReverb({ enabled: !settings.reverb.enabled })}
        >
          <div className="am-row am-c" style={{ gap: 8, marginTop: 8 }}>
            <AmToggle
              on={settings.reverb.enabled}
              onClick={() => patchReverb({ enabled: !settings.reverb.enabled })}
              kind="m"
              ariaLabel="HQ Reverb ein/aus"
              disabled={fxLock}
            >
              ON
            </AmToggle>
            <AmLed on={settings.reverb.enabled} color="ok" size="s" label={settings.reverb.enabled ? 'HQ Reverb aktiv' : 'HQ Reverb aus'} />
          </div>
          {settings.reverb.enabled && (
            <div className="am-knobs" style={{ marginTop: 8 }}>
              <AmKnob size="s" value={settings.reverb.mix} min={0} max={1} def={0.3} unit="pct" label="Mix" title="Hall-Anteil" onChange={(v) => patchReverb({ mix: v })} disabled={fxLock} />
              <AmKnob size="s" value={settings.reverb.decayS} min={0.1} max={20} def={2.5} log unit="ms" label="Decay" title="Nachhallzeit" onChange={(v) => patchReverb({ decayS: v })} disabled={fxLock} />
              <AmKnob size="s" value={settings.reverb.damping} min={0} max={1} def={0.5} unit="pct" label="Damping" title="Höhendämpfung" onChange={(v) => patchReverb({ damping: v })} disabled={fxLock} />
              <AmKnob size="s" value={settings.reverb.sizeScale} min={0.1} max={4} def={1} unit="x" label="Size" title="Raumgröße" onChange={(v) => patchReverb({ sizeScale: v })} disabled={fxLock} />
            </div>
          )}
        </AmCollapsible>
      </AmCard>
    </div>
  );
});
