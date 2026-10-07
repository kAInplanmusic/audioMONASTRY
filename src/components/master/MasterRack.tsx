/**
 * masterMONK · Rack-Modul (Vorlage public/uidesign/uiübersichtapp.jpg, Zeile 15)
 * ==========================================================================
 * Eine Zeile, alles Nötige sichtbar: Preset · Signalkette · Regler der
 * Mastering-Stufe · Lautheit gegen Ziel · 12-Band-Klangbild.
 * Engine: `updateMasterMe` / `updateToneShiftEQ` (wie bisher). Stand in der
 * Session (`writePluginSettings('master', …)`, gleiche Felder wie zuvor).
 */
import React, { useEffect, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';
import { MASTERING_PRESETS } from '../../data/masteringPresets';
import { AmCard, AmKnob } from '../am/amUi';

type PresetKey = keyof typeof MASTERING_PRESETS;
type MasterMe = (typeof MASTERING_PRESETS)[PresetKey]['master_me'];
type ToneShift = (typeof MASTERING_PRESETS)[PresetKey]['tone_shift'];
const FIRST = Object.keys(MASTERING_PRESETS)[0] as PresetKey;

function restore(): { preset: PresetKey; me: MasterMe; tone: ToneShift; saved: boolean } {
  const raw = readPluginSettings<{ activePreset?: unknown; masterMe?: unknown; toneShift?: unknown }>('master');
  const preset = typeof raw?.activePreset === 'string' && raw.activePreset in MASTERING_PRESETS ? (raw.activePreset as PresetKey) : FIRST;
  const base = MASTERING_PRESETS[preset];
  const me = raw?.masterMe && typeof raw.masterMe === 'object' ? { ...base.master_me, ...(raw.masterMe as object) } as MasterMe : base.master_me;
  const tone = raw?.toneShift && typeof raw.toneShift === 'object' && Array.isArray((raw.toneShift as { bands?: unknown }).bands)
    ? (raw.toneShift as ToneShift) : base.tone_shift;
  return { preset, me, tone, saved: !!raw };
}

const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${f}`);

export const MasterRack = React.memo(function MasterRack() {
  const [init] = useState(restore);
  const [preset, setPreset] = useState<PresetKey>(init.preset);
  const [me, setMe] = useState<MasterMe>(init.me);
  const [tone, setTone] = useState<ToneShift>(init.tone);
  const [lufs, setLufs] = useState(0);

  useEffect(() => {
    audioEngine.updateMasterMe(init.me);
    audioEngine.updateToneShiftEQ(init.tone as never);
  }, [init]);
  useEffect(() => {
    writePluginSettings('master', { activePreset: preset, masterMe: me, toneShift: tone });
  }, [preset, me, tone]);
  useEffect(() => {
    const id = window.setInterval(() => setLufs(audioEngine.getLufsValue()), 250);
    return () => window.clearInterval(id);
  }, []);

  const setParam = (k: keyof MasterMe, v: number) => {
    setMe((p) => ({ ...p, [k]: v }));
    audioEngine.updateMasterMe({ [k]: v });
  };
  const setBand = (i: number, gain: number) => {
    setTone((p) => {
      const bands = p.bands.map((b, k) => (k === i ? { ...b, gain } : b));
      const next = { ...p, bands } as ToneShift;
      audioEngine.updateToneShiftEQ({ bands } as never);
      return next;
    });
  };
  const applyPreset = (k: PresetKey) => {
    const p = MASTERING_PRESETS[k];
    setPreset(k);
    setMe(p.master_me);
    setTone(p.tone_shift);
    audioEngine.updateMasterMe(p.master_me);
    audioEngine.updateToneShiftEQ(p.tone_shift as never);
  };

  const hasLufs = Number.isFinite(lufs) && lufs > -70 && lufs !== 0;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v + 30) / 30) * 100))}%`;

  return (
    <div className="am-rackrow" data-testid="master-rack">
      <AmCard title="Preset" style={{ width: 170 }}>
        <select className="am-sel" aria-label="Mastering-Preset" value={preset} onChange={(e) => applyPreset(e.target.value as PresetKey)}>
          {(Object.keys(MASTERING_PRESETS) as PresetKey[]).map((k) => <option key={k} value={k}>{MASTERING_PRESETS[k].name}</option>)}
        </select>
        <div className="am-chainmini" aria-label="Kette">
          {['Input', 'HP', 'EQ', 'Comp', 'Limiter'].map((n, i) => (
            <React.Fragment key={n}>{i > 0 && <span>→</span>}<b>{n}</b></React.Fragment>
          ))}
        </div>
      </AmCard>
      <AmCard title="Mastering" style={{ flex: 1.4, minWidth: 360 }}>
        <div className="am-knobs">
          <AmKnob size="s" value={me.input_gain} min={-12} max={12} def={0} unit="db" label="Input" title="Eingangspegel" onChange={(v) => setParam('input_gain', v)} />
          <AmKnob size="s" value={me.highpass_freq} min={10} max={120} def={30} log unit="hz" label="Low Cut" title="Hochpass" onChange={(v) => setParam('highpass_freq', v)} />
          <AmKnob size="s" gold value={me.tilt_gain} min={-6} max={6} def={0} unit="db" label="Tilt" title="Klang kippen: dunkel ↔ hell" onChange={(v) => setParam('tilt_gain', v)} />
          <AmKnob size="s" gold value={me.target_loudness} min={-20} max={-6} def={-10} unit="db" label="Ziel LUFS" title="Ziel-Lautheit" onChange={(v) => setParam('target_loudness', v)} />
          <AmKnob size="s" value={me.strength} min={0} max={100} def={60} unit="int" label="Stärke" title="Stärke der Kompression" onChange={(v) => setParam('strength', v)} />
          <AmKnob size="s" value={me.attack} min={0.5} max={30} def={5} unit="int" label="Attack ms" title="Attack" onChange={(v) => setParam('attack', v)} />
          <AmKnob size="s" value={me.release} min={20} max={300} def={80} unit="int" label="Release ms" title="Release" onChange={(v) => setParam('release', v)} />
          <AmKnob size="s" value={me.limiter_threshold} min={-6} max={0} def={-1} unit="db" label="Ceiling" title="Limiter-Obergrenze (True Peak)" onChange={(v) => setParam('limiter_threshold', v)} />
        </div>
      </AmCard>
      <AmCard title="Lautheit" style={{ width: 230 }}>
        <div className="am-loud">
          <div className="am-big">{hasLufs ? lufs.toFixed(1) : '–'}<small> LUFS</small></div>
          <div className="am-loudbar" aria-label={`Lautheit ${hasLufs ? lufs.toFixed(1) : 'keine Messung'}, Ziel ${me.target_loudness}`}>
            <i style={{ width: hasLufs ? pos(lufs) : '0%' }} />
            <b style={{ left: pos(me.target_loudness) }} title={`Ziel ${me.target_loudness} LUFS`} />
          </div>
          <span className="am-hint">Ziel {me.target_loudness.toFixed(1)} LUFS · Ceiling {me.limiter_threshold.toFixed(1)} dB</span>
        </div>
      </AmCard>
      <AmCard title="Klangbild · 12 Bänder" style={{ flex: 1.2, minWidth: 380 }}>
        <div className="am-bands">
          {tone.bands.map((b, i) => (
            <AmKnob key={i} size="xs" gold value={b.gain} min={-12} max={12} def={0} unit="db" label={fmtHz(b.freq)} title={`Band ${fmtHz(b.freq)} Hz`} onChange={(v) => setBand(i, v)} />
          ))}
        </div>
      </AmCard>
    </div>
  );
});
