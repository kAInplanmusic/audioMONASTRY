/**
 * spatialMONK · Objekte im Raum platzieren und bewegen
 * =====================================================
 * Vorlage: docs/design/audioMONASTRY-design.html + V2_UI_VERKABELUNG.md
 *
 * VERKABELUNG (korrigiert 2026-10-26): Diese Komponente ruft ausschließlich
 * Engine-Methoden auf, die es wirklich gibt —
 *   audioEngine.setSpatialPosition(track, x, y)   HRTF-Pan + N-Kanal-Gewichte
 *   audioEngine.setSpatialSetup(setupId)          Mehrkanal-Konfiguration
 *   audioEngine.setSpatialMode('ON_TOP'|'SEPARATION')
 * Vorher standen hier `setSpatialWidth` / `setSpatialObject`, die es NIE gab:
 * die Regler liefen per Optional-Chaining-Cast ins Leere (kein Klang).
 *
 * `sp.w` (Stereo-Breite) und `sp.K.z` (Distanz) haben im V2-Pfad keine
 * Entsprechung und sind deshalb entfernt statt als Attrappe stehen gelassen.
 * Der Pfad (`sp.spd`) ist echt: er bewegt die Quelle über setSpatialPosition.
 */
import React, { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { AmCard, AmKnob, AmToggle, AmLed, AmXyPad, AmSeg, AmTabs, AM_MODULE } from './amUi';
import type { TrackType } from '../../types';

/** Kanäle in Mixer-Reihenfolge 1–8 (Quellen, die über die Kanalzüge Ton senden). */
const CHANNELS: { id: TrackType; name: string }[] = [
  { id: 'channel1', name: 'Drops' },
  { id: 'channel2', name: 'Song' },
  { id: 'channel3', name: 'Drums' },
  { id: 'channel4', name: 'Synth' },
  { id: 'channel5', name: 'Instru' },
  { id: 'channel6', name: 'Vox' },
  { id: 'channel7', name: 'Sound' },
  { id: 'channel8', name: 'Stems' },
];

interface SpatialObject { x: number; y: number; on: boolean }

interface SpatialState {
  setup: string;
  mode: 'ON_TOP' | 'SEPARATION';
  pathOn: boolean;
  pathSpeed: number;
  objects: Record<string, SpatialObject>;
}

const DEFAULTS: SpatialState = {
  setup: '2.0',
  mode: 'ON_TOP',
  pathOn: false,
  pathSpeed: 0.5,
  objects: CHANNELS.reduce((acc, c) => {
    acc[c.id] = { x: 0, y: 0, on: false };
    return acc;
  }, {} as Record<string, SpatialObject>),
};

function restore(): SpatialState {
  const raw = readPluginSettings<Partial<SpatialState>>('spatial');
  const objects = { ...DEFAULTS.objects };
  CHANNELS.forEach((c) => {
    const saved = raw?.objects?.[c.id];
    if (saved) objects[c.id] = { ...DEFAULTS.objects[c.id], ...saved };
  });
  return { ...DEFAULTS, ...raw, objects };
}

export const SpatialRack = React.memo(function SpatialRack() {
  const [state, setState] = useState<SpatialState>(restore);
  const [activeChannel, setActiveChannel] = useState<TrackType>('channel1');
  const [activeTab, setActiveTab] = useState<'objects' | 'layout' | 'paths'>('objects');
  const pathRef = useRef<number | null>(null);
  const phaseRef = useRef(0);
  const color = AM_MODULE['spatial']?.color ?? '#4cc9f0';

  // Setups einmal aus der Engine lesen (echte Liste, keine eigene Kopie).
  const [setups] = useState(() => {
    try {
      return audioEngine.getSpatialSetups().map((s) => ({ id: s.id, label: s.label }));
    } catch {
      return [{ id: '2.0', label: '2.0 (Stereo)' }];
    }
  });

  // Anfangsstand in die Engine schreiben
  useEffect(() => {
    try {
      audioEngine.setSpatialSetup(state.setup);
      audioEngine.setSpatialMode(state.mode);
      CHANNELS.forEach((c) => {
        const o = state.objects[c.id];
        if (o.on) audioEngine.setSpatialPosition(c.id, o.x, o.y);
      });
    } catch { /* Engine noch nicht bereit – Werte bleiben im Stand */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Einhängen
  }, []);

  // Persistieren (Session-Stand, nur der Halter schreibt)
  useEffect(() => {
    writePluginSettings('spatial', state);
  }, [state]);

  // Pfad-Bewegung: bewegt die aktive Quelle im Kreis — über setSpatialPosition,
  // also hörbar. Kein React-State pro Frame (nur Engine-Aufrufe).
  useEffect(() => {
    if (!state.pathOn) {
      if (pathRef.current !== null) { cancelAnimationFrame(pathRef.current); pathRef.current = null; }
      return;
    }
    const step = () => {
      phaseRef.current += 0.004 * (0.2 + state.pathSpeed * 1.8);
      const x = Math.cos(phaseRef.current);
      const y = Math.sin(phaseRef.current) * 0.7;
      try { audioEngine.setSpatialPosition(activeChannel, x, y); } catch { /* noch nicht bereit */ }
      pathRef.current = requestAnimationFrame(step);
    };
    pathRef.current = requestAnimationFrame(step);
    return () => {
      if (pathRef.current !== null) { cancelAnimationFrame(pathRef.current); pathRef.current = null; }
    };
  }, [state.pathOn, state.pathSpeed, activeChannel]);

  const patchObject = (ch: TrackType, patch: Partial<SpatialObject>) => {
    setState((prev) => {
      const next = { ...prev, objects: { ...prev.objects, [ch]: { ...prev.objects[ch], ...patch } } };
      const o = next.objects[ch];
      try {
        if (patch.x !== undefined || patch.y !== undefined || patch.on !== undefined) {
          audioEngine.setSpatialPosition(ch, o.x, o.y);
        }
      } catch { /* Engine nicht bereit */ }
      return next;
    });
  };

  const setSetup = (id: string) => {
    setState((p) => ({ ...p, setup: id }));
    try { audioEngine.setSpatialSetup(id); } catch { /* noop */ }
  };

  const setMode = (mode: 'ON_TOP' | 'SEPARATION') => {
    setState((p) => ({ ...p, mode }));
    try { audioEngine.setSpatialMode(mode); } catch { /* noop */ }
  };

  const chName = (id: TrackType) => CHANNELS.find((c) => c.id === id)?.name ?? id;
  const obj = state.objects[activeChannel];

  return (
    <div className="am-rackrow" data-testid="spatial-rack">
      {/* Raum-Konfiguration */}
      <AmCard title="Raum" style={{ width: 220 }}>
        <span className="am-lbl">Mehrkanal</span>
        <select
          className="am-sel"
          aria-label="Raum-Konfiguration"
          value={state.setup}
          onChange={(e) => setSetup(e.target.value)}
          style={{ width: '100%' }}
        >
          {setups.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <div style={{ marginTop: 10 }}>
          <span className="am-lbl">Ausgabe</span>
          <AmSeg
            label="Spatial-Modus"
            value={state.mode}
            options={[['ON_TOP', 'ON TOP'], ['SEPARATION', 'SEPARATION']] as const}
            onChange={setMode}
          />
        </div>
        <p className="am-hint" style={{ marginTop: 8 }}>
          ON TOP: Stereo bleibt hörbar, Spatial-Bus läuft zusätzlich. SEPARATION: nur der Mehrkanal-Bus ist hörbar.
        </p>
        <div className="am-row am-c" style={{ marginTop: 10, gap: 8 }}>
          <AmToggle
            on={state.pathOn}
            onClick={() => setState((p) => ({ ...p, pathOn: !p.pathOn }))}
            kind="m"
            ariaLabel="Pfad-Bewegung ein/aus"
          >
            PFAD
          </AmToggle>
          <AmLed on={state.pathOn} color="ok" size="s" label="Pfad" />
        </div>
        {state.pathOn && (
          <AmKnob
            size="s"
            value={state.pathSpeed}
            min={0}
            max={1}
            def={0.5}
            unit="pct"
            label="Tempo"
            title="Geschwindigkeit der Kreisbewegung"
            onChange={(v) => setState((p) => ({ ...p, pathSpeed: v }))}
          />
        )}
      </AmCard>

      {/* Objekt platzieren */}
      <AmCard title={`Objekt · ${chName(activeChannel)}`} style={{ flex: 1, minWidth: 420 }}>
        <AmTabs
          tabs={[
            { id: 'objects', label: 'Objekte' },
            { id: 'layout', label: 'Raum' },
            { id: 'paths', label: 'Pfade' },
          ]}
          active={activeTab}
          onChange={(id: string) => setActiveTab(id as 'objects' | 'layout' | 'paths')}
        />
        <div id={`panel-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
          {activeTab === 'objects' && (
            <>
              <div className="am-row am-c" style={{ gap: 4, marginTop: 12, flexWrap: 'wrap' }}>
                {CHANNELS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`am-tg ${activeChannel === c.id ? 'am-on' : ''}`}
                    onClick={() => setActiveChannel(c.id)}
                    aria-pressed={activeChannel === c.id}
                    aria-label={`Kanal ${c.name}`}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {c.name}
                      <AmLed on={state.objects[c.id].on} color={state.objects[c.id].on ? 'ok' : 'lock'} size="xs" />
                    </span>
                  </button>
                ))}
              </div>

              <div className="am-row am-c" style={{ gap: 16, marginTop: 12 }}>
                <div style={{ flex: 1, maxWidth: 320 }}>
                  <AmXyPad
                    x={obj.x}
                    y={obj.y}
                    onChange={(x, y) => patchObject(activeChannel, { x, y })}
                    label={`${chName(activeChannel)} Position`}
                    xLabel="Links/Rechts"
                    yLabel="Hinten/Vorne"
                    grid
                    quadrantLabels={{ tl: 'L·V', tr: 'R·V', bl: 'L·H', br: 'R·H' }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <AmToggle
                    on={obj.on}
                    onClick={() => patchObject(activeChannel, { on: !obj.on })}
                    kind="m"
                    ariaLabel={`${chName(activeChannel)} im Raum aktiv`}
                  >
                    {obj.on ? 'ON' : 'OFF'}
                  </AmToggle>
                  <span className="am-hint" style={{ textAlign: 'center', maxWidth: 90 }}>
                    X {obj.x.toFixed(2)}<br />Y {obj.y.toFixed(2)}
                  </span>
                </div>
              </div>
            </>
          )}
          {activeTab === 'layout' && (
            <div style={{ marginTop: 12 }}>
              <p className="am-hint">
                Konfiguration: <b>{state.setup}</b> · Ausgabe: <b>{state.mode === 'ON_TOP' ? 'ON TOP' : 'SEPARATION'}</b>.
                Die Liste kommt aus der Engine (audioEngine.getSpatialSetups()).
              </p>
            </div>
          )}
          {activeTab === 'paths' && (
            <div style={{ marginTop: 12 }}>
              <div className="am-row am-c" style={{ gap: 12 }}>
                <AmToggle
                  on={state.pathOn}
                  onClick={() => setState((p) => ({ ...p, pathOn: !p.pathOn }))}
                  kind="m"
                  ariaLabel="Pfad-Bewegung"
                >
                  PFAD
                </AmToggle>
                <AmKnob
                  size="s"
                  value={state.pathSpeed}
                  min={0}
                  max={1}
                  def={0.5}
                  unit="pct"
                  label="Tempo"
                  title="Geschwindigkeit der Kreisbewegung"
                  onChange={(v) => setState((p) => ({ ...p, pathSpeed: v }))}
                  disabled={!state.pathOn}
                />
              </div>
              <p className="am-hint" style={{ marginTop: 8 }}>
                Der Pfad bewegt <b>{chName(activeChannel)}</b> auf einem Kreis und schreibt jede Position
                über <code>setSpatialPosition</code> in die Engine – hörbar, nicht nur als Animation.
              </p>
            </div>
          )}
        </div>
      </AmCard>

      {/* Übersicht */}
      <AmCard title="Ansicht" style={{ width: 160 }}>
        <div style={{ position: 'relative', width: 140, height: 140, background: 'var(--pn2)', border: '1px solid var(--ln2)', borderRadius: 'var(--r)' }}>
          {CHANNELS.map((c) => {
            const o = state.objects[c.id];
            if (!o.on) return null;
            return (
              <div
                key={c.id}
                style={{
                  position: 'absolute',
                  left: `${((o.x + 1) / 2) * 100}%`,
                  top: `${(1 - (o.y + 1) / 2) * 100}%`,
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: color,
                  transform: 'translate(-50%,-50%)',
                  boxShadow: `0 0 6px ${color}`,
                }}
                title={`${c.name} · X ${o.x.toFixed(2)} · Y ${o.y.toFixed(2)}`}
              />
            );
          })}
        </div>
        <span className="am-hint" style={{ marginTop: 6, display: 'block', textAlign: 'center' }}>
          {CHANNELS.filter((c) => state.objects[c.id].on).length} Objekte im Raum
        </span>
      </AmCard>
    </div>
  );
});
