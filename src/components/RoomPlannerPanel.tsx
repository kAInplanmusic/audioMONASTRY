import { useMemo, useState } from 'react';
import { Ruler, Speaker, Check } from 'lucide-react';
import {
  planAllSetups, assignXonarDevices, requiredXonarDevices, XONAR_U7_CHANNEL_NAMES,
} from '../core/spatial/roomPlanner';
import type { RoomPlan } from '../core/spatial/roomPlanner';
import { audioEngine } from '../utils/audioEngine';

/**
 * RoomPlannerPanel – Raummaße → Aufstellplan für 12.x/18.x/24.x
 * ==============================================================
 * Zeigt Kanalnummer, Aufstellwinkel, Position (x/y) und Abstand für alle
 * drei Zielfamilien und übernimmt das gewählte Setup ins Audiosystem.
 */
export function RoomPlannerPanel({ onClose }: { onClose?: () => void }) {
  const [lengthM, setLengthM] = useState(6);
  const [widthM, setWidthM] = useState(5);
  const [lfe, setLfe] = useState<0 | 1 | 2>(0);
  const [applied, setApplied] = useState<string | null>(null);

  const plans = useMemo(
    () => planAllSetups({ lengthM, widthM }),
    [lengthM, widthM],
  );

  const selected = plans.filter((p) => p.lfe === lfe);

  const apply = (plan: RoomPlan) => {
    audioEngine.setSpatialSetup(plan.setupId);
    setApplied(plan.setupId);
  };

  return (
    <div
      role="button"
      tabIndex={-1}
      className="absolute inset-0 z-40 bg-black/80 flex items-center justify-center p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="w-full max-w-6xl max-h-full bg-neutral-900 border border-lime-900/40 rounded-2xl p-6 shadow-2xl overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-black tracking-widest text-neutral-100 uppercase flex items-center gap-2">
            <Ruler className="w-5 h-5 text-lime-400" /> Raumplan 12.x / 18.x / 24.x
          </h2>
          {onClose && <button type="button" onClick={onClose} className="text-neutral-500 hover:text-white">✕</button>}
        </div>

        {/* Raummaße */}
        <div className="grid grid-cols-3 gap-4 mb-4">
          <label className="text-xs font-bold text-neutral-400 uppercase">
            Raumlänge (m)
            <input
              type="number" min={3} max={60} step={0.5} value={lengthM}
              onChange={(e) => setLengthM(Number.parseFloat(e.target.value) || 6)}
              className="w-full mt-1 bg-black border border-neutral-700 rounded p-2 text-sm text-white"
            />
          </label>
          <label className="text-xs font-bold text-neutral-400 uppercase">
            Raumbreite (m)
            <input
              type="number" min={3} max={60} step={0.5} value={widthM}
              onChange={(e) => setWidthM(Number.parseFloat(e.target.value) || 5)}
              className="w-full mt-1 bg-black border border-neutral-700 rounded p-2 text-sm text-white"
            />
          </label>
          <label className="text-xs font-bold text-neutral-400 uppercase">
            LFE-Kanäle
            <select
              value={lfe}
              onChange={(e) => setLfe(Number(e.target.value) as 0 | 1 | 2)}
              className="w-full mt-1 bg-black border border-neutral-700 rounded p-2 text-sm text-white"
            >
              <option value={0}>.0 (ohne LFE)</option>
              <option value={1}>.1 (1× LFE)</option>
              <option value={2}>.2 (2× LFE)</option>
            </select>
          </label>
        </div>

        {/* Drei Familien-Spalten */}
        <div className="grid grid-cols-3 gap-4">
          {selected.map((plan) => {
            const withXonar = assignXonarDevices(plan);
            const u7 = requiredXonarDevices(plan);
            return (
              <div key={plan.setupId} className="bg-[#111] border border-neutral-800 rounded-xl p-3 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-black text-lime-400 font-mono">{plan.setupId}</span>
                  <span className="text-[10px] font-mono text-neutral-500">{plan.totalChannels} Kanäle · {u7}× Xonar U7</span>
                </div>
                <div className="flex-1 max-h-64 overflow-y-auto mb-2">
                  <table className="w-full text-[10px] font-mono">
                    <thead className="text-neutral-500 sticky top-0 bg-[#111]">
                      <tr>
                        <th className="text-left">#</th>
                        <th className="text-left">Winkel</th>
                        <th className="text-left">x/y (m)</th>
                        <th className="text-left">Abst.</th>
                        <th className="text-left">U7</th>
                      </tr>
                    </thead>
                    <tbody>
                      {withXonar.map((sp) => (
                        <tr key={sp.channel} className={sp.kind === 'lfe' ? 'text-amber-400' : 'text-neutral-300'}>
                          <td>{sp.name}</td>
                          <td>{sp.angleDeg}°</td>
                          <td>{sp.x} / {sp.y}</td>
                          <td>{sp.distanceM}m</td>
                          <td>
                            {sp.xonar
                              ? `D${sp.xonar.deviceIndex + 1}.${XONAR_U7_CHANNEL_NAMES[sp.xonar.deviceChannel]}`
                              : '–'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button type="button"
                  onClick={() => apply(plan)}
                  className={`w-full py-2 rounded text-xs font-black tracking-widest flex items-center justify-center gap-2 ${
                    applied === plan.setupId
                      ? 'bg-lime-600 text-white'
                      : 'bg-lime-900/30 border border-lime-600/50 text-lime-300 hover:bg-lime-800/40'
                  }`}
                >
                  {applied === plan.setupId ? <Check className="w-4 h-4" /> : <Speaker className="w-4 h-4" />}
                  {applied === plan.setupId ? 'AKTIV' : 'INS AUDIOSYSTEM ÜBERNEHMEN'}
                </button>
              </div>
            );
          })}
        </div>

        <p className="text-[10px] text-neutral-600 mt-3 leading-relaxed">
          Aufstellwinkel: 0° = vorne, im Uhrzeigersinn. Positionen relativ zum Hörplatz (Mitte).
          Xonar U7: 8 Kanäle/Gerät (FL/FR/C/LFE/RL/RR/SL/SR) – 12.x = 2 Geräte, 18.x = 3 Geräte, 24.x = 3–4 Geräte
          (Mehrgeräte-Aggregation auf OS-Ebene: Windows „Lautsprecher gruppieren“/ASIO4ALL, Linux PipeWire Combine-Sink).
        </p>
      </div>
    </div>
  );
}
