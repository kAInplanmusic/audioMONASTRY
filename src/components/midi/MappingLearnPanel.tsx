import React, { useEffect, useRef } from 'react';
import { Zap, Trash2, Radio } from 'lucide-react';
import type { ControlEvent } from '../../core/interfaces';
import { useMapping } from '../../hooks/useMapping';
import type { MappingKind } from '../../core/mapping/MappingEngine';

const MAPPING_KINDS: { id: MappingKind; label: string }[] = [
  { id: 'absolute', label: 'ABS' },
  { id: 'relative', label: 'REL' },
  { id: 'toggle', label: 'TOG' },
  { id: 'momentary', label: 'MOM' },
];

/**
 * MappingLearnPanel – transportagnostisches Mapping-UI (Learn-Modus).
 *
 * `lastEvent` wird von der jeweiligen Quelle geliefert (MIDI/HID/OSC).
 * Im Learn-Modus wird das nächste eingehende ControlEvent als Regel auf den
 * gewählten App-Parameter gemappt und persistiert.
 */
export const MappingLearnPanel: React.FC<{ lastEvent: ControlEvent | null }> = ({ lastEvent }) => {
  const {
    rules, learning, setLearning, target, setTarget, kind, setKind,
    addFrom, remove, lastLearned, error,
  } = useMapping();

  const lastEventRef = useRef(lastEvent);
  lastEventRef.current = lastEvent;

  useEffect(() => {
    if (!learning) return;
    if (!lastEvent || lastEvent === lastLearned) return;
    void addFrom(lastEvent).then(() => setLearning(false));
  }, [learning, lastEvent, lastLearned, addFrom, setLearning]);

  return (
    <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 text-[10px] font-mono">
      <div className="flex items-center justify-between mb-2">
        <span className="font-bold tracking-widest text-purple-300">MAPPING · LEARN</span>
        <button
          type="button"
          aria-pressed={learning}
          onClick={() => setLearning((v) => !v)}
          className={`px-2 py-1 rounded border text-[9px] font-bold tracking-widest ${
            learning ? 'bg-purple-900/40 border-purple-400 text-purple-200 animate-pulse' : 'border-purple-500/40 text-purple-300 hover:bg-purple-500/10'
          }`}
        >
          <Radio className="w-3 h-3 inline mr-1" />
          {learning ? 'WARTE AUF EVENT…' : 'LEARN'}
        </button>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2 mb-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="Mapping-Ziel"
          placeholder="z. B. mixer.channel1.volume"
          className="bg-black/60 border border-neutral-700 rounded px-2 py-1 text-neutral-200"
        />
        <div className="flex gap-1">
          {MAPPING_KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={`px-1.5 py-1 rounded border text-[8px] font-bold ${
                kind === k.id ? 'bg-purple-900/40 border-purple-400 text-purple-200' : 'border-neutral-700 text-neutral-500 hover:text-purple-300'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {lastLearned && (
        <div className="text-[9px] text-purple-300/80 mb-2">
          Zuletzt gelernt: {lastLearned.sourceProtocol}:{lastLearned.parameter} → {target}
        </div>
      )}

      {error && <div className="text-[9px] text-red-400 mb-2">{error}</div>}

      <div className="space-y-1 max-h-32 overflow-y-auto">
        {rules.length === 0 ? (
          <div className="text-neutral-600">Keine Mappings gespeichert.</div>
        ) : rules.map((rule) => (
          <div key={rule.id} className="flex items-center gap-2 bg-black/40 rounded px-2 py-1">
            <Zap className="w-3 h-3 text-purple-400 shrink-0" />
            <span className="truncate text-neutral-300">{rule.name ?? `${rule.sourceProtocol}:${rule.parameter}`}</span>
            <span className="ml-auto text-neutral-500">{rule.kind}</span>
            <button
              type="button"
              aria-label={`Mapping ${rule.name ?? rule.id} löschen`}
              onClick={() => void remove(rule.id)}
              className="text-neutral-600 hover:text-red-400"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
