/**
 * spatialMONK · Objekte im Raum platzieren und bewegen
 * =====================================================
 * Vorlage: docs/design/audioMONASTRY-design.html + V2_UI_VERKABELUNG.md
 * Engine: SpatialScene, setSpatial*, Stereo-Breite, Panner je Kanal
 * Schlüssel: sp.w (Stereo-Breite), sp.K.x/y/z (Objekt-Koordinaten),
 *            sp.lay (Layout), sp.mode, sp.spd (Pfad-Geschwindigkeit)
 */
import React, { useEffect, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { AmCard, AmKnob, AmToggle, AmLed, AmXyPad, AmSeg, AmTabs } from './amUi';
import { AM_MODULE } from './amUi';

// Kanäle (wie im Signalweg: drop, song, drumsampler, syntisampler, instru, voice, sound, stem)
const SPATIAL_CHANNELS = ['drop', 'song', 'drumsampler', 'syntisampler', 'instru', 'voice', 'sound', 'stem'] as const;
type SpatialChannel = typeof SPATIAL_CHANNELS[number];

interface SpatialObject {
  x: number;       // -1..1 (links..rechts)
  y: number;       // -1..1 (hinten..vorne)
  z: number;       // 0..1 (nah..fern)
  enabled: boolean;
}

interface SpatialState {
  width: number;         // sp.w: Stereo-Breite 0..1
  layout: 'circle' | 'grid' | 'free' | 'orbit'; // sp.lay
  mode: 'stereo' | 'binaural' | 'multi';        // sp.mode
  pathSpeed: number;     // sp.spd: Pfad-Geschwindigkeit
  pathEnabled: boolean;  // Pfad-Bewegung an/aus
  objects: Record<SpatialChannel, SpatialObject>;
}

const DEFAULTS: SpatialState = {
  width: 1,
  layout: 'free',
  mode: 'stereo',
  pathSpeed: 0.5,
  pathEnabled: false,
  objects: SPATIAL_CHANNELS.reduce((acc, ch) => {
    acc[ch] = { x: 0, y: 0, z: 0.5, enabled: false };
    return acc;
  }, {} as Record<SpatialChannel, SpatialObject>),
};

function restore() {
  const raw = readPluginSettings<Partial<SpatialState>>('spatial');
  if (!raw) return DEFAULTS;
  const objects = { ...DEFAULTS.objects };
  if (raw.objects) {
    SPATIAL_CHANNELS.forEach(ch => {
      if (raw.objects?.[ch]) {
        objects[ch] = { ...DEFAULTS.objects[ch], ...raw.objects[ch] };
      }
    });
  }
  return { ...DEFAULTS, ...raw, objects };
}

export const SpatialRack = React.memo(function SpatialRack() {
  const [state, setState] = useState(() => restore());
  const [activeChannel, setActiveChannel] = useState<SpatialChannel>('drop');
  const [activeTab, setActiveTab] = useState<'room' | 'objects' | 'paths'>('room');

  // Engine initialisieren
  useEffect(() => {
    applyToEngine(state);
  }, [state]);

  // Persistieren
  useEffect(() => {
    writePluginSettings('spatial', state);
  }, [state]);

  const applyToEngine = (s: SpatialState) => {
    // Stereo-Breite
    try {
      (audioEngine as unknown as { setSpatialWidth?: (w: number) => void }).setSpatialWidth?.(s.width);
    } catch { /* Engine-Methode nicht verfügbar */ }
    // Objekte
    SPATIAL_CHANNELS.forEach(ch => {
      const obj = s.objects[ch];
      if (obj.enabled) {
        try {
          (audioEngine as unknown as { setSpatialObject?: (ch: string, x: number, y: number, z: number) => void })
            .setSpatialObject?.(ch, obj.x, obj.y, obj.z);
        } catch { /* Engine-Methode nicht verfügbar */ }
      }
    });
  };

  const setParam = <K extends keyof SpatialState>(key: K, value: SpatialState[K]) => {
    setState(prev => {
      const next = { ...prev, [key]: value };
      applyToEngine(next);
      return next;
    });
  };

  const setObject = (ch: SpatialChannel, key: keyof SpatialObject, value: number | boolean) => {
    setState(prev => {
      const next = {
        ...prev,
        objects: {
          ...prev.objects,
          [ch]: { ...prev.objects[ch], [key]: value },
        },
      };
      applyToEngine(next);
      return next;
    });
  };

  const activeObj = state.objects[activeChannel];
  const color = AM_MODULE['spatial']?.color ?? '#4cc9f0';

  return (
    <div className="am-rackrow" data-testid="spatial-rack">
      {/* Stereo Width / Mode */}
      <AmCard title="Raum" style={{ width: 220 }}>
        <div className="am-row am-c" style={{ gap: 8, marginBottom: 12 }}>
          <AmToggle
            on={state.pathEnabled}
            onClick={() => setParam('pathEnabled', !state.pathEnabled)}
            kind="m"
            ariaLabel="Pfad-Bewegung ein/aus"
          >
            PFAD
          </AmToggle>
          <AmLed on={state.pathEnabled} color="ok" size="s" label="Pfad" />
        </div>
        <AmKnob
          size="s"
          value={state.width}
          min={0}
          max={1}
          def={1}
          unit="pct"
          label="Breite"
          title="Stereo-Breite (sp.w)"
          onChange={v => setParam('width', v)}
        />
        <div style={{ marginTop: 12 }}>
          <span className="am-lbl">Mode</span>
          <AmSeg
            label="Modus"
            value={state.mode}
            options={[['stereo', 'Stereo'], ['binaural', 'Binaural'], ['multi', 'Multi']]}
            onChange={v => setParam('mode', v)}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <span className="am-lbl">Layout</span>
          <AmSeg
            label="Layout"
            value={state.layout}
            options={[['circle', 'Kreis'], ['grid', 'Raster'], ['free', 'Frei'], ['orbit', 'Orbit']]}
            onChange={v => setParam('layout', v)}
          />
        </div>
        {state.pathEnabled && (
          <div style={{ marginTop: 12 }}>
            <AmKnob
              size="s"
              value={state.pathSpeed}
              min={0.01}
              max={2}
              def={0.5}
              unit="x"
              label="Geschw."
              title="Pfad-Geschwindigkeit (sp.spd)"
              onChange={v => setParam('pathSpeed', v)}
            />
          </div>
        )}
      </AmCard>

      {/* X/Y/Z Pad */}
      <AmCard title={`Objekt · ${activeChannel}`} style={{ flex: 1, minWidth: 420 }}>
        <AmTabs
          tabs={[
            { id: 'room', label: 'Raum' },
            { id: 'objects', label: 'Objekte' },
            { id: 'paths', label: 'Pfade' },
          ]}
          active={activeTab}
          onChange={(id: string) => setActiveTab(id as 'room' | 'objects' | 'paths')}
        />
        <div id={`panel-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
          {activeTab === 'objects' && (
            <>
              {/* Kanal-Wahl */}
              <div className="am-row am-c" style={{ gap: 4, marginTop: 12, flexWrap: 'wrap' }}>
                {SPATIAL_CHANNELS.map(ch => (
                  <button
                    key={ch}
                    type="button"
                    className={`am-tg ${activeChannel === ch ? 'am-on' : ''}`}
                    onClick={() => setActiveChannel(ch)}
                    aria-pressed={activeChannel === ch}
                    aria-label={`Kanal ${ch}`}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {ch}
                    <AmLed on={state.objects[ch].enabled} color={state.objects[ch].enabled ? 'ok' : 'lock'} size="xs" />
                  </span>
                  </button>
                ))}
              </div>

              {/* X/Y Pad + Z Knob */}
              <div className="am-row am-c" style={{ gap: 16, marginTop: 12 }}>
                <div style={{ flex: 1, maxWidth: 320 }}>
                  <AmXyPad
                    x={activeObj.x}
                    y={activeObj.y}
                    onChange={(x, y) => {
                      setObject(activeChannel, 'x', x);
                      setObject(activeChannel, 'y', y);
                    }}
                    label={`${activeChannel} Position X/Y`}
                    xLabel="Links/Rechts"
                    yLabel="Hinten/Vorne"
                    grid={true}
                    quadrantLabels={{ tl: 'L·V', tr: 'R·V', bl: 'L·H', br: 'R·H' }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <AmToggle
                    on={activeObj.enabled}
                    onClick={() => setObject(activeChannel, 'enabled', !activeObj.enabled)}
                    kind="m"
                    ariaLabel={`${activeChannel} im Raum`}
                  >
                    {activeObj.enabled ? 'ON' : 'OFF'}
                  </AmToggle>
                  <AmKnob
                    size="s"
                    value={activeObj.z}
                    min={0}
                    max={1}
                    def={0.5}
                    unit="pct"
                    label="Distanz"
                    title="Entfernung (z)"
                    onChange={v => setObject(activeChannel, 'z', v)}
                    disabled={!activeObj.enabled}
                  />
                </div>
              </div>
            </>
          )}
          {activeTab === 'room' && (
            <div style={{ marginTop: 12, color: 'var(--dm)' }}>
              Einstellungen im linken Bereich: Stereo-Breite, Modus und Layout.
            </div>
          )}
          {activeTab === 'paths' && (
            <div style={{ marginTop: 12 }}>
              <div className="am-row am-c" style={{ gap: 12 }}>
                <AmToggle
                  on={state.pathEnabled}
                  onClick={() => setParam('pathEnabled', !state.pathEnabled)}
                  kind="m"
                  ariaLabel="Pfad-Bewegung"
                >
                  PFAD
                </AmToggle>
                <AmKnob
                  size="s"
                  value={state.pathSpeed}
                  min={0.01}
                  max={2}
                  def={0.5}
                  unit="x"
                  label="Tempo"
                  title="Wie schnell das Objekt seinen Pfad abfährt"
                  onChange={v => setParam('pathSpeed', v)}
                  disabled={!state.pathEnabled}
                />
              </div>
              <p className="am-hint" style={{ marginTop: 8 }}>
                Pfade bewegen Objekte taktgenau. Das Tempo ist relativ zum Main-BPM.
              </p>
            </div>
          )}
        </div>
      </AmCard>

      {/* Mini-View (Objektpositionen im Raum) */}
      <AmCard title="Ansicht" style={{ width: 160 }}>
        <div style={{ position: 'relative', width: 140, height: 140, background: 'var(--pn2)', border: '1px solid var(--ln2)', borderRadius: 'var(--r)' }}>
          {SPATIAL_CHANNELS.map(ch => {
            const obj = state.objects[ch];
            if (!obj.enabled) return null;
            return (
              <div
                key={ch}
                style={{
                  position: 'absolute',
                  left: `${(obj.x + 1) / 2 * 100}%`,
                  top: `${(1 - (obj.y + 1) / 2) * 100}%`,
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: color,
                  transform: 'translate(-50%,-50%)',
                  boxShadow: `0 0 6px ${color}`,
                  opacity: 1 - obj.z * 0.6,
                }}
                title={`${ch} · ${obj.x.toFixed(2)} / ${obj.y.toFixed(2)} / ${obj.z.toFixed(2)}`}
              />
            );
          })}
        </div>
        <span className="am-hint" style={{ marginTop: 6, display: 'block', textAlign: 'center' }}>
          {SPATIAL_CHANNELS.filter(ch => state.objects[ch].enabled).length} Objekte im Raum
        </span>
      </AmCard>
    </div>
  );
});